// src/strategy/stacking.ts
import { getCandles, ema, avg } from './indicators';
import { CONFIG } from '../utils/config';
import { Candle } from '../types';

function last<T>(a: T[]) {
  return a[a.length - 1];
}
function bodyPct(c: Candle) {
  const r = Math.max(1e-9, c.high - c.low);
  return Math.abs(c.close - c.open) / r;
}
function green(c: Candle) {
  return c.close > c.open;
}
function red(c: Candle) {
  return c.close < c.open;
}
function volumeAvg(candles: Candle[], len: number) {
  const vols = candles.slice(-len - 1, -1).map((c) => c.volume);
  return avg(vols);
}
function streakCount(candles: Candle[], color: 'green' | 'red') {
  let n = 0;
  for (let i = candles.length - 1; i >= 0; i--) {
    const ok = color === 'green' ? green(candles[i]) : red(candles[i]);
    if (ok) n++;
    else break;
  }
  return n;
}

/* ---------- Activación ---------- */
export async function shouldEnterLongStack(symbol: string) {
  const candles = await getCandles(symbol, CONFIG.ENTRY_TIMEFRAME, 300);
  if (candles.length < 50) return { ok: false, reason: 'few_candles' };

  const vavg = volumeAvg(candles, Math.max(20, CONFIG.VOL_AVG_LEN));
  const vOk = last(candles).volume >= CONFIG.VOL_FACTOR_ENTRY * vavg;
  const gStreak = streakCount(candles, 'green');

  return {
    ok: gStreak >= CONFIG.GREEN_STREAK_MIN && vOk,
    gStreak,
    vOk,
    vavg,
    lastVol: last(candles).volume,
  };
}

export async function shouldEnterShortStack(symbol: string) {
  const candles = await getCandles(symbol, CONFIG.ENTRY_TIMEFRAME, 300);
  if (candles.length < 50) return { ok: false, reason: 'few_candles' };

  const vavg = volumeAvg(candles, Math.max(20, CONFIG.VOL_AVG_LEN));
  const vDrop = last(candles).volume <= CONFIG.VOL_DROP_FACTOR * vavg;
  const rStreak = streakCount(candles, 'red');

  return {
    ok: rStreak >= CONFIG.RED_STREAK_MIN && vDrop,
    rStreak,
    vDrop,
    vavg,
    lastVol: last(candles).volume,
  };
}

/* ---------- Continuidad / Corte ---------- */
export async function shouldStopLongRide(symbol: string) {
  const candles = await getCandles(symbol, CONFIG.ENTRY_TIMEFRAME, 300);
  if (candles.length < 50) return false;

  const closes = candles.map((c) => c.close);
  const emaTrail = last(ema(closes, CONFIG.EMA_TRAIL_PERIOD));
  const c = last(candles);

  if (c.close < emaTrail * (1 - CONFIG.EMA_TRAIL_DEV)) return true;

  const vavg = volumeAvg(candles, Math.max(20, CONFIG.VOL_AVG_LEN));
  const last3 = candles.slice(-3);
  const redStrong = last3.filter(
    (x) =>
      red(x) && bodyPct(x) >= CONFIG.SHARP_BODY_PCT && x.volume >= CONFIG.SHARP_VOL_FACTOR * vavg,
  ).length;
  if (redStrong >= Math.max(1, CONFIG.MAX_AGAINST_STREAK_EXIT - 1)) return true;

  return false;
}

export async function shouldStopShortRide(symbol: string) {
  const candles = await getCandles(symbol, CONFIG.ENTRY_TIMEFRAME, 300);
  if (candles.length < 50) return false;

  const closes = candles.map((c) => c.close);
  const emaTrail = last(ema(closes, CONFIG.EMA_TRAIL_PERIOD));
  const c = last(candles);

  if (c.close > emaTrail * (1 + CONFIG.EMA_TRAIL_DEV)) return true;

  const vavg = volumeAvg(candles, Math.max(20, CONFIG.VOL_AVG_LEN));
  const last3 = candles.slice(-3);
  const greenStrong = last3.filter(
    (x) =>
      green(x) && bodyPct(x) >= CONFIG.SHARP_BODY_PCT && x.volume >= CONFIG.SHARP_VOL_FACTOR * vavg,
  ).length;
  if (greenStrong >= Math.max(1, CONFIG.MAX_AGAINST_STREAK_EXIT - 1)) return true;

  return false;
}

/* ---------- Momentum tras TP (para re-entrada) ---------- */
// Puedes dejarlos iguales a la activación o un pelín más “permisivos”
export async function momentumStillStrongLong(symbol: string) {
  const candles = await getCandles(symbol, CONFIG.ENTRY_TIMEFRAME, 200);
  if (candles.length < 50) return false;
  const vavg = volumeAvg(candles, Math.max(20, CONFIG.VOL_AVG_LEN));
  const vOk = last(candles).volume >= CONFIG.VOL_FACTOR_REENTER * vavg;
  const gStreak = streakCount(candles, 'green');
  return gStreak >= CONFIG.GREEN_STREAK_REENTER_MIN && vOk;
}

export async function momentumStillStrongShort(symbol: string) {
  const candles = await getCandles(symbol, CONFIG.ENTRY_TIMEFRAME, 200);
  if (candles.length < 50) return false;
  const vavg = volumeAvg(candles, Math.max(20, CONFIG.VOL_AVG_LEN));
  const vDrop = last(candles).volume <= CONFIG.VOL_DROP_FACTOR_REENTER * vavg;
  const rStreak = streakCount(candles, 'red');
  return rStreak >= CONFIG.RED_STREAK_REENTER_MIN && vDrop;
}
