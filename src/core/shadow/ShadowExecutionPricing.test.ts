import { describe, expect, it } from 'vitest';
import { executableEntryPrice, executableExitPrice } from './ShadowExecutionPricing';

describe('shadow execution pricing', () => {
  const quote = { bestBid: 99, bestAsk: 101, observedAtMs: 10, status: 'HEALTHY' as const };
  it('uses ask for long and bid for short entries', () => {
    expect(executableEntryPrice('LONG', quote, 10)).toBe(101);
    expect(executableEntryPrice('SHORT', quote, 10)).toBe(99);
  });
  it('uses the opposite side for exits and rejects future quotes', () => {
    expect(executableExitPrice('LONG', quote, 10)).toBe(99);
    expect(executableExitPrice('SHORT', quote, 10)).toBe(101);
    expect(executableExitPrice('LONG', quote, 9)).toBeUndefined();
  });

  it('rejects malformed or crossed quotes', () => {
    expect(executableEntryPrice('LONG', { ...quote, bestBid: Number.NaN }, 10)).toBeUndefined();
    expect(executableEntryPrice('LONG', { ...quote, bestAsk: 99 }, 10)).toBeUndefined();
    expect(executableExitPrice('SHORT', { ...quote, bestAsk: Infinity }, 10)).toBeUndefined();
  });
});
