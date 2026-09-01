import { beforeEach, describe, expect, it } from 'vitest';
import {
  getRateLimitMetrics,
  isRateLimited,
  noteRateLimitBlockedRequest,
  noteRateLimitFromError,
  noteRateLimitUntil,
  parseRateLimitError,
  resetRateLimitStateForTests,
} from './rate-limit';

describe('Binance rate-limit state', () => {
  beforeEach(() => resetRateLimitStateForTests());

  it('parses HTTP status from SDK and raw fetch errors', () => {
    expect(parseRateLimitError({ response: { status: 429 } }, 1_000)).toMatchObject({
      status: 429,
      banUntil: 61_000,
    });
    expect(parseRateLimitError(new Error('Algo Order failed: 418 banned until 65000'), 1_000)).toMatchObject({
      status: 418,
      banUntil: 65_000,
    });
  });

  it('honors retry-after seconds and absolute timestamps', () => {
    expect(parseRateLimitError({ status: 429, retryAfter: '2' }, 1_000)?.retryAfterMs).toBe(2_000);
    expect(parseRateLimitError({ status: 429, retryAfter: 7_000 }, 1_000)?.retryAfterMs).toBe(6_000);
  });

  it('opens a shared cooldown and blocks callers until it expires', () => {
    noteRateLimitUntil(10_000);
    expect(isRateLimited(9_999)).toBe(true);
    noteRateLimitBlockedRequest();
    expect(getRateLimitMetrics()).toMatchObject({
      banUntil: 10_000,
      cooldownBlockedRequests: 1,
    });
    expect(isRateLimited(10_000)).toBe(false);
  });

  it('extends but never shortens the circuit cooldown', () => {
    noteRateLimitUntil(10_000);
    noteRateLimitUntil(5_000);
    noteRateLimitUntil(12_000);
    expect(getRateLimitMetrics().banUntil).toBe(12_000);
  });

  it('records circuit activations and rate-limit events', () => {
    noteRateLimitFromError({ status: 429, retryAfter: '1' });
    noteRateLimitFromError({ status: 418, retryAfter: '2' });
    expect(getRateLimitMetrics()).toMatchObject({
      rateLimitEvents: 2,
      circuitBreakerActivations: 1,
      lastStatus: 418,
    });
  });

  it('recovers after the cooldown without clearing a newer ban', () => {
    noteRateLimitUntil(2_000);
    expect(isRateLimited(2_001)).toBe(false);
    noteRateLimitUntil(5_000);
    expect(isRateLimited(4_999)).toBe(true);
    expect(isRateLimited(5_000)).toBe(false);
  });
});
