import { describe, expect, it } from 'vitest';
import { validateCandleSequence } from './CandleIntegrity';
import type { Candle } from '../types';

const make = (i: number): Candle => ({
  openTime: i * 60_000,
  closeTime: (i + 1) * 60_000 - 1,
  timestamp: i * 60_000,
  open: 100,
  high: 102,
  low: 99,
  close: 101,
  volume: 10,
  buyVolume: 5,
});
describe('candle integrity', () => {
  it('accepts contiguous original candles', () =>
    expect(validateCandleSequence([make(0), make(1)], 60_000)).toBeUndefined());
  it.each([
    [[make(0), make(2)], 'invalid_cadence'],
    [[make(0), make(0)], 'invalid_cadence'],
    [[make(1), make(0)], 'invalid_cadence'],
    [[{ ...make(0), volume: -1 }], 'invalid_ohlcv'],
    [[{ ...make(0), close: NaN }], 'invalid_ohlcv'],
    [[{ ...make(0), high: 98 }], 'invalid_ohlcv'],
    [[{ ...make(0), timestamp: 5 }], 'invalid_timestamp'],
    [[{ ...make(0), closeTime: 1 }], 'invalid_timestamp'],
  ] as [Candle[], string][])('rejects defective input %#', (candles, reason) => {
    expect(validateCandleSequence(candles, 60_000)).toBe(reason);
  });
});
