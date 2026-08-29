import { Candle } from '../../types';
import { MicroRegime } from './MicroBurstTypes';

function averageTrueRange(candles: Candle[], period: number): number {
  if (candles.length < period + 1) return 0;
  let total = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];
    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close),
    );
    total += tr;
  }
  return total / period;
}

function averageBodyRange(candles: Candle[], period: number): number {
  if (candles.length < period) return 0;
  let total = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    total += Math.abs(candles[i].close - candles[i].open);
  }
  return total / period;
}

export function classifyMicroRegime(candles: Candle[]): MicroRegime {
  if (candles.length < 20) return 'RANGING';

  const closes = candles.map((c) => c.close);
  const last10 = closes.slice(-10);
  const first10 = closes.slice(-20, -10);

  const avgLast10 = last10.reduce((s, v) => s + v, 0) / last10.length;
  const avgFirst10 = first10.reduce((s, v) => s + v, 0) / first10.length;

  const directionalMove = Math.abs(avgLast10 - avgFirst10) / avgFirst10;

  const atr = averageTrueRange(candles, 14);
  const avgPrice = avgLast10;
  const atrPct = avgPrice > 0 ? atr / avgPrice : 0;

  const bodyRange = averageBodyRange(candles.slice(-10), 10);
  const totalRange = atr > 0 ? atr : 1;
  const bodyRatio = totalRange > 0 ? bodyRange / totalRange : 0;

  if (atrPct > 0.003 && bodyRatio < 0.4) return 'VOLATILE';
  if (directionalMove > 0.002 && avgLast10 > avgFirst10) return 'TRENDING_UP';
  if (directionalMove > 0.002 && avgLast10 < avgFirst10) return 'TRENDING_DOWN';
  return 'RANGING';
}
