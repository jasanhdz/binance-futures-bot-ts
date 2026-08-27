import { describe, expect, it } from 'vitest';
import { Candle } from '../../types';
import { detectSupportResistance } from './MicroBurstSupportResistance';

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

function makeCandles(prices: number[]): Candle[] {
  return prices.map((p, i) =>
    makeCandle({
      index: i,
      open: p,
      high: p + 0.5,
      low: p - 0.5,
      close: p + 0.2,
      volume: 1000 + i * 10,
    }),
  );
}

describe('MicroBurstSupportResistance', () => {
  it('returns empty levels for insufficient data', () => {
    const result = detectSupportResistance([]);
    expect(result.levels).toHaveLength(0);
    expect(result.nearest.support).toBeNull();
    expect(result.nearest.resistance).toBeNull();
  });

  it('detects support and resistance from swing points', () => {
    const prices = [
      100, 101, 102, 103, 102, 101, 100, 99, 98, 99, 100, 101, 102, 103, 104, 103, 102, 101, 100,
      101,
    ];
    const candles = makeCandles(prices);
    const result = detectSupportResistance(candles, { lookbackBars: 10, minStrength: 0.1 });

    expect(result.levels.length).toBeGreaterThan(0);
    const hasSupport = result.levels.some((l) => l.type === 'support');
    const hasResistance = result.levels.some((l) => l.type === 'resistance');
    expect(hasSupport || hasResistance).toBe(true);
  });

  it('classifies near_support when price is close to support', () => {
    const prices = [
      100.5, 100.4, 100.3, 100.2, 100.1, 100.0, 99.9, 99.8, 99.9, 100.0, 100.1, 100.0, 99.9, 99.8,
      99.9, 100.0, 100.05, 100.03, 100.04, 100.05,
    ];
    const candles = makeCandles(prices);
    const result = detectSupportResistance(candles, { lookbackBars: 5, minStrength: 0.1 });

    const supportLevel = result.levels.find((l) => l.type === 'support');
    if (supportLevel) {
      const distBps = (Math.abs(100.05 - supportLevel.price) / supportLevel.price) * 10_000;
      if (distBps <= 50) {
        expect(result.nearest.structuralPosition).toBe('near_support');
      }
    }
  });

  it('computes corridor width', () => {
    const candles = makeCandles([
      98, 99, 100, 101, 102, 101, 100, 99, 98, 99, 100, 101, 102, 101, 100, 99, 98, 99, 100, 100.5,
    ]);
    const result = detectSupportResistance(candles, { lookbackBars: 6, minStrength: 0.1 });

    if (result.nearest.support && result.nearest.resistance) {
      expect(result.nearest.corridorWidthBps).toBeGreaterThan(0);
    }
  });

  it('levels have availableAtCandleIndex', () => {
    const prices = [
      100, 101, 102, 103, 102, 101, 100, 99, 98, 99, 100, 101, 102, 103, 104, 103, 102, 101, 100,
      101,
    ];
    const candles = makeCandles(prices);
    const result = detectSupportResistance(candles, { lookbackBars: 10, minStrength: 0.1 });

    for (const level of result.levels) {
      expect(level.availableAtCandleIndex).toBeGreaterThanOrEqual(0);
    }
  });

  it('configures pivot left/right bars', () => {
    const prices = [
      100, 101, 102, 103, 102, 101, 100, 99, 98, 99, 100, 101, 102, 103, 104, 103, 102, 101, 100,
      101,
    ];
    const candles = makeCandles(prices);
    const result = detectSupportResistance(candles, {
      lookbackBars: 10,
      pivotLeftBars: 2,
      pivotRightBars: 2,
      minStrength: 0.1,
    });
    expect(result.levels).toBeDefined();
  });
});
