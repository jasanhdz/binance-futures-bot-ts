// src/backtest/statefulEngine.ts
import { Strategy } from '../strategies/types';
import { OfflineExchange } from './offlineExchange';
import { BotState, Candle, Trade } from '../core/types';
import { hourOfDay, mfeMaeFromPath, std } from './utils';
import { volumeAvg } from '../core/utils/candles';
import { adx as adxCalc } from '../core/indicators/adx';
import { evaluateML } from '../ml/engine';
import { CONFIG } from '../infra/config';

type StatefulBTConfig = {
  symbol: string;
  interval: string;
  slPct: number;
  tpPct: number;
  feePct: number;
  leverage: number;
  maxBars: number;
  warmup: number;
  entryAt: 'close' | 'nextOpen';
  antiLossThr?: number; // 0.7 por defecto
  allowReverse?: boolean;
};

type StatefulTrade = Trade & { stateSnapshot: BotState };

export async function statefulBacktest(
  strategy: Strategy,
  candles: Candle[],
  cfg: StatefulBTConfig,
) {
  const ex = new OfflineExchange(candles, cfg.symbol, cfg.interval);
  const trades: StatefulTrade[] = [];
  let state: BotState = {
    mode: 'IDLE',
    lastSide: undefined,
    lastEntryPrice: undefined,
    lastLeverage: undefined,
    lastEntryAt: undefined,
    lastExitAt: undefined,
    lastExitReason: undefined,
    lastTPAt: undefined,
  };

  let open: null | {
    side: 'LONG' | 'SHORT';
    entryIdx: number;
    entryTs: number;
    entryPx: number;
    sl: number;
    tp: number;
    maxUntilIdx: number;
    stateSnapshot: BotState;
  } = null;

  for (let i = Math.max(cfg.warmup, 50); i < candles.length - 1; i++) {
    ex.setIndex(i);
    const nowTs = candles[i].closeTime;

    // 1. Evalúa estrategia con estado actual
    const sig = await strategy.evaluate({
      symbol: cfg.symbol,
      exchange: ex as any,
      config: CONFIG,
      state,
      now: nowTs,
    });

    // 2. Si NO hay posición
    if (!open) {
      if (sig.action !== 'ENTER_LONG' && sig.action !== 'ENTER_SHORT') continue;
      if (state.mode !== 'IDLE') continue; // solo una posición a la vez

      const c0 = candles[i];
      const c1 = candles[i + 1];
      const entryPx = cfg.entryAt === 'nextOpen' ? c1.open : c0.close;
      const entryTs = cfg.entryAt === 'nextOpen' ? c1.closeTime : c0.closeTime;
      const side = sig.action === 'ENTER_LONG' ? 'LONG' : 'SHORT';

      const sl = side === 'LONG' ? entryPx * (1 - cfg.slPct) : entryPx * (1 + cfg.slPct);
      const tp = side === 'LONG' ? entryPx * (1 + cfg.tpPct) : entryPx * (1 - cfg.tpPct);

      open = {
        side,
        entryIdx: i,
        entryTs,
        entryPx,
        sl,
        tp,
        maxUntilIdx: Math.min(i + cfg.maxBars, candles.length - 1),
        stateSnapshot: { ...state },
      };

      state.mode = side === 'LONG' ? 'LONG_RIDE' : 'SHORT_RIDE';
      state.lastSide = side;
      state.lastEntryPrice = entryPx;
      state.lastLeverage = cfg.leverage;
      state.lastEntryAt = entryTs;
      continue;
    }

    // 3. Con posición abierta → evalúa SL/TP/Timeout/Exit
    const bar = candles[i];
    let hit: 'SL' | 'TP' | null = null;
    if (open.side === 'LONG') {
      if (bar.low <= open.sl) hit = 'SL';
      else if (bar.high >= open.tp) hit = 'TP';
    } else {
      if (bar.high >= open.sl) hit = 'SL';
      else if (bar.low <= open.tp) hit = 'TP';
    }

    const strategyExit = sig.action === 'EXIT';
    const timeout = i >= open.maxUntilIdx;

    if (hit || strategyExit || timeout) {
      const exitKind: Trade['exit'] =
        (hit as any) ?? (strategyExit ? 'StrategyExit' : timeout ? 'Timeout' : 'Timeout');

      let exitPx: number;
      if (hit === 'SL') exitPx = open.sl;
      else if (hit === 'TP') exitPx = open.tp;
      else exitPx = bar.close;

      const exitIdx = i;
      const exitTs = candles[exitIdx].closeTime;

      // features al entrar
      const win = candles.slice(0, open.entryIdx + 1);
      const vavg = volumeAvg(win, Math.max(20, CONFIG.VOL_AVG_LEN));
      const vRatio = vavg > 0 ? candles[open.entryIdx].volume / vavg : 0;
      const highs = win.map((x) => x.high);
      const lows = win.map((x) => x.low);
      const closes = win.map((x) => x.close);
      const { adx } = adxCalc(highs, lows, closes, Number(CONFIG.ADX_LEN ?? 14));
      const { longP, shortP } = evaluateML(win);
      const mlMargin = Math.abs(longP - shortP);

      const bbLen = 20,
        bbK = 2;
      const mean20 =
        closes.slice(-bbLen).reduce((s, v) => s + v, 0) /
        Math.max(1, Math.min(closes.length, bbLen));
      const sd20 = std(closes, bbLen);
      const upper =
        Number.isFinite(mean20) && Number.isFinite(sd20) ? mean20 + bbK * sd20 : undefined;
      const lower =
        Number.isFinite(mean20) && Number.isFinite(sd20) ? mean20 - bbK * sd20 : undefined;
      const distTopPct = upper ? (upper - open.entryPx) / upper : undefined;

      const path = candles.slice(open.entryIdx + 1, exitIdx + 1);
      const { mfePct, maePct } = mfeMaeFromPath(open.side, open.entryPx, path);

      const grossRet =
        open.side === 'LONG'
          ? (exitPx - open.entryPx) / open.entryPx
          : (open.entryPx - exitPx) / open.entryPx;
      const fees = cfg.feePct * 2;
      const pnlPct = grossRet - fees;

      trades.push({
        side: open.side,
        entryIdx: open.entryIdx,
        entryTs: open.entryTs,
        entryPx: open.entryPx,
        exitIdx,
        exitTs,
        exitPx,
        exit: exitKind,
        barsHeld: exitIdx - open.entryIdx,
        pnlPct,
        mfePct,
        maePct,
        reason: strategyExit ? (sig.reason ?? 'strategy_exit') : undefined,
        adx: Number(adx) || 0,
        longP,
        shortP,
        mlMargin,
        vRatio,
        bbUpper: upper,
        bbLower: lower,
        distTopPct,
        stateSnapshot: open.stateSnapshot,
      });

      // actualiza estado
      state.mode = 'IDLE';
      state.lastExitReason =
        exitKind === 'TP'
          ? 'tp'
          : exitKind === 'SL'
            ? 'sl'
            : exitKind === 'StrategyExit'
              ? 'exit'
              : 'timeout';
      state.lastTPAt = exitKind === 'TP' ? exitTs : undefined;
      state.lastExitAt = exitTs;
      state.lastEntryPrice = undefined;
      state.lastEntryAt = undefined;

      open = null;
      continue;
    }
  }

  // ===== Resumen =====
  const wins = trades.filter((t) => t.pnlPct > 0);
  const losses = trades.filter((t) => t.pnlPct <= 0);
  const total = trades.length;
  const winrate = total ? wins.length / total : 0;
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length : 0;
  const pf =
    avgLoss !== 0
      ? wins.reduce((s, t) => s + t.pnlPct, 0) / Math.abs(losses.reduce((s, t) => s + t.pnlPct, 0))
      : Infinity;
  const eq = trades.reduce((arr, t) => {
    arr.push((arr[arr.length - 1] ?? 0) + t.pnlPct);
    return arr;
  }, [] as number[]);
  const maxDD = eq.length
    ? Math.max(...eq.map((_, i) => Math.max(...eq.slice(0, i + 1)) - eq[i]))
    : 0;

  const byHour = new Map<number, { n: number; wins: number; pnl: number }>();
  for (const t of trades) {
    const h = hourOfDay(t.entryTs);
    const ref = byHour.get(h) ?? { n: 0, wins: 0, pnl: 0 };
    ref.n++;
    ref.wins += t.pnlPct > 0 ? 1 : 0;
    ref.pnl += t.pnlPct;
    byHour.set(h, ref);
  }

  return {
    trades,
    summary: {
      total,
      winrate,
      avgWin,
      avgLoss,
      pf,
      totalPnl: trades.reduce((s, t) => s + t.pnlPct, 0),
      maxDD,
      byHour: Array.from(byHour.entries()).map(([h, v]) => ({
        hour: h,
        ...v,
        winrate: v.n ? v.wins / v.n : 0,
      })),
    },
  };
}
