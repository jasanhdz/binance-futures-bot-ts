import { Candle } from '../types';

/**
 * Calculates the Average True Range (ATR) over a given period.
 * Uses Wilder's Smoothing Method (standard for ATR).
 *
 * @param candles Most recent candles, perfectly sorted oldest to newest.
 * @param period Number of periods for ATR (default 14).
 * @returns The final ATR value, or null if insufficient data.
 */
export function calculateATR(candles: Candle[], period: number = 14): number | null {
  if (candles.length < period + 1) {
    return null;
  }

  const trValues: number[] = [];

  // 1. Calculate True Range (TR) for all possible candles
  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];

    const tr1 = current.high - current.low;
    const tr2 = Math.abs(current.high - previous.close);
    const tr3 = Math.abs(current.low - previous.close);

    trValues.push(Math.max(tr1, tr2, tr3));
  }

  if (trValues.length < period) return null;

  // 2. First ATR is just the simple average of the first N TRs
  let atr = 0;
  for (let i = 0; i < period; i++) {
    atr += trValues[i];
  }
  atr = atr / period;

  // 3. Smooth subsequent TRs using Wilder's smoothing
  for (let i = period; i < trValues.length; i++) {
    atr = (atr * (period - 1) + trValues[i]) / period;
  }

  return atr;
}
