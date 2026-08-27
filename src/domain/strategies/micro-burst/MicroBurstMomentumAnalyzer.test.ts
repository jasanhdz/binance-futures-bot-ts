import { describe, expect, it } from 'vitest';
import { Candle } from '../../types';
import { analyzeMicroMomentum } from './MicroBurstMomentumAnalyzer';

function makeCandle(overrides: Partial<Candle> & { index?: number }): Candle {
  const i = overrides.index ?? 0;
  return {
    openTime: i * 60000,
    timestamp: i * 60000,
    open: overrides.open ?? 100,
    high: overrides.high ?? 101,
    low: overrides.low ?? 99,
    close: overrides.close ?? 100.5,
    volume: overrides.volume ?? 1000,
    buyVolume: overrides.buyVolume ?? 500,
    closeTime: (i + 1) * 60000 - 1,
  };
}

function makeTrendingCandles(direction: 'up' | 'down', count: number): Candle[] {
  const base = direction === 'up' ? 100 : 110;
  const delta = direction === 'up' ? 0.3 : -0.3;
  return Array.from({ length: count }, (_, i) =>
    makeCandle({
      index: i,
      open: base + delta * i,
      high: base + delta * i + 0.5,
      low: base + delta * i - 0.3,
      close: base + delta * i + 0.3,
      volume: 1000 + i * 50,
    }),
  );
}

describe('MicroBurstMomentumAnalyzer', () => {
  it('returns NEUTRAL for empty candles', () => {
    const result = analyzeMicroMomentum([], [], []);
    expect(result.direction).toBe('NEUTRAL');
    expect(result.strength).toBe(0);
  });

  it('detects upward momentum', () => {
    const candles = makeTrendingCandles('up', 15);
    const result = analyzeMicroMomentum(candles.slice(-10), candles.slice(-10), candles.slice(-10));
    expect(result.direction).toBe('LONG');
    expect(result.strength).toBeGreaterThan(0);
    expect(result.continuationScore).toBeGreaterThan(0);
  });

  it('detects downward momentum', () => {
    const candles = makeTrendingCandles('down', 15);
    const result = analyzeMicroMomentum(candles.slice(-10), candles.slice(-10), candles.slice(-10));
    expect(result.direction).toBe('SHORT');
    expect(result.strength).toBeGreaterThan(0);
  });

  it('computes body strength', () => {
    const candles = makeTrendingCandles('up', 10);
    const result = analyzeMicroMomentum(candles, candles, candles);
    expect(result.bodyStrength).toBeGreaterThanOrEqual(0);
    expect(result.bodyStrength).toBeLessThanOrEqual(1);
  });

  it('computes wick rejection', () => {
    const candles = makeTrendingCandles('up', 10);
    const result = analyzeMicroMomentum(candles, candles, candles);
    expect(result.wickRejectionUpper).toBeGreaterThanOrEqual(0);
    expect(result.wickRejectionLower).toBeGreaterThanOrEqual(0);
  });

  it('detects volume expansion', () => {
    const candles = Array.from({ length: 20 }, (_, i) =>
      makeCandle({
        index: i,
        open: 100 + i * 0.1,
        high: 100 + i * 0.1 + 0.5,
        low: 100 + i * 0.1 - 0.3,
        close: 100 + i * 0.1 + 0.3,
        volume: i < 15 ? 1000 : 2000,
      }),
    );
    const result = analyzeMicroMomentum(candles, candles, candles);
    expect(result.volumeExpansion).toBe(true);
  });
});
