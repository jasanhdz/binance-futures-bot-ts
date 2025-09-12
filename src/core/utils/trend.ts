// src/core/utils/trend.ts
import { Candle } from '../types';
import { ema } from '../indicators/ema';

export type Align = 'BULL' | 'BEAR';

export function emaAlign(
  cs: Candle[],
  fast = 7,
  mid = 25,
  slow = 99,
): { align: Align | 'NONE'; emaFast: number; emaMid: number; emaSlow: number } {
  const closes = cs.map((c) => c.close);
  const eF = ema(closes, fast).pop()!;
  const eM = ema(closes, mid).pop()!;
  const eS = ema(closes, slow).pop()!;

  if (eF > eM && eM > eS) return { align: 'BULL', emaFast: eF, emaMid: eM, emaSlow: eS };
  if (eF < eM && eM < eS) return { align: 'BEAR', emaFast: eF, emaMid: eM, emaSlow: eS };
  return { align: 'NONE', emaFast: eF, emaMid: eM, emaSlow: eS };
}
