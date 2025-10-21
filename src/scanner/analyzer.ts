// src/scanner/analyzer.ts
import { Exchange } from '../core/ports/Exchange';
import { Candle } from '../core/types';
import { StrategyContext } from '../strategies/types';
import {
  analyzeMomentumBreakout,
  MomentumAnalysis,
  MomentumDirectionState,
  MOMENTUM_TIMEFRAME,
} from '../strategies/momentum_breakout';
import {
  analyzeBreakRetest,
  BreakRetestAnalysis,
  BreakRetestState,
} from '../strategies/break_retest';
import {
  analyzeSnapback,
  SnapAnalysis,
  SnapState,
  SnapParams,
} from '../strategies/mean_reversion_snapback';

export type StrategyKey = 'momentum' | 'break_retest' | 'snapback';

export interface StrategyCandidate {
  strategy: StrategyKey;
  side: 'LONG' | 'SHORT';
  score: number;
  ready: boolean;
  detail: string;
}

export interface SymbolScanResult {
  symbol: string;
  best: StrategyCandidate | null;
  candidates: StrategyCandidate[];
  analyses: {
    momentum?: MomentumAnalysis;
    breakRetest?: BreakRetestAnalysis;
    snap?: SnapAnalysis;
  };
  extras: {
    lastClose: number;
    shortSma: number;
    longSma: number;
    trendStrengthPct: number;
  };
}

export interface ScanOptions {
  exchange?: Pick<Exchange, 'getCandles'>;
  candlesFetcher?: (symbol: string, interval: string, limit: number) => Promise<Candle[]>;
  symbols: string[];
  config: StrategyContext['config'];
  sideFilter?: 'LONG' | 'SHORT' | 'BOTH';
  minScore?: number;
  limit?: number;
  logger?: { warn(msg: string, ctx?: any): void; debug(msg: string, ctx?: any): void };
}

function momentumScore(analysis: MomentumAnalysis, state: MomentumDirectionState): number {
  if (!Number.isFinite(state.triggerPrice) || !Number.isFinite(state.baseLevel)) return 0;
  let score = 0;

  const streakRatio =
    analysis.params.streakMin > 0 ? Math.min(1, state.streak / analysis.params.streakMin) : 0;
  score += streakRatio * 25;

  const volRatio =
    analysis.params.volFactor > 0
      ? Math.min(state.weakestVolRatio / analysis.params.volFactor, 1)
      : 0;
  score += volRatio * 20;

  if (state.trendOk) score += 25;
  if (state.breakoutOk) score += 10;

  const dist = state.priceToTriggerPct;
  if (Number.isFinite(dist)) {
    const window = 0.003;
    const closeness = Math.max(0, (window - Math.max(0, dist)) / window);
    score += closeness * 20;
  }

  if (state.ready) score += 20;
  return Math.min(100, score);
}

function breakRetestScore(state: BreakRetestState): number {
  let score = 0;
  if (state.trendNow.bull || state.trendNow.bear) score += 15;
  if (state.trendConfirm.bull || state.trendConfirm.bear) score += 15;
  if (state.breakoutOk) score += 20;
  if (state.retestOk) score += 20;
  if (state.volumeOk) score += 10;
  if (state.roomOk) score += 10;
  if (state.ready) score += 20;
  return Math.min(100, score);
}

function snapScore(state: SnapState, params: SnapParams): number {
  let score = 0;
  const ext = Math.abs(state.extension);
  const extRatio = params.emaExtension > 0 ? Math.min(1, ext / params.emaExtension) : 0;
  score += extRatio * 20;
  if (state.trendNow.bull || state.trendNow.bear) score += 8;
  if (state.trendConfirm.bull || state.trendConfirm.bear) score += 8;
  if (state.volumeOk) score += 4;
  if (state.levelsOk) score += 4;
  if (state.structureOk) score += 14;
  if (state.reversalOk) score += 14;
  if (state.dailyOk) score += 4;
  if (state.streak >= params.streakMin) score += 6;

  const rsiFactor =
    state.direction === 'LONG'
      ? Math.min(1, (params.rsiLow - state.rsi) / Math.max(1, params.rsiLow - 15))
      : Math.min(1, (state.rsi - params.rsiHigh) / Math.max(1, 85 - params.rsiHigh));
  if (Number.isFinite(rsiFactor) && rsiFactor > 0) {
    score += Math.min(1, Math.max(0, rsiFactor)) * 12;
  }
  if (state.ready) score += 6;
  return Math.min(100, score);
}

export async function scanSymbols(options: ScanOptions): Promise<SymbolScanResult[]> {
  const {
    exchange,
    candlesFetcher,
    symbols,
    config,
    sideFilter = 'BOTH',
    minScore = 20,
    limit = symbols.length,
    logger,
  } = options;

  const results: SymbolScanResult[] = [];

  const getCandles = async (symbol: string, interval: string, count: number) => {
    if (candlesFetcher) return candlesFetcher(symbol, interval, count);
    if (exchange) return exchange.getCandles(symbol, interval, count);
    throw new Error('scanSymbols requires an exchange or candlesFetcher');
  };

  for (const symbol of symbols) {
    try {
      const momentumCandles = await getCandles(symbol, MOMENTUM_TIMEFRAME, 320);
      if (momentumCandles.length < 80) {
        logger?.warn?.('scan_skip_insufficient_candles', { symbol, candles: momentumCandles.length });
        continue;
      }
      const confirmTf = (config as any).MOM_TREND_CONFIRM_TF ?? '15m';
      const momentumConfirmCandles =
        confirmTf === MOMENTUM_TIMEFRAME
          ? momentumCandles
          : await getCandles(symbol, confirmTf, 320);

      const momentumAnalysis = analyzeMomentumBreakout({
        candles: momentumCandles,
        confirmCandles: momentumConfirmCandles,
        config,
        confirmTf,
      });

      const entryTf = config.ENTRY_TIMEFRAME;
      const entryCandles =
        entryTf === MOMENTUM_TIMEFRAME ? momentumCandles : await getCandles(symbol, entryTf, 320);

      const breakConfirmTf = ((config as any).BR_CONFIRM_TF ?? '15m') as '3m' | '5m' | '15m' | '1h';
      const breakConfirmCandles =
        breakConfirmTf === entryTf
          ? entryCandles
          : await getCandles(symbol, breakConfirmTf, 240);
      const breakAnalysis = analyzeBreakRetest({
        candles: entryCandles,
        confirmCandles: breakConfirmCandles,
        config,
      });

      const snapConfirmTf = ((config as any).MRS_CONFIRM_TF ?? '15m') as '3m' | '5m' | '15m' | '1h';
      const snapConfirmCandles =
        snapConfirmTf === entryTf
          ? entryCandles
          : await getCandles(symbol, snapConfirmTf, 240);
      const snapHigherTf = ((config as any).MRS_HTF_TF ?? '1h') as '1h' | '4h';
      const snapHigherLimit = snapHigherTf === '4h' ? 160 : 320;
      const snapHigherCandles =
        snapHigherTf === entryTf
          ? entryCandles
          : await getCandles(symbol, snapHigherTf, snapHigherLimit);
      const snapDailyCandles = await getCandles(symbol, '1d', 3);
      const snapAnalysis = analyzeSnapback({
        candles: entryCandles,
        confirmCandles: snapConfirmCandles,
        config,
        htfCandles: snapHigherCandles,
        dailyCandles: snapDailyCandles,
      });

      const lastClose = entryCandles[entryCandles.length - 1]?.close ?? NaN;
      const shortSma = sma(entryCandles, 7);
      const longSma = sma(entryCandles, 25);
      const trendStrengthPct = computeTrendStrengthPct(momentumAnalysis);

      const candidates: StrategyCandidate[] = [
        momentumAnalysis.long,
        momentumAnalysis.short,
      ].map((state) => ({
        strategy: 'momentum' as const,
        side: state.direction,
        score: momentumScore(momentumAnalysis, state),
        ready: state.ready,
        detail: `streak=${state.streak} volx=${state.weakestVolRatio.toFixed(2)} room=${
          Number.isFinite(state.priceToTriggerPct)
            ? (state.priceToTriggerPct * 100).toFixed(2)
            : 'n/a'
        }%`,
      }));

      candidates.push(
        ...[breakAnalysis.long, breakAnalysis.short].map((state) => ({
          strategy: 'break_retest' as const,
          side: state.direction,
          score: breakRetestScore(state),
          ready: state.ready,
          detail: `level=${
            Number.isFinite(state.breakoutLevel) ? state.breakoutLevel.toFixed(4) : 'n/a'
          } room=${Number.isFinite(state.roomPct) ? (state.roomPct * 100).toFixed(2) : 'n/a'}%`,
        })),
      );

      candidates.push(
        ...[snapAnalysis.long, snapAnalysis.short].map((state) => ({
          strategy: 'snapback' as const,
          side: state.direction,
          score: snapScore(state, snapAnalysis.params),
          ready: state.ready,
          detail: `ext=${(state.extension * 100).toFixed(2)}% rsi=${state.rsi.toFixed(1)}`,
        })),
      );

      const filtered = sideFilter === 'BOTH' ? candidates : candidates.filter((c) => c.side === sideFilter);
      const best = filtered.reduce<StrategyCandidate | null>((acc, cand) => {
        if (cand.score < minScore) return acc;
        if (!acc || cand.score > acc.score) return cand;
        return acc;
      }, null);

      results.push({
        symbol,
        best,
        candidates,
        analyses: {
          momentum: momentumAnalysis,
          breakRetest: breakAnalysis,
          snap: snapAnalysis,
        },
        extras: {
          lastClose,
          shortSma,
          longSma,
          trendStrengthPct,
        },
      });
    } catch (err) {
      logger?.warn?.('scan_symbol_error', { symbol, err: (err as any)?.message || String(err) });
    }
  }

  const sorted = results
    .filter((r) => !!r.best)
    .sort((a, b) => (b.best?.score ?? 0) - (a.best?.score ?? 0))
    .slice(0, limit);

  return sorted;
}

function sma(candles: Candle[], length: number): number {
  if (candles.length < length) {
    const closes = candles.map((c) => c.close);
    const sum = closes.reduce((acc, v) => acc + v, 0);
    return closes.length ? sum / closes.length : NaN;
  }
  const closes = candles.slice(-length).map((c) => c.close);
  const sum = closes.reduce((acc, v) => acc + v, 0);
  return sum / length;
}

function computeTrendStrengthPct(analysis: MomentumAnalysis): number {
  const fast = analysis.trendNow.emaFast;
  const slow = analysis.trendNow.emaSlow;
  if (!Number.isFinite(fast) || !Number.isFinite(slow) || slow === 0) return 0;
  return ((fast - slow) / Math.abs(slow)) * 100;
}
