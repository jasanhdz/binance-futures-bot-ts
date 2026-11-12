import { describe, expect, it } from 'vitest';
import { LocalCausalSequence } from './LocalCausalWatermark';

describe('process-local causal watermarks', () => {
  it('orders equal exchange timestamps and local wall-clock regressions by receive sequence', () => {
    let monotonic = 10;
    const sequence = new LocalCausalSequence('process-one', () => monotonic++);
    const first = sequence.receive(1);
    const second = sequence.receive(1);
    const reconnected = sequence.receive(2);

    expect([first.receiveSequence, second.receiveSequence, reconnected.receiveSequence]).toEqual([
      1, 2, 3,
    ]);
    expect([
      first.connectionGeneration,
      second.connectionGeneration,
      reconnected.connectionGeneration,
    ]).toEqual([1, 1, 2]);
    expect(reconnected.processGenerationId).toBe(first.processGenerationId);
    expect(reconnected.receivedMonotonicAtMs).toBeGreaterThan(second.receivedMonotonicAtMs);
  });

  it('starts a separate receive-sequence domain after process restart', () => {
    const beforeRestart = new LocalCausalSequence('process-before-restart', () => 5);
    const oldEvent = beforeRestart.receive(1);
    const afterRestart = new LocalCausalSequence('process-after-restart', () => 1);
    const newEvent = afterRestart.receive(1);

    expect(oldEvent.receiveSequence).toBe(1);
    expect(newEvent.receiveSequence).toBe(1);
    expect(newEvent.processGenerationId).not.toBe(oldEvent.processGenerationId);
  });
});
