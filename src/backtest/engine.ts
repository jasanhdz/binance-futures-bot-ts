import { BacktestExchange } from './exchange';
import { BacktestOptions, BacktestResult, BacktestTrade, EquityPoint } from './types';
import { SqliteHistoricalSource } from './data/sqlite_source';
import { Strategy } from '../strategies/types';
import { BotState, Candle, Side } from '../core/types';
import type { BotConfig } from '../infra/config';
import { resolveDataSymbol } from './symbols';

type EngineDeps = {
  source: SqliteHistoricalSource;
  exchange: BacktestExchange;
  strategy: Strategy;
  config: Record<string, unknown>;
  options: BacktestOptions;
};

type PendingEntry = {
  index: number;
  side: Side;
  reason?: string;
};

type PendingExit = {
  index: number;
  reason?: string;
};

type ActivePosition = {
  side: Side;
  entryIdx: number;
  entryTime: number;
  entryPrice: number;
  stop?: number;
  target?: number;
  peakPrice: number;
  troughPrice: number;
  mfePct: number;
  maePct: number;
  exitQueue?: PendingExit;
  signalReason?: string;
};

function toMs(value?: number | string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number') return value;
  const ts = Date.parse(value);
  if (!Number.isFinite(ts)) {
    throw new Error(`Unable to parse timestamp "${value}"`);
  }
  return ts;
}

function findStartIndex(candles: Candle[], startTime?: number): number {
  if (startTime === undefined) return 0;
  for (let i = 0; i < candles.length; i++) {
    if (candles[i].closeTime >= startTime) {
      return i;
    }
  }
  return candles.length - 1;
}

function findEndIndex(candles: Candle[], endTime?: number): number {
  if (endTime === undefined) return candles.length - 1;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].closeTime <= endTime) {
      return i;
    }
  }
  return candles.length - 1;
}

function pctDiff(entry: number, price: number, side: Side): number {
  if (!Number.isFinite(entry) || entry <= 0) return 0;
  const raw = (price - entry) / entry;
  return side === 'LONG' ? raw : -raw;
}

function applyFees(pnlPct: number, feePct: number): number {
  if (!feePct) return pnlPct;
  return pnlPct - feePct * 2;
}

function recordEquityPoint(curve: EquityPoint[], time: number, equity: number) {
  if (!curve.length || curve[curve.length - 1].time !== time) {
    curve.push({ time, equity });
  } else {
    curve[curve.length - 1].equity = equity;
  }
}

function buildBotState(position: ActivePosition | null): BotState {
  if (!position) {
    return { mode: 'IDLE' };
  }
  const mode = position.side === 'LONG' ? 'LONG_RIDE' : 'SHORT_RIDE';
  return {
    mode,
    lastSide: position.side,
    lastEntryPrice: position.entryPrice,
    lastEntryAt: position.entryTime,
  };
}

function summarizeTrades(trades: BacktestTrade[]): BacktestResult['summary'] {
  if (!trades.length) {
    return {
      totalTrades: 0,
      wins: 0,
      losses: 0,
      winRatePct: 0,
      avgPnlPct: 0,
      expectancyPct: 0,
      cumPnlPct: 0,
      bestPct: 0,
      worstPct: 0,
      avgWinPct: 0,
      avgLossPct: 0,
    };
  }

  let wins = 0;
  let losses = 0;
  let total = 0;
  let cumulative = 0;
  let best = -Infinity;
  let worst = Infinity;
  let winSum = 0;
  let lossSum = 0;

  for (const trade of trades) {
    total += trade.pnlPct;
    cumulative += trade.pnlPct;
    best = Math.max(best, trade.pnlPct);
    worst = Math.min(worst, trade.pnlPct);
    if (trade.pnlPct >= 0) {
      wins += 1;
      winSum += trade.pnlPct;
    } else {
      losses += 1;
      lossSum += trade.pnlPct;
    }
  }

  const avg = total / trades.length;
  const winRate = wins > 0 ? (wins / trades.length) * 100 : 0;
  const avgWin = wins > 0 ? winSum / wins : 0;
  const avgLoss = losses > 0 ? lossSum / losses : 0;
  const expectancy = avgWin * (wins / trades.length) + avgLoss * (losses / trades.length);

  return {
    totalTrades: trades.length,
    wins,
    losses,
    winRatePct: Number(winRate.toFixed(2)),
    avgPnlPct: Number(avg.toFixed(4)),
    expectancyPct: Number(expectancy.toFixed(4)),
    cumPnlPct: Number(cumulative.toFixed(4)),
    bestPct: Number(best.toFixed(4)),
    worstPct: Number(worst.toFixed(4)),
    avgWinPct: Number(avgWin.toFixed(4)),
    avgLossPct: Number(avgLoss.toFixed(4)),
  };
}

export class BacktestEngine {
  constructor(private deps: EngineDeps) {}

  async run(): Promise<BacktestResult> {
    const { options, source, exchange, strategy } = this.deps;
    const config = this.deps.config as BotConfig;
    const symbol = options.symbol;
    const dataSymbol = resolveDataSymbol(symbol, options.dataSymbol);
    const timeframe = options.timeframe;

    const candles = source.loadCandles(dataSymbol, timeframe);
    if (candles.length < 50) {
      throw new Error(`Not enough candles for ${symbol} ${timeframe}`);
    }

    const startTime = toMs(options.startTime);
    const endTime = toMs(options.endTime);
    const startIdx = Math.max(options.warmupBars ?? 400, findStartIndex(candles, startTime));
    const finalIdx = findEndIndex(candles, endTime);
    if (startIdx >= finalIdx) {
      throw new Error('Start index >= end index; adjust start/end or warmup');
    }

    const feePct = options.tradeFeePct ?? 0;
    const trades: BacktestTrade[] = [];
    const equityCurve: EquityPoint[] = [];

    let equity = 1;
    let position: ActivePosition | null = null;
    let pendingEntry: PendingEntry | null = null;
    let pendingExit: PendingExit | null = null;
    let tradeId = 1;

    for (let i = startIdx; i < finalIdx; i++) {
      const candle = candles[i];
      const nextCandle = candles[i + 1];

      // Honour queued exit at this bar open
      if (pendingExit && pendingExit.index === i && position) {
        const exitPrice = candle.open;
        const pnlPct = pctDiff(position.entryPrice, exitPrice, position.side);
        const netPct = applyFees(pnlPct, feePct);
        trades.push({
          id: tradeId++,
          side: position.side,
          entryIdx: position.entryIdx,
          entryTs: position.entryTime,
          entryPx: position.entryPrice,
          exitIdx: i,
          exitTs: candle.openTime,
          exitPx: exitPrice,
          exitReason: pendingExit.reason ? 'StrategyExit' : 'Flat',
          barsHeld: i - position.entryIdx,
          pnlPct: Number(netPct.toFixed(6)),
          mfePct: Number(position.mfePct.toFixed(6)),
          maePct: Number(position.maePct.toFixed(6)),
          signalReason: position.signalReason,
        });
        equity *= 1 + netPct;
        position = null;
        pendingExit = null;
      }

      // Honour queued entry at this bar open
      if (!position && pendingEntry && pendingEntry.index === i) {
        const stopLossPct = options.stopLossPct;
        const takeProfitPct = options.takeProfitPct;
        const trailingPct = options.trailingStopPct;
        const entryPrice = candle.open;
        const entry: ActivePosition = {
          side: pendingEntry.side,
          entryIdx: i,
          entryTime: candle.openTime,
          entryPrice,
          stop: stopLossPct
            ? pendingEntry.side === 'LONG'
              ? entryPrice * (1 - stopLossPct)
              : entryPrice * (1 + stopLossPct)
            : undefined,
          target: takeProfitPct
            ? pendingEntry.side === 'LONG'
              ? entryPrice * (1 + takeProfitPct)
              : entryPrice * (1 - takeProfitPct)
            : undefined,
          peakPrice: entryPrice,
          troughPrice: entryPrice,
          mfePct: 0,
          maePct: 0,
          exitQueue: undefined,
          signalReason: pendingEntry.reason,
        };
        if (trailingPct) {
          if (entry.side === 'LONG') {
            entry.stop = Math.max(entry.stop ?? -Infinity, entryPrice * (1 - trailingPct));
          } else {
            entry.stop = Math.min(entry.stop ?? Infinity, entryPrice * (1 + trailingPct));
          }
        }
        position = entry;
        pendingEntry = null;
      }

      if (position) {
        if (position.side === 'LONG') {
          position.peakPrice = Math.max(position.peakPrice, candle.high);
          position.troughPrice = Math.min(position.troughPrice, candle.low);
        } else {
          position.peakPrice = Math.min(position.peakPrice, candle.low);
          position.troughPrice = Math.max(position.troughPrice, candle.high);
        }

        const favorable =
          position.side === 'LONG'
            ? pctDiff(position.entryPrice, candle.high, position.side)
            : pctDiff(position.entryPrice, candle.low, position.side);
        const adverse =
          position.side === 'LONG'
            ? pctDiff(position.entryPrice, candle.low, position.side)
            : pctDiff(position.entryPrice, candle.high, position.side);
        position.mfePct = Math.max(position.mfePct, favorable);
        position.maePct = Math.min(position.maePct, adverse);

        const trailingPct = options.trailingStopPct;
        if (trailingPct) {
          if (position.side === 'LONG') {
            const dynamicStop = position.peakPrice * (1 - trailingPct);
            if (!position.stop || dynamicStop > position.stop) {
              position.stop = dynamicStop;
            }
          } else {
            const dynamicStop = position.peakPrice * (1 + trailingPct);
            if (!position.stop || dynamicStop < position.stop) {
              position.stop = dynamicStop;
            }
          }
        }

        let exitTriggered = false;
        let exitPrice = position.entryPrice;
        let exitReason: BacktestTrade['exitReason'] = 'StrategyExit';

        if (position.stop !== undefined) {
          if (position.side === 'LONG' && candle.low <= position.stop) {
            exitTriggered = true;
            exitPrice = position.stop;
            exitReason = 'SL';
          } else if (position.side === 'SHORT' && candle.high >= position.stop) {
            exitTriggered = true;
            exitPrice = position.stop;
            exitReason = 'SL';
          }
        }

        if (!exitTriggered && position.target !== undefined) {
          if (position.side === 'LONG' && candle.high >= position.target) {
            exitTriggered = true;
            exitPrice = position.target;
            exitReason = 'TP';
          } else if (position.side === 'SHORT' && candle.low <= position.target) {
            exitTriggered = true;
            exitPrice = position.target;
            exitReason = 'TP';
          }
        }

        const maxHold = options.maxHoldBars;
        if (!exitTriggered && maxHold !== undefined && i - position.entryIdx >= maxHold) {
          exitTriggered = true;
          exitPrice = candle.close;
          exitReason = 'Timeout';
        }

        if (exitTriggered) {
          const pnlPct = pctDiff(position.entryPrice, exitPrice, position.side);
          const netPct = applyFees(pnlPct, feePct);
          trades.push({
            id: tradeId++,
            side: position.side,
            entryIdx: position.entryIdx,
            entryTs: position.entryTime,
            entryPx: position.entryPrice,
            exitIdx: i,
            exitTs: candle.closeTime,
            exitPx: exitPrice,
            exitReason,
            barsHeld: i - position.entryIdx + 1,
            pnlPct: Number(netPct.toFixed(6)),
            mfePct: Number(position.mfePct.toFixed(6)),
            maePct: Number(position.maePct.toFixed(6)),
            signalReason: position.signalReason,
          });
          equity *= 1 + netPct;
          position = null;
          pendingEntry = null;
          pendingExit = null;
        }
      }

      const unrealized =
        position !== null
          ? pctDiff(position.entryPrice, candle.close, position.side)
          : 0;
      recordEquityPoint(equityCurve, candle.closeTime, equity * (1 + unrealized));

      exchange.setCursor(candle.closeTime);
      const botState: BotState = buildBotState(position);
      const signal = await strategy.evaluate({
        symbol,
        exchange,
        config,
        state: botState,
        now: candle.closeTime,
      });

      if (signal.action === 'ENTER_LONG' || signal.action === 'ENTER_SHORT') {
        if (i + 1 >= finalIdx) {
          continue;
        }
        const desiredSide: Side = signal.action === 'ENTER_LONG' ? 'LONG' : 'SHORT';
        if (position && position.side !== desiredSide) {
          pendingExit = { index: i + 1, reason: 'reverse' };
          pendingEntry = { index: i + 1, side: desiredSide, reason: signal.reason };
        } else if (!position) {
          pendingEntry = { index: i + 1, side: desiredSide, reason: signal.reason };
        }
      } else if (signal.action === 'EXIT' && position) {
        if (i + 1 >= finalIdx) continue;
        pendingExit = { index: i + 1, reason: signal.reason };
      }
    }

    // Close lingering position at final candle close
    const finalCandle = candles[finalIdx];
    if (position) {
      const pnlPct = pctDiff(position.entryPrice, finalCandle.close, position.side);
      const netPct = applyFees(pnlPct, feePct);
      trades.push({
        id: tradeId++,
        side: position.side,
        entryIdx: position.entryIdx,
        entryTs: position.entryTime,
        entryPx: position.entryPrice,
        exitIdx: finalIdx,
        exitTs: finalCandle.closeTime,
        exitPx: finalCandle.close,
        exitReason: 'Flat',
        barsHeld: finalIdx - position.entryIdx + 1,
        pnlPct: Number(netPct.toFixed(6)),
        mfePct: Number(position.mfePct.toFixed(6)),
        maePct: Number(position.maePct.toFixed(6)),
        signalReason: position.signalReason,
      });
      equity *= 1 + netPct;
      position = null;
    }

    recordEquityPoint(equityCurve, finalCandle.closeTime, equity);

    const summary = summarizeTrades(trades);
    return {
      trades,
      equityCurve,
      summary,
    };
  }
}
