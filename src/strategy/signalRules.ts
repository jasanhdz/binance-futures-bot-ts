// src/strategy/signalRules.ts

import { CONFIG } from '../utils/config';
import { getCandles, ema, avg, atr, lookbackHigh, lookbackLow } from './indicators';
import { Candle } from '../types';

export type Trend = 'UP' | 'DOWN' | 'SIDE';
export type Side = 'LONG' | 'SHORT';

export async function trendFilterHTF(symbol: string): Promise<Trend> {
  const htf = await getCandles(symbol, CONFIG.TREND_TIMEFRAME, 250);
  if (htf.length < 200) return 'SIDE';

  const closes = htf.map((c) => c.close);
  const ema50Arr = ema(closes, 50);
  const ema200Arr = ema(closes, 200);
  const ema50 = ema50Arr[ema50Arr.length - 1]!;
  const ema200 = ema200Arr[ema200Arr.length - 1]!;

  if (ema50 > ema200) return 'UP';
  if (ema50 < ema200) return 'DOWN';
  return 'SIDE';
}

function volumeOkay(candles: Candle[]): boolean {
  const latest = candles[candles.length - 1]!;
  const vols = candles.slice(-CONFIG.VOL_AVG_LEN - 1, -1).map((c) => c.volume);
  const vavg = avg(vols);
  return latest.volume >= CONFIG.VOL_FACTOR * vavg;
}

function brokeUp(candles: Candle[]): { ok: boolean; level: number } {
  const latest = candles[candles.length - 1]!;
  const level = lookbackHigh(candles, CONFIG.BREAK_LOOKBACK);
  const ok = latest.close > level;
  return { ok, level };
}

function brokeDown(candles: Candle[]): { ok: boolean; level: number } {
  const latest = candles[candles.length - 1]!;
  const level = lookbackLow(candles, CONFIG.BREAK_LOOKBACK);
  const ok = latest.close < level;
  return { ok, level };
}

function retested(level: number, candles: Candle[], side: Side): boolean {
  if (!CONFIG.REQUIRE_RETEST) return true;
  const recent = candles.slice(Math.max(0, candles.length - 3)); // últimas 1–3 velas
  if (side === 'LONG') {
    return recent.some((c) => c.low <= level && c.close >= level);
  } else {
    return recent.some((c) => c.high >= level && c.close <= level);
  }
}

export async function longSignal(symbol: string) {
  if (CONFIG.BYPASS_ENTRY_CHECKS) {
    console.log('CONFIG.BYPASS_ENTRY_CHECKS: ', CONFIG.BYPASS_ENTRY_CHECKS);

    const candles = await getCandles(symbol, CONFIG.ENTRY_TIMEFRAME, 3);
    const entry = candles.length ? candles[candles.length - 1]!.close : undefined;
    return { ok: true, entry, reason: 'bypass' };
  }

  const tf = CONFIG.ENTRY_TIMEFRAME;
  const candles = await getCandles(symbol, tf, Math.max(250, CONFIG.BREAK_LOOKBACK + 30));
  if (candles.length < CONFIG.BREAK_LOOKBACK + 5) return { ok: false };

  const trend = await trendFilterHTF(symbol);
  if (trend !== 'UP') return { ok: false, reason: `trend=${trend}` };

  const volOk = volumeOkay(candles);
  const { ok: broke, level } = brokeUp(candles);
  const rt = retested(level, candles, 'LONG');

  if (broke && volOk && rt) {
    const atrVal = atr(candles, CONFIG.ATR_PERIOD);
    const entry = candles[candles.length - 1]!.close;
    const sl = entry - CONFIG.ATR_MULT * atrVal;
    return { ok: true, entry, sl, trend, level, atr: atrVal };
  }
  return { ok: false };
}

export async function shortSignal(symbol: string) {
  // ---- BYPASS PARA PRUEBAS ----
  if (CONFIG.BYPASS_ENTRY_CHECKS) {
    console.log('CONFIG.BYPASS_ENTRY_CHECKS: ', CONFIG.BYPASS_ENTRY_CHECKS);
    const candles = await getCandles(symbol, CONFIG.ENTRY_TIMEFRAME, 3);
    const entry = candles.length ? candles[candles.length - 1]!.close : undefined;
    return { ok: true, entry, reason: 'bypass' };
  }
  const tf = CONFIG.ENTRY_TIMEFRAME;
  const candles = await getCandles(symbol, tf, Math.max(250, CONFIG.BREAK_LOOKBACK + 30));
  if (candles.length < CONFIG.BREAK_LOOKBACK + 5) return { ok: false };

  const trend = await trendFilterHTF(symbol);
  if (trend !== 'DOWN') return { ok: false, reason: `trend=${trend}` };

  const volOk = volumeOkay(candles);
  const { ok: broke, level } = brokeDown(candles);
  const rt = retested(level, candles, 'SHORT');

  if (broke && volOk && rt) {
    const atrVal = atr(candles, CONFIG.ATR_PERIOD);
    const entry = candles[candles.length - 1]!.close;
    const sl = entry + CONFIG.ATR_MULT * atrVal;
    return { ok: true, entry, sl, trend, level, atr: atrVal };
  }
  return { ok: false };
}
