import type { MicroBurstConfig } from './MicroBurstTypes';

/** A local receive clock is never subtracted from an exchange event timestamp. */
export function isMicroInputFresh(eventAt: unknown, now: unknown, maxAge: number): boolean {
  return (
    typeof eventAt === 'number' &&
    typeof now === 'number' &&
    Number.isFinite(eventAt) &&
    Number.isFinite(now) &&
    eventAt >= 0 &&
    eventAt <= now &&
    Number.isFinite(maxAge) &&
    maxAge >= 0 &&
    now - eventAt <= maxAge
  );
}

export interface MicroBurstInputFreshness {
  schemaVersion: 1;
  signalAsOfMs: number;
  localDecisionAtMs: number;
  exchangeDecisionAtMs: number;
  candleCloseTimeMs: number;
  btcEventAtMs: number;
  flowEventAtMs: number;
  bookReceivedAtMs: number;
}

/** Compact original-input proof; no refreshed source can renew the consumed inputs. */
export function validateMicroBurstInputFreshness(
  value: unknown,
  localNow: number,
  config: MicroBurstConfig,
): string | undefined {
  if (!value || typeof value !== 'object') return 'MICRO_INPUT_FRESHNESS_MISSING';
  const proof = value as MicroBurstInputFreshness;
  if (
    proof.schemaVersion !== 1 ||
    !isMicroInputFresh(proof.localDecisionAtMs, localNow, config.bookFreshnessMaxMs) ||
    !isMicroInputFresh(proof.signalAsOfMs, proof.exchangeDecisionAtMs, config.bookFreshnessMaxMs)
  )
    return 'MICRO_SIGNAL_EXPIRED';
  const exchangeNow = proof.exchangeDecisionAtMs + localNow - proof.localDecisionAtMs;
  if (
    !isMicroInputFresh(
      proof.candleCloseTimeMs,
      proof.signalAsOfMs,
      config.candleFreshness1mMaxMs,
    ) ||
    !isMicroInputFresh(proof.candleCloseTimeMs, exchangeNow, config.candleFreshness1mMaxMs)
  )
    return 'MICRO_CANDLE_STALE';
  if (!isMicroInputFresh(proof.btcEventAtMs, exchangeNow, config.btcFreshnessMaxMs))
    return 'MICRO_BTC_STALE';
  if (!isMicroInputFresh(proof.flowEventAtMs, exchangeNow, config.bookFreshnessMaxMs))
    return 'MICRO_FLOW_STALE';
  if (!isMicroInputFresh(proof.bookReceivedAtMs, localNow, config.bookFreshnessMaxMs))
    return 'MICRO_ORIGINAL_BOOK_STALE';
  return undefined;
}
