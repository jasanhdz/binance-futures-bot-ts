import { describe, expect, it } from 'vitest';
import { ConsecutiveLossTracker } from './ConsecutiveLossTracker';

describe('ConsecutiveLossTracker', () => {
  it('tracks losses, resets on profit, and ignores duplicate trade IDs', () => {
    const tracker = new ConsecutiveLossTracker();
    expect(tracker.record('loss-1', -1)).toEqual({ applied: true, previous: 0, current: 1 });
    expect(tracker.record('loss-2', -2).current).toBe(2);
    expect(tracker.record('loss-2', -2)).toEqual({ applied: false, previous: 2, current: 2 });
    expect(tracker.record('profit', 0).current).toBe(0);
    expect(tracker.processedCount).toBe(3);
  });

  it('reconstructs deterministically and restores a persisted value without policy', () => {
    const tracker = new ConsecutiveLossTracker();
    tracker.restore([
      { tradeId: 'late-loss', closedAt: '2026-08-26T03:00:00.000Z', pnlUsdt: -2 },
      { tradeId: 'early-profit', closedAt: '2026-08-26T01:00:00.000Z', pnlUsdt: 1 },
      { tradeId: 'early-loss', closedAt: '2026-08-26T02:00:00.000Z', pnlUsdt: -1 },
      { tradeId: 'late-loss', closedAt: '2026-08-26T03:00:00.000Z', pnlUsdt: -2 },
    ]);
    expect(tracker.value).toBe(2);
    expect(tracker.processedCount).toBe(3);

    tracker.restorePersistedValue(4);
    expect(tracker.value).toBe(4);
    expect(tracker.processedCount).toBe(0);
  });

  it('fails closed for invalid persisted values and malformed outcomes', () => {
    const tracker = new ConsecutiveLossTracker();
    expect(() => tracker.restorePersistedValue(-1)).toThrow('CONSECUTIVE_LOSS_VALUE_INVALID');
    expect(tracker.record('', Number.NaN)).toEqual({ applied: false, previous: 0, current: 0 });
  });
});
