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

  console.log('[STACK/LONG]', {
    tf: CONFIG.ENTRY_TIMEFRAME,
    gStreak,
    lastVol: last(candles).volume,
    vavg,
    threshold: CONFIG.VOL_FACTOR_ENTRY * vavg,
    ok: gStreak >= CONFIG.GREEN_STREAK_MIN && vOk,
  });
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
  const vOk = last(candles).volume >= CONFIG.VOL_FACTOR_ENTRY * vavg; // ⬅️ volumen alto
  const rStreak = streakCount(candles, 'red'); // ⬅️ racha de rojas

  console.log('[STACK/SHORT]', {
    tf: CONFIG.ENTRY_TIMEFRAME,
    rStreak,
    vOk,
    lastVol: last(candles).volume,
    vavg,
    threshold: CONFIG.VOL_FACTOR_ENTRY * vavg,
    ok: rStreak >= CONFIG.RED_STREAK_MIN && vOk,
  });
  return {
    ok: rStreak >= CONFIG.RED_STREAK_MIN && vOk, // ⬅️ usa vOk en vez de vDrop
    rStreak,
    vOk,
    vavg,
    lastVol: last(candles).volume,
  };
}

/* ---------- Continuidad / Corte ---------- */
export async function shouldStopLongRide(symbol: string) {
  const candles = await getCandles(symbol, CONFIG.ENTRY_TIMEFRAME, 300);
  if (candles.length < 50) return false;

  const c0 = candles[candles.length - 1]; // vela actual
  const c1 = candles[candles.length - 2]; // vela anterior

  // --- EMA trail y desvío permitido ---
  const closes = candles.map((c) => c.close);
  const emaArr = ema(closes, CONFIG.EMA_TRAIL_PERIOD);
  const emaNow = emaArr[emaArr.length - 1]!;
  const emaPrev = emaArr[emaArr.length - 2] ?? emaNow;
  const dev = CONFIG.EMA_TRAIL_DEV; // p.ej. 0.003 => 0.3%

  const belowNow = c0.close < emaNow * (1 - dev);
  const belowPrev = c1.close < emaPrev * (1 - dev);

  // --- Roja fuerte con volumen (anti “subida falsa”) ---
  const vavg = volumeAvg(candles, Math.max(20, CONFIG.VOL_AVG_LEN));
  const redStrongNow =
    red(c0) && bodyPct(c0) >= CONFIG.SHARP_BODY_PCT && c0.volume >= CONFIG.SHARP_VOL_FACTOR * vavg;

  // Regla TWO-STRIKE:
  // 1) Dos cierres consecutivos por debajo de la EMA con desvío
  //    (confirmación de cambio de tendencia)
  // 2) O una roja fuerte con volumen (giro violento)
  if ((belowNow && belowPrev) || redStrongNow) return true;

  // (Opcional) Fallback: demasiadas velas fuertes contra la tendencia en las últimas 3
  const redStrongCountLast3 = candles
    .slice(-3)
    .filter(
      (x) =>
        red(x) && bodyPct(x) >= CONFIG.SHARP_BODY_PCT && x.volume >= CONFIG.SHARP_VOL_FACTOR * vavg,
    ).length;

  if (redStrongCountLast3 >= Math.max(1, CONFIG.MAX_AGAINST_STREAK_EXIT)) return true;

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
  const vOk = last(candles).volume >= CONFIG.VOL_FACTOR_REENTER * vavg; // ⬅️ alto
  const rStreak = streakCount(candles, 'red');
  return rStreak >= CONFIG.RED_STREAK_REENTER_MIN && vOk;
}
