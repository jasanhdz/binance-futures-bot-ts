import { Candle, Side } from '../../types';
import { MicroMomentumSignal } from './MicroBurstTypes';

function linearSlope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const xs = values.map((_, i) => i);
  const xMean = xs.reduce((s, v) => s + v, 0) / n;
  const yMean = values.reduce((s, v) => s + v, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - xMean) * (values[i] - yMean);
    den += (xs[i] - xMean) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

function bodyStrength(candle: Candle): number {
  const range = candle.high - candle.low;
  if (range === 0) return 0;
  return Math.abs(candle.close - candle.open) / range;
}

function wickRatios(candle: Candle): { upper: number; lower: number } {
  const range = candle.high - candle.low;
  if (range === 0) return { upper: 0, lower: 0 };
  const bodyHigh = Math.max(candle.open, candle.close);
  const bodyLow = Math.min(candle.open, candle.close);
  return {
    upper: (candle.high - bodyHigh) / range,
    lower: (bodyLow - candle.low) / range,
  };
}

function volumeExpansion(candles: Candle[]): boolean {
  if (candles.length < 10) return false;
  const recent5 = candles.slice(-5).reduce((s, c) => s + c.volume, 0) / 5;
  const prev5 = candles.slice(-10, -5).reduce((s, c) => s + c.volume, 0) / 5;
  return prev5 > 0 ? recent5 > prev5 * 1.1 : false;
}

function candleSequenceQuality(candles: Candle[], direction: Side): number {
  if (candles.length < 3) return 0;
  const last3 = candles.slice(-3);
  let score = 0;
  for (const c of last3) {
    const isGreen = c.close > c.open;
    if (direction === 'LONG' && isGreen) score += 1;
    else if (direction === 'SHORT' && !isGreen) score += 1;
  }
  const bodyStrengths = last3.map(bodyStrength);
  const avgBody = bodyStrengths.reduce((s, v) => s + v, 0) / bodyStrengths.length;
  const bodyBonus = avgBody >= 0.35 ? 0.5 : avgBody >= 0.25 ? 0.25 : 0;
  return (score / 3) * 0.7 + bodyBonus * 0.3;
}

export function analyzeMicroMomentum(
  candles1m: Candle[],
  candles3m: Candle[],
  candles5m: Candle[],
): MicroMomentumSignal {
  const slope1m = linearSlope(candles1m.slice(-5).map((c) => c.close));
  const slope3m = linearSlope(candles3m.slice(-5).map((c) => c.close));
  const slope5m = linearSlope(candles5m.slice(-5).map((c) => c.close));

  const normalizedSlope1m = candles1m.length > 0 ? slope1m / candles1m[candles1m.length - 1].close : 0;
  const normalizedSlope3m = candles3m.length > 0 ? slope3m / candles3m[candles3m.length - 1].close : 0;
  const normalizedSlope5m = candles5m.length > 0 ? slope5m / candles5m[candles5m.length - 1].close : 0;

  const avgSlope = (normalizedSlope1m + normalizedSlope3m + normalizedSlope5m) / 3;

  let direction: Side | 'NEUTRAL' = 'NEUTRAL';
  if (avgSlope > 0.0001) direction = 'LONG';
  else if (avgSlope < -0.0001) direction = 'SHORT';

  const lastCandle3m = candles3m[candles3m.length - 1];
  const body = lastCandle3m ? bodyStrength(lastCandle3m) : 0;
  const wicks = lastCandle3m ? wickRatios(lastCandle3m) : { upper: 0, lower: 0 };
  const wickRejectionUpper = direction === 'SHORT' ? wicks.upper : wicks.lower;
  const wickRejectionLower = direction === 'LONG' ? wicks.lower : wicks.upper;

  const seqQuality = direction !== 'NEUTRAL' ? candleSequenceQuality(candles3m, direction) : 0;
  const volExpansion = volumeExpansion(candles3m);

  const slopeScore = Math.min(1, Math.abs(avgSlope) * 5000);
  const strength = Math.min(1, slopeScore * 0.4 + body * 0.3 + seqQuality * 0.3);
  const continuationScore = Math.min(1, slopeScore * 0.3 + seqQuality * 0.3 + (volExpansion ? 0.2 : 0) + body * 0.2);

  return {
    direction,
    strength,
    continuationScore,
    slope1m: normalizedSlope1m,
    slope3m: normalizedSlope3m,
    slope5m: normalizedSlope5m,
    bodyStrength: body,
    wickRejectionUpper,
    wickRejectionLower,
    volumeExpansion: volExpansion,
    candleSequenceQuality: seqQuality,
  };
}
