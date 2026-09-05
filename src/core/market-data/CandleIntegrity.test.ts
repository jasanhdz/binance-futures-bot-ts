import { describe, expect, it } from 'vitest';
import {
  validateCandleSequence,
  validateCandleFreshness,
  validateCrossSymbolConsistency,
  validateDataQuality,
} from './CandleIntegrity';
import type { Candle } from '../types';

const make = (openTimeMs: number): Candle => ({
  openTime: openTimeMs,
  closeTime: openTimeMs + 60_000 - 1,
  timestamp: openTimeMs,
  open: 100,
  high: 102,
  low: 99,
  close: 101,
  volume: 10,
  buyVolume: 5,
});

describe('candle integrity', () => {
  it('accepts contiguous original candles', () =>
    expect(validateCandleSequence([make(0), make(60_000)], 60_000)).toBeUndefined());
  it.each([
    [[make(0), make(120_000)], 'invalid_cadence'],
    [[make(0), make(0)], 'invalid_cadence'],
    [[make(60_000), make(0)], 'invalid_cadence'],
    [[{ ...make(0), volume: -1 }], 'invalid_ohlcv'],
    [[{ ...make(0), close: NaN }], 'invalid_ohlcv'],
    [[{ ...make(0), high: 98 }], 'invalid_ohlcv'],
    [[{ ...make(0), timestamp: 5 }], 'invalid_timestamp'],
    [[{ ...make(0), closeTime: 1 }], 'invalid_timestamp'],
  ] as [Candle[], string][])('rejects defective input %#', (candles, reason) => {
    expect(validateCandleSequence(candles, 60_000)).toBe(reason);
  });
});

describe('candle freshness', () => {
  const nowMs = 1_700_000_000_000;
  const intervalMs = 60_000;

  it('accepts fresh contiguous candles', () => {
    const candles = [make(nowMs - 120_000), make(nowMs - 60_000)];
    expect(validateCandleFreshness(candles, intervalMs, nowMs)).toEqual({ valid: true });
  });

  it('rejects empty candles', () => {
    expect(validateCandleFreshness([], intervalMs, nowMs)).toEqual({
      valid: false,
      reason: 'empty_candles',
    });
  });

  it('rejects candle with future timestamp', () => {
    const future = make(nowMs + 300_000);
    const candles = [make(nowMs - 60_000), future];
    const result = validateCandleFreshness(candles, intervalMs, nowMs);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('candle_in_future');
    expect(result.invalidIndex).toBe(1);
  });

  it('allows candle within future skew tolerance', () => {
    const withinTolerance = make(nowMs + 30_000);
    const candles = [make(nowMs - 60_000), withinTolerance];
    expect(
      validateCandleFreshness(candles, intervalMs, nowMs, {
        maxFutureSkewMs: 60_000,
        rejectIncompleteLast: false,
      }),
    ).toEqual({ valid: true });
  });

  it('rejects candle that is too old', () => {
    const old = make(nowMs - 48 * 60 * 60 * 1000);
    const candles = [old, make(nowMs - 60_000)];
    const result = validateCandleFreshness(candles, intervalMs, nowMs, { maxAgeMs: 24 * 60 * 60 * 1000 });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('candle_too_old');
    expect(result.invalidIndex).toBe(0);
  });

  it('rejects duplicate openTime', () => {
    const base = nowMs - 60_000;
    const candles = [make(base), make(base)];
    const result = validateCandleFreshness(candles, intervalMs, nowMs);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('duplicate_open_time');
    expect(result.invalidIndex).toBe(1);
  });

  it('rejects last candle if incomplete (opened less than one interval ago)', () => {
    const lastOpen = nowMs - 30_000;
    const candles = [make(nowMs - 90_000), { ...make(lastOpen / 60_000), openTime: lastOpen, closeTime: lastOpen + 59_999 }];
    const result = validateCandleFreshness(candles, intervalMs, nowMs);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('last_candle_incomplete');
  });

  it('accepts last candle when rejectIncompleteLast is false', () => {
    const lastOpen = nowMs - 30_000;
    const candles = [make(nowMs - 90_000), { ...make(lastOpen / 60_000), openTime: lastOpen, closeTime: lastOpen + 59_999 }];
    expect(
      validateCandleFreshness(candles, intervalMs, nowMs, { rejectIncompleteLast: false }),
    ).toEqual({ valid: true });
  });

  it('rejects invalid clock', () => {
    expect(validateCandleFreshness([make(0)], intervalMs, NaN)).toEqual({
      valid: false,
      reason: 'invalid_clock',
    });
  });
});

describe('cross-symbol consistency', () => {
  const intervalMs = 60_000;
  const nowMs = 1_700_000_000_000;

  it('accepts aligned candle series', () => {
    const base = nowMs - 120_000;
    const a = [make(base), make(base + 60_000)];
    const b = [make(base), make(base + 60_000)];
    expect(validateCrossSymbolConsistency(a, b, intervalMs)).toEqual({ valid: true });
  });

  it('rejects empty series', () => {
    expect(validateCrossSymbolConsistency([], [make(nowMs - 60_000)], intervalMs)).toEqual({
      valid: false,
      reason: 'empty_series',
    });
  });

  it('rejects when clock drift exceeds threshold', () => {
    const a = [make(1_700_000_000_000)];
    const b = [make(1_700_000_500_000)];
    expect(validateCrossSymbolConsistency(a, b, intervalMs, 300_000)).toEqual({
      valid: false,
      reason: 'cross_symbol_clock_drift',
    });
  });
});

describe('data quality (combined)', () => {
  const nowMs = 1_700_000_000_000;
  const intervalMs = 60_000;

  it('returns valid for healthy candles', () => {
    const candles = [make(nowMs - 120_000), make(nowMs - 60_000)];
    expect(validateDataQuality(candles, intervalMs, nowMs)).toEqual({ valid: true, reasons: [] });
  });

  it('collects multiple failure reasons', () => {
    const bad = { ...make(0), close: NaN, volume: -1, openTime: nowMs + 900_000, closeTime: nowMs + 960_000 - 1, timestamp: nowMs + 900_000 };
    const result = validateDataQuality([bad], intervalMs, nowMs, { minCandles: 3 });
    expect(result.valid).toBe(false);
    expect(result.reasons.length).toBeGreaterThanOrEqual(2);
    expect(result.reasons).toContain('invalid_ohlcv');
    expect(result.reasons).toContain('insufficient_candles');
  });

  it('rejects when minCandles not met', () => {
    const candles = [make(nowMs - 60_000)];
    const result = validateDataQuality(candles, intervalMs, nowMs, { minCandles: 10 });
    expect(result.valid).toBe(false);
    expect(result.reasons).toContain('insufficient_candles');
  });
});
