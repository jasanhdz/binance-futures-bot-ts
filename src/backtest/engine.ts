// src/backtest/engine.ts
import { Strategy } from '../strategies/types';
import { OfflineExchange } from './offlineExchange';
import { Candle } from '../core/types';
import { hourOfDay, std } from './utils';
import { volumeAvg } from '../core/utils/candles';
import { adx as adxCalc } from '../core/indicators/adx';
import { evaluateML } from '../ml/engine';
import { CONFIG } from '../infra/config';

type BTConfig = {
  symbol: string;
  interval: string;
  slPct: number; // p.ej. 0.005
  tpPct: number; // p.ej. 0.010
  feePct: number; // por lado estimado (0.0006)
  leverage: number; // informativo
  maxBars: number; // horizonte de evaluación (ej. 12 velas = 1h en 5m)
  warmup: number; // velas iniciales para que la estrategia tenga contexto
  entryAt: 'close' | 'nextOpen';
};

export type Trade = {
  side: 'LONG' | 'SHORT';
  entryIdx: number;
  entryTs: number;
  entryPx: number;
  exitIdx: number;
  exitTs: number;
  exitPx: number;
  exit: 'TP' | 'SL' | 'Timeout';
  barsHeld: number;
  pnlPct: number; // neto tras fees ida+vuelta
  mfePct: number; // max favorable
  maePct: number; // max adverso
  reason?: string;

  // Diagnóstico de features al entrar:
  adx: number;
  longP: number;
  shortP: number;
  mlMargin: number;
  vRatio: number; // volumen relativo entry / vavg20
  bbUpper?: number;
  bbLower?: number;
  distTopPct?: number;
};

function mfeMaeFromPath(side: 'LONG' | 'SHORT', entry: number, path: Candle[]) {
  let maxFav = 0,
    maxAdv = 0;
  for (const c of path) {
    const up = (c.high - entry) / entry;
    const dn = (entry - c.low) / entry;
    const fav = side === 'LONG' ? up : dn;
    const adv = side === 'LONG' ? dn : up;
    if (fav > maxFav) maxFav = fav;
    if (adv > maxAdv) maxAdv = adv;
  }
  return { mfePct: maxFav, maePct: maxAdv };
}

export async function backtestStrategy(strategy: Strategy, candles: Candle[], cfg: BTConfig) {
  const ex = new OfflineExchange(candles, cfg.symbol, cfg.interval);
  const state = {
    mode: 'IDLE' as const,
    lastExitReason: undefined as undefined | string,
    lastTPAt: undefined as number | undefined,
  };
  const trades: Trade[] = [];
  let inTrade = false;
  let lastExitAtIdx = -1;

  for (let i = Math.max(cfg.warmup, 50); i < candles.length - 2; i++) {
    if (inTrade) continue; // 1 trade a la vez (comportamiento sencillo)
    ex.setIndex(i);

    const nowTs = candles[i].closeTime;

    // Llama a la estrategia real
    const sig = await strategy.evaluate({
      symbol: cfg.symbol,
      exchange: ex as any,
      config: CONFIG, // usa tu CONFIG actual
      state: {
        mode: 'IDLE',
        lastExitReason: state.lastExitReason,
        lastTPAt: state.lastTPAt,
      } as any,
      now: nowTs,
    });

    if (sig.action !== 'ENTER_LONG' && sig.action !== 'ENTER_SHORT') continue;

    // ==== precios de entrada ====
    const c0 = candles[i];
    const c1 = candles[i + 1];
    const entryPx = cfg.entryAt === 'nextOpen' ? c1.open : c0.close;
    const side = sig.action === 'ENTER_LONG' ? 'LONG' : 'SHORT';

    // ==== niveles ====
    const sl = side === 'LONG' ? entryPx * (1 - cfg.slPct) : entryPx * (1 + cfg.slPct);
    const tp = side === 'LONG' ? entryPx * (1 + cfg.tpPct) : entryPx * (1 - cfg.tpPct);

    // ==== features para diagnóstico ====
    const win = candles.slice(0, i + 1);
    const vavg = volumeAvg(win, Math.max(20, CONFIG.VOL_AVG_LEN));
    const vRatio = vavg > 0 ? c0.volume / vavg : 0;

    const highs = win.map((x) => x.high),
      lows = win.map((x) => x.low),
      closes = win.map((x) => x.close);
    const { adx } = adxCalc(highs, lows, closes, Number(CONFIG.ADX_LEN ?? 14));
    const { longP, shortP } = evaluateML(win);
    const mlMargin = Math.abs(longP - shortP);

    // BB anti-overview (solo para diagnóstico, NO filtra)
    const bbLen = 20,
      bbK = 2;
    const mean20 =
      closes.slice(-bbLen).reduce((s, v) => s + v, 0) / Math.max(1, Math.min(closes.length, bbLen));
    const sd20 = std(closes, bbLen);
    const upper =
      Number.isFinite(mean20) && Number.isFinite(sd20) ? mean20 + bbK * sd20 : undefined;
    const lower =
      Number.isFinite(mean20) && Number.isFinite(sd20) ? mean20 - bbK * sd20 : undefined;
    const distTopPct = upper ? (upper - entryPx) / upper : undefined;

    // ==== simulación hacia adelante ====
    let exit: Trade['exit'] = 'Timeout';
    let exitPx = candles[i + cfg.maxBars]?.close ?? c1.close;
    let exitIdx = Math.min(i + cfg.maxBars, candles.length - 1);

    for (let k = i + 1; k <= Math.min(i + cfg.maxBars, candles.length - 1); k++) {
      const bar = candles[k];
      // Convención conservadora: SL primero, luego TP si ambos en misma vela
      if (side === 'LONG') {
        if (bar.low <= sl) {
          exit = 'SL';
          exitPx = sl;
          exitIdx = k;
          break;
        }
        if (bar.high >= tp) {
          exit = 'TP';
          exitPx = tp;
          exitIdx = k;
          break;
        }
      } else {
        if (bar.high >= sl) {
          exit = 'SL';
          exitPx = sl;
          exitIdx = k;
          break;
        }
        if (bar.low <= tp) {
          exit = 'TP';
          exitPx = tp;
          exitIdx = k;
          break;
        }
      }
    }

    const path = candles.slice(i + 1, exitIdx + 1);
    const { mfePct, maePct } = mfeMaeFromPath(side, entryPx, path);

    const grossRet = side === 'LONG' ? (exitPx - entryPx) / entryPx : (entryPx - exitPx) / entryPx;

    const fees = cfg.feePct * 2; // ida+vuelta
    const pnlPct = grossRet - fees;

    trades.push({
      side,
      entryIdx: i,
      entryTs: cfg.entryAt === 'nextOpen' ? c1.closeTime : c0.closeTime,
      entryPx,
      exitIdx,
      exitTs: candles[exitIdx].closeTime,
      exitPx,
      exit,
      barsHeld: exitIdx - i,
      pnlPct,
      mfePct,
      maePct,
      reason: sig.reason,
      adx: Number(adx) || 0,
      longP,
      shortP,
      mlMargin,
      vRatio,
      bbUpper: upper,
      bbLower: lower,
      distTopPct,
    });

    inTrade = true;
    // “Cerrar” inmediatamente (backtest single-thread): pasamos a después del trade
    i = exitIdx;
    inTrade = false;
    lastExitAtIdx = exitIdx;
    state.lastExitReason = exit === 'TP' ? 'tp' : exit === 'SL' ? 'sl' : 'timeout';
    state.lastTPAt = exit === 'TP' ? candles[exitIdx].closeTime : undefined;
  }

  // ===== Reporte =====
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
    ref.n += 1;
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
