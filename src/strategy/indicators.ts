import { binanceClient } from '../api/binanceClient';
import { Candle } from '../types';

export async function getCandles(
  symbol: string,
  interval: string,
  limit: number,
): Promise<Candle[]> {
  const raw = await binanceClient.futuresCandles({ symbol, interval: interval as any, limit });
  return raw.map((c) => ({
    openTime: c.openTime,
    open: parseFloat(c.open),
    high: parseFloat(c.high),
    low: parseFloat(c.low),
    close: parseFloat(c.close),
    volume: parseFloat(c.volume),
    closeTime: c.closeTime,
  }));
}

export function ema(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values[0];
  out.push(prev);
  for (let i = 1; i < values.length; i++) {
    const v = values[i] * k + prev * (1 - k);
    out.push(v);
    prev = v;
  }
  return out;
}

export function atr(candles: Candle[], period: number): number {
  if (candles.length < period + 1) return NaN;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const p = candles[i - 1];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    trs.push(tr);
  }
  // EMA de TR para ATR suave
  const atrArr = ema(trs, period);
  return atrArr[atrArr.length - 1];
}

export function avg(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

export function lookbackHigh(candles: Candle[], n: number): number {
  return Math.max(...candles.slice(-n - 1, -1).map((c) => c.high)); // excluye la última
}

export function lookbackLow(candles: Candle[], n: number): number {
  return Math.min(...candles.slice(-n - 1, -1).map((c) => c.low)); // excluye la última
}
