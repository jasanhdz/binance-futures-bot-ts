import { Candle, Side } from '../../../core/types';

export const MAIN_STACKING_MOMENTUM_AUTHORITY =
  'origin/main@3a6dbc330760aa8bf179be76c413623d7d50a420';

export interface MainStackingMomentumDecision {
  allowed: boolean;
  side: Side;
  reason: string;
  diagnostics: {
    candleCount: number;
    volumeAverage?: number;
    requiredVolume?: number;
    ema7?: number;
    ema25?: number;
    ema99?: number;
    extensionFromBase?: number;
    atrPct?: number;
    checks: Record<string, boolean>;
  };
}

const MIN_CANDLES = 80;
const MOMENTUM_CANDLES = 3;
const VOLUME_WINDOW = 20;
const VOLUME_FACTOR = 1.1;
const VOLUME_ASCENDING_TOLERANCE = 0.02;
const MIN_BODY_PCT = 0.35;
const MAX_WICKINESS = 0.55;
const MAX_EXTENSION_FROM_BASE = 0.006;
const ATR_PERIOD = 14;
const MIN_ATR_PCT = 0.0025;

export function evaluateMainStackingMomentum(
  candles: Candle[],
  side: Side,
): MainStackingMomentumDecision {
  if (candles.length < MIN_CANDLES) {
    return decision(false, side, 'few_candles', candles.length, {});
  }

  const window = candles.slice(-MOMENTUM_CANDLES);
  const latest = candles[candles.length - 1];
  const closes = candles.map((candle) => candle.close);
  const volumeAverage = average(
    candles.slice(-VOLUME_WINDOW - 1, -1).map((candle) => candle.volume),
  );
  const requiredVolume = VOLUME_FACTOR * volumeAverage;
  const volumes = window.map((candle) => candle.volume);
  const ema7 = last(ema(closes, 7));
  const ema25 = last(ema(closes, 25));
  const ema99 = last(ema(closes, 99));
  const extensionFromBase =
    side === 'LONG' ? (latest.close - ema25) / ema25 : (ema25 - latest.close) / ema25;
  const atrPct = currentAtrPct(candles, ATR_PERIOD);
  const checks = {
    color:
      side === 'LONG'
        ? window.every((candle) => candle.close > candle.open)
        : window.every((candle) => candle.close < candle.open),
    volume: window.every((candle) => candle.volume >= requiredVolume),
    volumeAscending: nonDecreasing(volumes, VOLUME_ASCENDING_TOLERANCE),
    body: window.every((candle) => bodyPct(candle) >= MIN_BODY_PCT),
    wicks: window.every((candle) => wickiness(candle) <= MAX_WICKINESS),
    trend:
      side === 'LONG'
        ? latest.close > ema25 && ema7 > ema25 && ema25 > ema99
        : latest.close < ema25 && ema7 < ema25 && ema25 < ema99,
    extension: extensionFromBase <= MAX_EXTENSION_FROM_BASE,
    atr: atrPct >= MIN_ATR_PCT,
  };
  const failed = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);

  return {
    allowed: failed.length === 0,
    side,
    reason:
      failed.length === 0
        ? 'main_stacking_momentum_confirmed'
        : `main_stacking_momentum_blocked:${failed.join(',')}`,
    diagnostics: {
      candleCount: candles.length,
      volumeAverage,
      requiredVolume,
      ema7,
      ema25,
      ema99,
      extensionFromBase,
      atrPct,
      checks,
    },
  };
}

function decision(
  allowed: boolean,
  side: Side,
  reason: string,
  candleCount: number,
  checks: Record<string, boolean>,
): MainStackingMomentumDecision {
  return { allowed, side, reason, diagnostics: { candleCount, checks } };
}

function ema(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const multiplier = 2 / (period + 1);
  const output = [values[0]];
  for (let index = 1; index < values.length; index += 1) {
    output.push(values[index] * multiplier + output[index - 1] * (1 - multiplier));
  }
  return output;
}

function currentAtrPct(candles: Candle[], period: number): number {
  let total = 0;
  for (let index = candles.length - period; index < candles.length; index += 1) {
    const candle = candles[index];
    const previousClose = candles[index - 1].close;
    total += Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    );
  }
  return total / period / Math.max(1e-9, candles[candles.length - 1].close);
}

function bodyPct(candle: Candle): number {
  return Math.abs(candle.close - candle.open) / Math.max(1e-9, candle.high - candle.low);
}

function wickiness(candle: Candle): number {
  const range = Math.max(1e-9, candle.high - candle.low);
  const upper = candle.high - Math.max(candle.open, candle.close);
  const lower = Math.min(candle.open, candle.close) - candle.low;
  return (upper + lower) / range;
}

function nonDecreasing(values: number[], tolerance: number): boolean {
  return values.every(
    (value, index) => index === 0 || value + 1e-12 >= values[index - 1] * (1 - tolerance),
  );
}

function average(values: number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function last(values: number[]): number {
  return values[values.length - 1];
}
