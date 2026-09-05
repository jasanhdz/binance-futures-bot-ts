import type { Candle } from '../types';

/** Missing volume/timestamps are invalid data, not values to synthesize. */
export type CandleIntegrityInput = Pick<Candle, 'open' | 'high' | 'low' | 'close'> &
  Partial<Pick<Candle, 'volume' | 'openTime' | 'closeTime' | 'timestamp'>>;

/** Validate the original sequence; never sort, repair or silently remove a gap. */
export function validateCandleSequence(
  candles: readonly CandleIntegrityInput[],
  intervalMs: number,
): string | undefined {
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) return 'invalid_interval';
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (
      !c ||
      ![c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite) ||
      Math.min(c.open, c.high, c.low, c.close) <= 0 ||
      (c.volume ?? NaN) < 0 ||
      c.high < Math.max(c.open, c.close) ||
      c.low > Math.min(c.open, c.close)
    )
      return 'invalid_ohlcv';
    if (
      !Number.isSafeInteger(c.openTime) ||
      !Number.isSafeInteger(c.closeTime) ||
      (c.openTime ?? NaN) < 0 ||
      (c.closeTime ?? NaN) - (c.openTime ?? NaN) !== intervalMs - 1 ||
      (c.timestamp !== undefined && c.timestamp !== c.openTime)
    )
      return 'invalid_timestamp';
    if (i > 0 && (c.openTime ?? NaN) - (candles[i - 1].openTime ?? NaN) !== intervalMs)
      return 'invalid_cadence';
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
 * - Rejects the last candle if its age exceeds maxLastCandleAgeMs (data staleness).
 * - Rejects duplicate openTimes.
 * - Rejects the last candle if it appears incomplete (openTime equals the latest).
 *
 * @param candles Sorted by openTime ascending. Must be non-empty.
 * @param intervalMs Expected interval between candles (e.g. 60_000 for 1m).
 * @param nowMs Current wall-clock time in milliseconds.
 * @param options Freshness constraints.
 */
export function validateCandleFreshness(
  candles: readonly CandleIntegrityInput[],
  intervalMs: number,
  nowMs: number,
  options: {
    /** Maximum allowed age of the oldest candle relative to nowMs. Default: 24h. */
    maxAgeMs?: number;
    /** Maximum allowed age of the LAST candle relative to nowMs. Default: 30min. */
    maxLastCandleAgeMs?: number;
    /** Preserve consumers whose freshness limit is measured from the inclusive close. */
    ageReference?: 'OPEN_TIME' | 'CLOSE_TIME';
    /** Maximum allowed future offset for a candle timestamp. Default: 60s. */
    maxFutureSkewMs?: number;
    /** If true, treat the last candle as potentially incomplete. Default: true. */
    rejectIncompleteLast?: boolean;
  } = {},
): CandleFreshnessResult {
  const maxAgeMs = options.maxAgeMs ?? 24 * 60 * 60 * 1000;
  const maxLastCandleAgeMs = options.maxLastCandleAgeMs ?? 30 * 60 * 1000;
  const maxFutureSkewMs = options.maxFutureSkewMs ?? 60_000;
  const rejectIncomplete = options.rejectIncompleteLast ?? true;

  if (candles.length === 0) return { valid: false, reason: 'empty_candles' };
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0)
    return { valid: false, reason: 'invalid_interval' };
  if (!Number.isFinite(nowMs) || nowMs <= 0) return { valid: false, reason: 'invalid_clock' };
  if (
    [maxAgeMs, maxLastCandleAgeMs, maxFutureSkewMs].some(
      (value) => !Number.isFinite(value) || value < 0,
    )
  )
    return { valid: false, reason: 'invalid_freshness_limit' };

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (!c || !Number.isSafeInteger(c.openTime) || !Number.isSafeInteger(c.closeTime))
      return { valid: false, reason: 'invalid_timestamp', invalidIndex: i };

    // Future detection: candle openTime must not exceed now + skew.
    if (c.openTime! > nowMs + maxFutureSkewMs) {
      return { valid: false, reason: 'candle_in_future', invalidIndex: i };
    }

    // Staleness: oldest candle must be within maxAgeMs of nowMs.
    if (nowMs - c.openTime! > maxAgeMs) {
      return { valid: false, reason: 'candle_too_old', invalidIndex: i };
    }

    // Duplicate detection (compare with previous).
    if (i > 0 && c.openTime === candles[i - 1].openTime) {
      return { valid: false, reason: 'duplicate_open_time', invalidIndex: i };
    }
  }

  // Last candle freshness: data staleness check independent of history length.
  // Even if maxAgeMs is large (allowing long history), the latest candle must
  // be recent enough to be actionable for decisions.
  const lastCandle = candles[candles.length - 1];
  const lastCandleAge =
    nowMs - (options.ageReference === 'CLOSE_TIME' ? lastCandle.closeTime! : lastCandle.openTime!);
  if (lastCandleAge > maxLastCandleAgeMs) {
    return { valid: false, reason: 'last_candle_stale', invalidIndex: candles.length - 1 };
  }

  // Binance closeTime is inclusive; equality with the snapshot is already closed.
  if (rejectIncomplete && lastCandle.closeTime! > nowMs)
    return { valid: false, reason: 'last_candle_incomplete', invalidIndex: candles.length - 1 };

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
  if (
    ![primaryLatest, secondaryLatest].every((value) => Number.isSafeInteger(value) && value >= 0) ||
    !Number.isFinite(maxOffsetMs) ||
    maxOffsetMs < 0
  )
    return { valid: false, reason: 'invalid_timestamp_or_offset' };

  if (offset > maxOffsetMs) {
    return { valid: false, reason: 'cross_symbol_clock_drift' };
  }

  return { valid: true };
}

export interface DataQualityVerdict {
  valid: boolean;
  reasons: string[];
}

/** Validate the raw sequence before removing at most one currently forming tail. */
export function prepareClosedCandles<T extends CandleIntegrityInput>(
  candles: readonly T[],
  intervalMs: number,
  nowMs: number,
  maxLastCandleAgeMs: number,
): { candles: T[]; reasons: string[] } {
  const problem = validateCandleSequence(candles, intervalMs);
  if (problem) return { candles: [], reasons: [problem] };
  if (!Number.isFinite(nowMs) || nowMs <= 0) return { candles: [], reasons: ['invalid_clock'] };
  const firstOpen = candles.findIndex((c) => c.closeTime! > nowMs);
  if (firstOpen >= 0 && (firstOpen !== candles.length - 1 || candles[firstOpen].openTime! > nowMs))
    return { candles: [], reasons: ['candle_in_future'] };
  const closed = firstOpen < 0 ? [...candles] : candles.slice(0, -1);
  const quality = validateDataQuality(closed, intervalMs, nowMs, {
    maxAgeMs: Number.MAX_SAFE_INTEGER,
    maxLastCandleAgeMs,
    ageReference: 'CLOSE_TIME',
    maxFutureSkewMs: 0,
  });
  return { candles: quality.valid ? closed : [], reasons: quality.reasons };
}

/**
 * Combined data quality check: OHLCV integrity + freshness + completeness.
 * Intended to run BEFORE any indicator calculation.
 */
export function validateDataQuality(
  candles: readonly CandleIntegrityInput[],
  intervalMs: number,
  nowMs: number,
  options: {
    maxAgeMs?: number;
    maxLastCandleAgeMs?: number;
    ageReference?: 'OPEN_TIME' | 'CLOSE_TIME';
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
