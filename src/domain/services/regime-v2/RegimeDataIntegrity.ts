import { RegimeEngineV2InputCandle } from './RegimeEngineV2.types';

export const REGIME_CANDLE_MS = 300_000;

export function candleTime(candle: RegimeEngineV2InputCandle): number {
  return candle?.timestamp ?? candle?.openTime ?? NaN;
}

/** Validate in arrival order. Never sort, delete or replace observations silently. */
export function validateRegimeCandles(candles: RegimeEngineV2InputCandle[]): string | undefined {
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (
      !c ||
      ![c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite) ||
      c.low <= 0 ||
      c.open <= 0 ||
      c.close <= 0 ||
      c.volume < 0 ||
      c.high < Math.max(c.open, c.close) ||
      c.low > Math.min(c.open, c.close)
    ) {
      return 'invalid_candle_ohlcv';
    }
    const time = candleTime(c);
    if (
      !Number.isSafeInteger(time) ||
      time < 0 ||
      !Number.isFinite(new Date(time).getTime()) ||
      (c.timestamp !== undefined && c.openTime !== undefined && c.timestamp !== c.openTime)
    ) {
      return 'invalid_candle_timestamp';
    }
    if (i > 0 && time - candleTime(candles[i - 1]) !== REGIME_CANDLE_MS) {
      return 'invalid_candle_timeline';
    }
  }
  return undefined;
}
