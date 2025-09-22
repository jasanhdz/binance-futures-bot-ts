// src/backtest/utils.ts - CORREGIDO
import fs from 'fs';
import { Candle } from '../core/types';

export function loadCsvCandles(csvPath: string): Candle[] {
  const txt = fs.readFileSync(csvPath, 'utf8').trim();
  const [header, ...lines] = txt.split(/\r?\n/);
  const cols = header.split(',');
  const idx = (name: string) => cols.indexOf(name);

  const iOpenTime = idx('open_time');
  const iOpen = idx('open');
  const iHigh = idx('high');
  const iLow = idx('low');
  const iClose = idx('close');
  const iVolume = idx('volume');
  const iCloseTime = idx('close_time');

  return lines
    .map((ln) => {
      const f = ln.split(',');
      return {
        openTime: +f[iOpenTime],
        open: +f[iOpen],
        high: +f[iHigh],
        low: +f[iLow],
        close: +f[iClose],
        volume: +f[iVolume],
        closeTime: +f[iCloseTime],
      } as Candle;
    })
    .filter((c) => Number.isFinite(c.open) && Number.isFinite(c.close));
}

export function std(arr: number[], n: number) {
  const k = Math.min(arr.length, n);
  if (k <= 1) return 0;
  const slice = arr.slice(-k);
  const mean = slice.reduce((s, v) => s + v, 0) / k;
  const v = slice.reduce((s, v) => s + (v - mean) * (v - mean), 0) / (k - 1);
  return Math.sqrt(Math.max(0, v));
}

export function hourOfDay(ts: number): number {
  const d = new Date(ts);
  return d.getUTCHours(); // usa UTC para consistencia
}

// CORREGIDO: Tipo de retorno explícito
export function mfeMaeFromPath(
  side: 'LONG' | 'SHORT',
  entry: number,
  path: Candle[],
): { mfePct: number; maePct: number } {
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
