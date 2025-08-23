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

export function avg(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}
