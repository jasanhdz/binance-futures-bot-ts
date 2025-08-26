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
function wickiness(c: Candle) {
  const r = Math.max(1e-9, c.high - c.low);
  const upper = c.high - Math.max(c.open, c.close);
  const lower = Math.min(c.open, c.close) - c.low;
  return (upper + lower) / r; // 0 = sin mechas, 1 = pura mecha
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

/* -------- ATR (SMA de TR) y helpers -------- */
function trueRange(curr: Candle, prevClose: number) {
  const a = curr.high - curr.low;
  const b = Math.abs(curr.high - prevClose);
  const c = Math.abs(curr.low - prevClose);
  return Math.max(a, b, c);
}
function atrNowPct(candles: Candle[], period: number) {
  if (candles.length < period + 1) return 0;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const curr = candles[i];
    const prevClose = candles[i - 1].close;
    sum += trueRange(curr, prevClose);
  }
  const atr = sum / period;
  const px = candles[candles.length - 1].close;
  return atr / Math.max(1e-9, px);
}
/** no-decreciente con tolerancia (permite empates/pequeñas caídas) */
function nonDecreasing(vs: number[], tol = 0) {
  for (let i = 1; i < vs.length; i++) {
    if (vs[i] + 1e-12 < vs[i - 1] * (1 - tol)) return false;
  }
  return true;
}

/* ---------- Activación ---------- */
/* ---------- Activación con logs detallados ---------- */
export async function shouldEnterLongStack(symbol: string) {
  const candles = await getCandles(symbol, CONFIG.ENTRY_TIMEFRAME, 300);
  if (candles.length < 80) {
    console.log('[STACK/LONG] blocked: few_candles (<80)');
    return { ok: false, reason: 'few_candles' };
  }

  const k = CONFIG.GREEN_STREAK_MIN; // p.ej. 3
  const lastK = candles.slice(-k);
  const closes = candles.map((c) => c.close);
  const lastC = candles[candles.length - 1];

  // Volumen base (media histórica reciente, sin la última)
  const vavg = volumeAvg(candles, Math.max(20, CONFIG.VOL_AVG_LEN));
  const needVol = CONFIG.VOL_FACTOR_ENTRY * vavg;

  // Checks de calidad
  const colorOK = lastK.every(green);
  const volOKAll = lastK.every((c) => c.volume >= needVol);
  const volAsc = nonDecreasing(
    lastK.map((c) => c.volume),
    CONFIG.VOL_ASC_TOLERANCE ?? 0,
  );
  const bodyOKAll = lastK.every((c) => bodyPct(c) >= CONFIG.MIN_BODY_PCT);
  const wicksOKAll = lastK.every((c) => wickiness(c) <= CONFIG.MAX_WICKINESS);

  // Tendencia / extensión
  const e7 = last(ema(closes, 7))!;
  const e25 = last(ema(closes, 25))!;
  const e99 = last(ema(closes, 99))!;
  const trendOK = lastC.close > e25 && e7 > e25 && e25 > e99;
  const extFromBase = (lastC.close - e25) / e25;
  const notOverextended = extFromBase <= CONFIG.MAX_EXTENSION_FROM_BASE;

  // ATR mínimo
  const atrPct = atrNowPct(candles, CONFIG.ATR_PERIOD);
  const atrOK = atrPct >= CONFIG.MIN_ATR_PCT;

  const ok =
    colorOK && volOKAll && volAsc && bodyOKAll && wicksOKAll && trendOK && notOverextended && atrOK;

  // --- LOG DETALLADO ---
  const reasons: string[] = [];
  if (!colorOK) reasons.push(`color(${k} verdes)`);
  if (!volOKAll) reasons.push(`vol>=needVol(${needVol.toFixed(0)})`);
  if (!volAsc) reasons.push(`volAsc(tol=${(CONFIG.VOL_ASC_TOLERANCE ?? 0) * 100}%)`);
  if (!bodyOKAll) reasons.push(`body>=${(CONFIG.MIN_BODY_PCT * 100).toFixed(1)}%`);
  if (!wicksOKAll) reasons.push(`wicks<=${(CONFIG.MAX_WICKINESS * 100).toFixed(1)}%`);
  if (!trendOK) reasons.push('trend(e7>e25>e99 & close>e25)');
  if (!notOverextended)
    reasons.push(`extension<=${(CONFIG.MAX_EXTENSION_FROM_BASE * 100).toFixed(2)}%`);
  if (!atrOK) reasons.push(`ATR>=${(CONFIG.MIN_ATR_PCT * 100).toFixed(2)}%`);

  console.log('[STACK/LONG] checks', {
    timeframe: CONFIG.ENTRY_TIMEFRAME,
    k,
    vols: lastK.map((c) => c.volume),
    vavg,
    needVol,
    volAscTol: CONFIG.VOL_ASC_TOLERANCE ?? 0,
    bodyPct: lastK.map((c) => bodyPct(c)),
    wickiness: lastK.map((c) => wickiness(c)),
    ema: { e7, e25, e99 },
    lastClose: lastC.close,
    extFromBase,
    atrPct,
    flags: { colorOK, volOKAll, volAsc, bodyOKAll, wicksOKAll, trendOK, notOverextended, atrOK },
    ok,
  });

  if (!ok) console.log('[STACK/LONG] BLOCKED by:', reasons.join(' | '));

  return { ok, reason: ok ? undefined : reasons.join(', ') };
}

export async function shouldEnterShortStack(symbol: string) {
  const candles = await getCandles(symbol, CONFIG.ENTRY_TIMEFRAME, 300);
  if (candles.length < 80) {
    console.log('[STACK/SHORT] blocked: few_candles (<80)');
    return { ok: false, reason: 'few_candles' };
  }

  const k = CONFIG.RED_STREAK_MIN; // p.ej. 3
  const lastK = candles.slice(-k);
  const closes = candles.map((c) => c.close);
  const lastC = candles[candles.length - 1];

  const vavg = volumeAvg(candles, Math.max(20, CONFIG.VOL_AVG_LEN));
  const needVol = CONFIG.VOL_FACTOR_ENTRY * vavg;

  const colorOK = lastK.every(red);
  const volOKAll = lastK.every((c) => c.volume >= needVol);
  const volAsc = nonDecreasing(
    lastK.map((c) => c.volume),
    CONFIG.VOL_ASC_TOLERANCE ?? 0,
  );
  const bodyOKAll = lastK.every((c) => bodyPct(c) >= CONFIG.MIN_BODY_PCT);
  const wicksOKAll = lastK.every((c) => wickiness(c) <= CONFIG.MAX_WICKINESS);

  const e7 = last(ema(closes, 7))!;
  const e25 = last(ema(closes, 25))!;
  const e99 = last(ema(closes, 99))!;
  const trendOK = lastC.close < e25 && e7 < e25 && e25 < e99;
  const extFromBase = (e25 - lastC.close) / e25;
  const notOverextended = extFromBase <= CONFIG.MAX_EXTENSION_FROM_BASE;

  const atrPct = atrNowPct(candles, CONFIG.ATR_PERIOD);
  const atrOK = atrPct >= CONFIG.MIN_ATR_PCT;

  const ok =
    colorOK && volOKAll && volAsc && bodyOKAll && wicksOKAll && trendOK && notOverextended && atrOK;

  const reasons: string[] = [];
  if (!colorOK) reasons.push(`color(${k} rojas)`);
  if (!volOKAll) reasons.push(`vol>=needVol(${needVol.toFixed(0)})`);
  if (!volAsc) reasons.push(`volAsc(tol=${(CONFIG.VOL_ASC_TOLERANCE ?? 0) * 100}%)`);
  if (!bodyOKAll) reasons.push(`body>=${(CONFIG.MIN_BODY_PCT * 100).toFixed(1)}%`);
  if (!wicksOKAll) reasons.push(`wicks<=${(CONFIG.MAX_WICKINESS * 100).toFixed(1)}%`);
  if (!trendOK) reasons.push('trend(e7<e25<e99 & close<e25)');
  if (!notOverextended)
    reasons.push(`extension<=${(CONFIG.MAX_EXTENSION_FROM_BASE * 100).toFixed(2)}%`);
  if (!atrOK) reasons.push(`ATR>=${(CONFIG.MIN_ATR_PCT * 100).toFixed(2)}%`);

  console.log('[STACK/SHORT] checks', {
    timeframe: CONFIG.ENTRY_TIMEFRAME,
    k,
    vols: lastK.map((c) => c.volume),
    vavg,
    needVol,
    volAscTol: CONFIG.VOL_ASC_TOLERANCE ?? 0,
    bodyPct: lastK.map((c) => bodyPct(c)),
    wickiness: lastK.map((c) => wickiness(c)),
    ema: { e7, e25, e99 },
    lastClose: lastC.close,
    extFromBase,
    atrPct,
    flags: { colorOK, volOKAll, volAsc, bodyOKAll, wicksOKAll, trendOK, notOverextended, atrOK },
    ok,
  });

  if (!ok) console.log('[STACK/SHORT] BLOCKED by:', reasons.join(' | '));

  return { ok, reason: ok ? undefined : reasons.join(', ') };
}

/* ---------- Continuidad / Corte ---------- */
export async function shouldStopLongRide(symbol: string) {
  const candles = await getCandles(symbol, CONFIG.ENTRY_TIMEFRAME, 300);
  if (candles.length < 50) return false;

  const c0 = candles[candles.length - 1];
  const c1 = candles[candles.length - 2];

  const closes = candles.map((c) => c.close);
  const emaArr = ema(closes, CONFIG.EMA_TRAIL_PERIOD);
  const emaNow = emaArr[emaArr.length - 1]!;
  const emaPrev = emaArr[emaArr.length - 2] ?? emaNow;
  const dev = CONFIG.EMA_TRAIL_DEV;

  const belowNow = c0.close < emaNow * (1 - dev);
  const belowPrev = c1.close < emaPrev * (1 - dev);

  const vavg = volumeAvg(candles, Math.max(20, CONFIG.VOL_AVG_LEN));
  const redStrongNow =
    red(c0) && bodyPct(c0) >= CONFIG.SHARP_BODY_PCT && c0.volume >= CONFIG.SHARP_VOL_FACTOR * vavg;

  if ((belowNow && belowPrev) || redStrongNow) return true;

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
  const vOk = last(candles).volume >= CONFIG.VOL_FACTOR_REENTER * vavg;
  const rStreak = streakCount(candles, 'red');
  return rStreak >= CONFIG.RED_STREAK_REENTER_MIN && vOk;
}
