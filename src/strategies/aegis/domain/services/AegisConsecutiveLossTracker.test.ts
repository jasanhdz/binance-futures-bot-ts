import { describe, expect, it } from 'vitest';
import { AegisConsecutiveLossTracker } from './AegisConsecutiveLossTracker';

describe('AegisConsecutiveLossTracker', () => {
  it('increments losses and resets after every profitable close reason', () => {
    const reasons = ['TIME_LIMIT', 'TRAILING_SAFETY_NET', 'EXIT_EYE', 'TAKE_PROFIT'];

    for (const reason of reasons) {
      const tracker = new AegisConsecutiveLossTracker();
      tracker.record(`${reason}-loss-1`, -1);
      tracker.record(`${reason}-loss-2`, -2);

      expect(tracker.record(`${reason}-profit`, 0.01).current).toBe(0);
    }
  });

  it('counts a confirmed close exactly once', () => {
    const tracker = new AegisConsecutiveLossTracker();

    expect(tracker.record('trade-1', -1)).toEqual({ applied: true, previous: 0, current: 1 });
    expect(tracker.record('trade-1', -1)).toEqual({ applied: false, previous: 1, current: 1 });
    expect(tracker.processedCount).toBe(1);
  });

  it('restores the streak chronologically from deduplicated outcomes', () => {
    const tracker = new AegisConsecutiveLossTracker();

    tracker.restore([
      { tradeId: 'profit', closedAt: '2026-07-27T01:00:00.000Z', pnlUsdt: 1 },
      { tradeId: 'loss-2', closedAt: '2026-07-27T03:00:00.000Z', pnlUsdt: -2 },
      { tradeId: 'loss-1', closedAt: '2026-07-27T02:00:00.000Z', pnlUsdt: -1 },
      { tradeId: 'loss-2', closedAt: '2026-07-27T03:00:00.000Z', pnlUsdt: -2 },
    ]);

    expect(tracker.value).toBe(2);
    expect(tracker.processedCount).toBe(3);
  });

  it('treats breakeven as non-loss and ignores invalid outcomes', () => {
    const tracker = new AegisConsecutiveLossTracker();
    tracker.record('loss', -1);

    expect(tracker.record('invalid', Number.NaN).applied).toBe(false);
    expect(tracker.record('breakeven', 0).current).toBe(0);
  });
});
