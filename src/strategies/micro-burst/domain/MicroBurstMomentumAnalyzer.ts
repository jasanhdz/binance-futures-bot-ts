import { Candle, Side } from '../../types';
import { MicroMomentumSignal } from './MicroBurstTypes';

function linearRegressionSlope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  let sumX = 0,
    sumY = 0,
    sumXY = 0,
    sumXX = 0;
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1);
    const y = values[i];
    sumX += x;
    sumY += y;
    sumXY += x * y;
    sumXX += x * x;
  }
  const denom = n * sumXX - sumX * sumX;
  return denom === 0 ? 0 : (n * sumXY - sumX * sumY) / denom;
}

function bodyStrength(c: Candle): number {
  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low;
  return range === 0 ? 0 : body / range;
}

function wickRejectionUpper(c: Candle): number {
  const range = c.high - c.low;
  return range === 0 ? 0 : (c.high - Math.max(c.open, c.close)) / range;
}

function wickRejectionLower(c: Candle): number {
  const range = c.high - c.low;
  return range === 0 ? 0 : (Math.min(c.open, c.close) - c.low) / range;
}

function sequenceQuality(candles: Candle[], direction: Side): number {
  if (candles.length < 2) return 0;
  let score = 0;
  for (let i = candles.length - 1; i >= 1; i--) {
    const c = candles[i];
    if (direction === 'LONG') {
      if (c.close > c.open) score += 1;
      if (c.close > candles[i - 1].close) score += 0.5;
    } else {
      if (c.close < c.open) score += 1;
      if (c.close < candles[i - 1].close) score += 0.5;
    }
  }
  return Math.min(1, score / (candles.length * 1.5));
}

function volumeExpansion(candles: Candle[], period: number): boolean {
  if (candles.length < period * 2) return false;
  const recentVol = candles.slice(-period).reduce((s, c) => s + c.volume, 0) / period;
  const prevVol = candles.slice(-period * 2, -period).reduce((s, c) => s + c.volume, 0) / period;
  return prevVol > 0 ? recentVol > prevVol * 1.2 : recentVol > 0;
}

export function analyzeMicroMomentum(
  candles1m: Candle[],
  candles3m: Candle[],
  candles5m: Candle[],
  slopePeriod?: number,
): MicroMomentumSignal {
  const period = slopePeriod ?? 5;
  if (candles1m.length === 0 && candles3m.length === 0 && candles5m.length === 0) {
    return {
      direction: 'NEUTRAL',
      strength: 0,
      continuationScore: 0,
      slope1m: 0,
      slope3m: 0,
      slope5m: 0,
      bodyStrength: 0,
      wickRejectionUpper: 0,
      wickRejectionLower: 0,
      volumeExpansion: false,
      candleSequenceQuality: 0,
    };
  }
  const recent1m = candles1m.slice(-period);
  const recent3m = candles3m.slice(-period);
  const recent5m = candles5m.slice(-period);

  const closes1m = recent1m.map((c) => c.close);
  const closes3m = recent3m.map((c) => c.close);
  const closes5m = recent5m.map((c) => c.close);

  const slope1m = linearRegressionSlope(closes1m);
  const slope3m = linearRegressionSlope(closes3m);
  const slope5m = linearRegressionSlope(closes5m);

  const avgPrice = closes1m[closes1m.length - 1] || 1;
  const normalizedSlope1m = avgPrice > 0 ? slope1m / avgPrice : 0;
  const normalizedSlope3m = avgPrice > 0 ? slope3m / avgPrice : 0;
  const normalizedSlope5m = avgPrice > 0 ? slope5m / avgPrice : 0;

  let direction: Side | 'NEUTRAL' = 'NEUTRAL';
  const threshold = 0.0001;
  if (normalizedSlope1m > threshold && normalizedSlope3m > 0) direction = 'LONG';
  else if (normalizedSlope1m < -threshold && normalizedSlope3m < 0) direction = 'SHORT';

  const avgBody = recent1m.reduce((s, c) => s + bodyStrength(c), 0) / recent1m.length;
  const avgWickUpper = recent1m.reduce((s, c) => s + wickRejectionUpper(c), 0) / recent1m.length;
  const avgWickLower = recent1m.reduce((s, c) => s + wickRejectionLower(c), 0) / recent1m.length;

  const seqQuality = direction !== 'NEUTRAL' ? sequenceQuality(recent1m, direction) : 0;

  const volExp = volumeExpansion(candles1m, period);

  const strength = Math.min(
    1,
    Math.abs(normalizedSlope1m) * 3000 +
      Math.abs(normalizedSlope3m) * 2000 +
      avgBody * 0.3 +
      seqQuality * 0.3 +
      (volExp ? 0.1 : 0),
  );

  const continuationScore = Math.min(
    1,
    seqQuality * 0.4 +
      (direction !== 'NEUTRAL' ? strength * 0.3 : 0) +
      (volExp ? 0.15 : 0) +
      Math.abs(normalizedSlope5m) * 1000 * 0.15,
  );

  return {
    direction,
    strength,
    continuationScore,
    slope1m: normalizedSlope1m,
    slope3m: normalizedSlope3m,
    slope5m: normalizedSlope5m,
    bodyStrength: avgBody,
    wickRejectionUpper: avgWickUpper,
    wickRejectionLower: avgWickLower,
    volumeExpansion: volExp,
    candleSequenceQuality: seqQuality,
  };
}
