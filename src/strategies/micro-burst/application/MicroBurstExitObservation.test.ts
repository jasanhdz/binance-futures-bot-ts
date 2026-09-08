import { describe, expect, it, vi } from 'vitest';
import {
  MicroBurstExitObservation,
  type MicroBurstExitObservationRecord,
} from './MicroBurstExitObservation';
import { createMicroBurstV1Identity } from '../domain/MicroBurstIdentity';

function record(): MicroBurstExitObservationRecord {
  return {
    schemaVersion: 1,
    authority: 'OBSERVATION_ONLY',
    identity: createMicroBurstV1Identity(),
    symbol: 'ETHUSDT',
    tradeId: 'micro-test',
    decisionId: 'decision-test',
    observedAtMs: 1000,
    phase: 'DECISION',
    decision: { action: 'HOLD', reason: 'HOLD', diagnostics: {} },
    context: null,
    actionApplied: null,
    applicationStatus: 'NOT_ATTEMPTED',
    realizedNetPnl: null,
  };
}
describe('Micro bounded exit observation', () => {
  it('drains pending records and seals admission', async () => {
    const append = vi.fn();
    const observer = new MicroBurstExitObservation({ append });
    observer.observe(record());
    await observer.close();
    expect(observer.health()).toMatchObject({ pending: 0, written: 1, closed: true });
    observer.observe(record());
    expect(append).toHaveBeenCalledOnce();
    expect(observer.health().dropped).toBe(1);
  });
  it('reports a stuck sink at shutdown without reporting a successful drain', async () => {
    const observer = new MicroBurstExitObservation({ append: () => new Promise(() => {}) });
    observer.observe(record());
    await expect(observer.close(1)).rejects.toThrow('MICRO_EXIT_OBSERVER_DRAIN_TIMEOUT');
    expect(observer.health()).toMatchObject({ pending: 1, closed: true });
  });
  it('preserves data loss as a shutdown failure', async () => {
    const observer = new MicroBurstExitObservation({
      append: () => Promise.reject(new Error('disk')),
    });
    observer.observe(record());
    await expect(observer.close()).rejects.toThrow('MICRO_EXIT_OBSERVER_DATA_INCOMPLETE');
    await expect(observer.close()).rejects.toThrow('MICRO_EXIT_OBSERVER_DATA_INCOMPLETE');
  });
  it('isolates synchronous and asynchronous sink failures', async () => {
    for (const append of [
      () => {
        throw new Error('disk');
      },
      () => Promise.reject(new Error('disk')),
    ]) {
      const observer = new MicroBurstExitObservation({ append });
      expect(() => observer.observe(record())).not.toThrow();
      await vi.waitFor(() => expect(observer.health()).toMatchObject({ pending: 0, failed: 1 }));
    }
  });
  it('bounds a stalled sink rather than delaying risk or accumulating an unbounded queue', () => {
    const observer = new MicroBurstExitObservation({ append: () => new Promise(() => {}) });
    for (let i = 0; i < 100; i++) observer.observe(record());
    expect(observer.health()).toMatchObject({ pending: 64, dropped: 36 });
  });
  it('snapshots identity and decision without claiming actual fills', async () => {
    const append = vi.fn();
    const observer = new MicroBurstExitObservation({ append });
    const input = record();
    observer.observe(input);
    input.identity.codeCommitSha = 'changed';
    input.decision.diagnostics.mutated = true;
    await vi.waitFor(() => expect(append).toHaveBeenCalledOnce());
    expect(append.mock.calls[0][0]).toMatchObject({
      realizedNetPnl: null,
      identity: { codeCommitSha: 'UNKNOWN' },
      decision: { diagnostics: {} },
    });
  });
});
