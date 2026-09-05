import type { Candle } from '../types';

/** Validate the original sequence; never sort, repair or silently remove a gap. */
export function validateCandleSequence(
  candles: readonly Candle[],
  intervalMs: number,
): string | undefined {
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) return 'invalid_interval';
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (
      ![c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite) ||
      Math.min(c.open, c.high, c.low, c.close) <= 0 ||
      c.volume < 0 ||
      c.high < Math.max(c.open, c.close) ||
      c.low > Math.min(c.open, c.close)
    )
      return 'invalid_ohlcv';
    if (
      !Number.isSafeInteger(c.openTime) ||
      !Number.isSafeInteger(c.closeTime) ||
      c.openTime < 0 ||
      c.closeTime - c.openTime !== intervalMs - 1 ||
      (c.timestamp !== undefined && c.timestamp !== c.openTime)
    )
      return 'invalid_timestamp';
    if (i > 0 && c.openTime - candles[i - 1].openTime !== intervalMs) return 'invalid_cadence';
  }
  return undefined;
}

export interface CandleFreshnessResult {
  valid: boolean;
  reason?: string;
  /** Index of the first invalid candle, or -1 if all valid. */
  invalidIndex?: number;
}

/**
 * Validate freshness and temporal consistency of candle data.
 * - Rejects candles with timestamps in the future (beyond clock skew tolerance).
 * - Rejects candles that are too old relative to the most recent candle.
 * - Rejects duplicate openTimes.
 * - Rejects the last candle if it appears incomplete (openTime equals the latest).
 *
 * @param candles Sorted by openTime ascending. Must be non-empty.
 * @param intervalMs Expected interval between candles (e.g. 60_000 for 1m).
 * @param nowMs Current wall-clock time in milliseconds.
 * @param options Freshness constraints.
 */
export function validateCandleFreshness(
  candles: readonly Candle[],
  intervalMs: number,
  nowMs: number,
  options: {
    /** Maximum allowed age of the oldest candle relative to nowMs. Default: 24h. */
    maxAgeMs?: number;
    /** Maximum allowed future offset for a candle timestamp. Default: 60s. */
    maxFutureSkewMs?: number;
    /** If true, treat the last candle as potentially incomplete. Default: true. */
    rejectIncompleteLast?: boolean;
  } = {},
): CandleFreshnessResult {
  const maxAgeMs = options.maxAgeMs ?? 24 * 60 * 60 * 1000;
  const maxFutureSkewMs = options.maxFutureSkewMs ?? 60_000;
  const rejectIncomplete = options.rejectIncompleteLast ?? true;

  if (candles.length === 0) return { valid: false, reason: 'empty_candles' };
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0)
    return { valid: false, reason: 'invalid_interval' };
  if (!Number.isFinite(nowMs) || nowMs <= 0) return { valid: false, reason: 'invalid_clock' };

  const latestOpenTime = candles[candles.length - 1].openTime;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];

    // Future detection: candle openTime must not exceed now + skew.
    if (c.openTime > nowMs + maxFutureSkewMs) {
      return { valid: false, reason: 'candle_in_future', invalidIndex: i };
    }

    // Staleness: oldest candle must be within maxAgeMs of nowMs.
    if (nowMs - c.openTime > maxAgeMs) {
      return { valid: false, reason: 'candle_too_old', invalidIndex: i };
    }

    // Duplicate detection (compare with previous).
    if (i > 0 && c.openTime === candles[i - 1].openTime) {
      return { valid: false, reason: 'duplicate_open_time', invalidIndex: i };
    }
  }

  // Incomplete last candle: if its openTime equals the latest, it may still be forming.
  if (rejectIncomplete && candles.length > 0) {
    const last = candles[candles.length - 1];
    const timeSinceLastOpen = nowMs - last.openTime;
    // A candle is likely incomplete if it opened less than one interval ago.
    if (timeSinceLastOpen < intervalMs) {
      return { valid: false, reason: 'last_candle_incomplete', invalidIndex: candles.length - 1 };
    }
  }

  return { valid: true };
}

export interface CrossSymbolConsistencyResult {
  valid: boolean;
  reason?: string;
}

/**
 * Validate temporal consistency between two symbol candle series.
 * Both must have been fetched at similar times and the clock offset
 * between the latest openTimes must not exceed a configurable threshold.
 */
export function validateCrossSymbolConsistency(
  primary: readonly Candle[],
  secondary: readonly Candle[],
  intervalMs: number,
  maxOffsetMs = 2 * 60 * 60,
): CrossSymbolConsistencyResult {
  if (primary.length === 0 || secondary.length === 0) {
    return { valid: false, reason: 'empty_series' };
  }
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    return { valid: false, reason: 'invalid_interval' };
  }

  const primaryLatest = primary[primary.length - 1].openTime;
  const secondaryLatest = secondary[secondary.length - 1].openTime;
  const offset = Math.abs(primaryLatest - secondaryLatest);

  if (offset > maxOffsetMs) {
    return { valid: false, reason: 'cross_symbol_clock_drift' };
  }

  return { valid: true };
}

export interface DataQualityVerdict {
  valid: boolean;
  reasons: string[];
}

/**
 * Combined data quality check: OHLCV integrity + freshness + completeness.
 * Intended to run BEFORE any indicator calculation.
 */
export function validateDataQuality(
  candles: readonly Candle[],
  intervalMs: number,
  nowMs: number,
  options: {
    maxAgeMs?: number;
    maxFutureSkewMs?: number;
    rejectIncompleteLast?: boolean;
    minCandles?: number;
  } = {},
): DataQualityVerdict {
  const minCandles = options.minCandles ?? 1;
  const reasons: string[] = [];

  const integrity = validateCandleSequence(candles, intervalMs);
  if (integrity) reasons.push(integrity);

  const freshness = validateCandleFreshness(candles, intervalMs, nowMs, options);
  if (!freshness.valid && freshness.reason) reasons.push(freshness.reason);

  if (candles.length < minCandles) reasons.push('insufficient_candles');

  return { valid: reasons.length === 0, reasons };
}
