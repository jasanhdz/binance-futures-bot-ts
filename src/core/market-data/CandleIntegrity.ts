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
