import { describe, expect, it } from 'vitest';
import { Candle } from '../../../core/types';
import { detectSupportResistance } from './MicroBurstSupportResistance';

const START_MS = 1_700_000_000_000;
const INTERVAL_MS = 300_000;

function candle(index: number, high: number, low: number, close = 100): Candle {
  const openTime = START_MS + index * INTERVAL_MS;
  return {
    openTime,
    timestamp: openTime,
    open: close,
    high,
    low,
    close,
    volume: 1_000,
    buyVolume: 500,
    closeTime: openTime + INTERVAL_MS - 1,
  };
}

function pivotDataset(): Candle[] {
  return [
    candle(0, 101, 99),
    candle(1, 102, 98),
    candle(2, 105, 97),
    candle(3, 102, 98),
    candle(4, 101, 99),
    candle(5, 103, 98.5),
    candle(6, 101, 99),
  ];
}

const options = {
  lookbackBars: 20,
  pivotLeftBars: 2,
  pivotRightBars: 2,
  minStrength: 0,
  clusterToleranceBps: 1,
};

describe('MicroBurstSupportResistance causal timestamps', () => {
  it('does not expose a pivot before the right-confirmation candle closes', () => {
    const candles = pivotDataset();
    const beforeAvailable = candles[4].closeTime - 1;
    const result = detectSupportResistance(candles, { ...options, snapshotAtMs: beforeAvailable });
    expect(result.levels.some((level) => level.price === 105)).toBe(false);
  });

  it('exposes a pivot exactly at availableAtMs', () => {
    const candles = pivotDataset();
    const result = detectSupportResistance(candles, {
      ...options,
      snapshotAtMs: candles[4].closeTime,
    });
    const resistance = result.levels.find((level) => level.price === 105);
    expect(resistance).toMatchObject({
      pivotCandleIndex: 2,
      availableAtCandleIndex: 4,
      pivotAtMs: candles[2].closeTime,
      availableAtMs: candles[4].closeTime,
    });
  });

  it('keeps the pivot available after availableAtMs', () => {
    const candles = pivotDataset();
    const result = detectSupportResistance(candles, {
      ...options,
      snapshotAtMs: candles[6].closeTime,
    });
    expect(result.levels.some((level) => level.price === 105)).toBe(true);
  });

  it('ignores candles after snapshotAtMs', () => {
    const historical = pivotDataset();
    const snapshotAtMs = historical[6].closeTime;
    const future = [candle(7, 150, 50), candle(8, 151, 49), candle(9, 80, 20)];
    expect(
      detectSupportResistance([...historical, ...future], { ...options, snapshotAtMs }),
    ).toEqual(detectSupportResistance(historical, { ...options, snapshotAtMs }));
  });

  it('never stores an index in timestamp fields', () => {
    const candles = pivotDataset();
    const result = detectSupportResistance(candles, {
      ...options,
      snapshotAtMs: candles[6].closeTime,
    });
    for (const level of result.levels) {
      expect(level.pivotAtMs).toBeGreaterThan(1_000_000_000_000);
      expect(level.availableAtMs).toBeGreaterThanOrEqual(level.pivotAtMs);
      expect(level.availableAtMs).toBe(candles[level.availableAtCandleIndex].closeTime);
    }
  });
});
