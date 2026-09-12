import { describe, expect, it } from 'vitest';
import { validateMicroBurstInputFreshness } from './MicroBurstInputFreshness';
import { defaultMicroBurstConfig } from './MicroBurstTypes';

const config = defaultMicroBurstConfig();
const now = 1_700_000_000_000;
const proof = {
  schemaVersion: 1,
  signalAsOfMs: now,
  localDecisionAtMs: now + 5000,
  exchangeDecisionAtMs: now,
  candleCloseTimeMs: now - config.candleFreshness1mMaxMs + 100,
  btcEventAtMs: now,
  flowEventAtMs: now,
  bookReceivedAtMs: now + 5000,
};
describe('original consumed-input send proof', () => {
  it.each([99, 100, 101])('checks candle at send boundary %s without mixed clocks', (elapsed) => {
    expect(validateMicroBurstInputFreshness(proof, now + 5000 + elapsed, config)).toBe(
      elapsed <= 100 ? undefined : 'MICRO_CANDLE_STALE',
    );
  });
  it.each(['btcEventAtMs', 'flowEventAtMs', 'bookReceivedAtMs'] as const)(
    'does not renew original %s',
    (field) => {
      const reason = {
        btcEventAtMs: 'MICRO_BTC_STALE',
        flowEventAtMs: 'MICRO_FLOW_STALE',
        bookReceivedAtMs: 'MICRO_ORIGINAL_BOOK_STALE',
      }[field];
      expect(validateMicroBurstInputFreshness({ ...proof, [field]: 0 }, now + 5000, config)).toBe(
        reason,
      );
    },
  );
  it.each([undefined, NaN, Infinity, -1, now + 1])(
    'fails closed for invalid/future candle %s',
    (value) => {
      expect(
        validateMicroBurstInputFreshness(
          { ...proof, candleCloseTimeMs: value },
          now + 5000,
          config,
        ),
      ).toBe('MICRO_CANDLE_STALE');
    },
  );
  it('requires proof and rejects local clock reversal', () => {
    expect(validateMicroBurstInputFreshness(undefined, now, config)).toBe(
      'MICRO_INPUT_FRESHNESS_MISSING',
    );
    expect(validateMicroBurstInputFreshness(proof, now, config)).toBe('MICRO_SIGNAL_EXPIRED');
  });
});
