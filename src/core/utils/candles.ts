// src/core/utils/candles.ts
import { Candle } from '../types';

export const last = <T>(a: T[]): T => a[a.length - 1];

export const avg = (arr: number[]) =>
  arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;

export const green = (c: Candle) => c.close > c.open;
export const red = (c: Candle) => c.close < c.open;

export function bodyPct(c: { open: number; close: number; high: number; low: number }) {
  const r = Math.max(1e-9, c.high - c.low);
  return Math.abs(c.close - c.open) / r;
}

export function wickiness(c: { open: number; close: number; high: number; low: number }) {
  const r = Math.max(1e-9, c.high - c.low);
  const up = c.high - Math.max(c.open, c.close);
  const lo = Math.min(c.open, c.close) - c.low;
  return (up + lo) / r;
}

export function volumeAvg(candles: Candle[], len: number) {
  const vols = candles.slice(-len - 1, -1).map((c) => c.volume);
  return avg(vols);
}

export function nonDecreasing(vs: number[], tol = 0) {
  for (let i = 1; i < vs.length; i++) {
    if (vs[i] + 1e-12 < vs[i - 1] * (1 - tol)) return false;
  }
  return true;
}

export function trueRange(curr: Candle, prevClose: number) {
  const a = curr.high - curr.low;
  const b = Math.abs(curr.high - prevClose);
  const c = Math.abs(curr.low - prevClose);
  return Math.max(a, b, c);
}

export function atrPctNow(candles: Candle[], period: number) {
  if (candles.length < period + 1) return 0;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    sum += trueRange(candles[i], candles[i - 1].close);
  }
  const atr = sum / period;
  const px = last(candles).close;
  return atr / Math.max(1e-9, px);
}

export function countStreak(cs: Candle[], color: 'green' | 'red') {
  let n = 0;
  for (let i = cs.length - 1; i >= 0; i--) {
    const ok = color === 'green' ? cs[i].close > cs[i].open : cs[i].close < cs[i].open;
    if (ok) n++;
    else break;
  }
  return n;
}
