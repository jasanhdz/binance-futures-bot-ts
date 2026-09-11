import { describe, expect, it, vi } from 'vitest';
import { BoundedObservationQueue, copyObservation } from './BoundedObservationQueue';

const limits = { maxRecords: 2, maxBytes: 4096, maxNodes: 100, maxDepth: 10 };

describe('bounded observational evidence', () => {
  it('retains immutable nested values after shared buffers are mutated', async () => {
    const records: unknown[] = [];
    const queue = new BoundedObservationQueue(limits, async (record) => {
      records.push(record);
    });
    const input = { candles: [{ close: 100 }], book: { bids: [[99, 2]] } };
    expect(queue.enqueue(input)).toBe('QUEUED');
    input.candles[0].close = 300;
    input.book.bids[0][0] = 400;
    await queue.close();
    expect(records).toEqual([{ candles: [{ close: 100 }], book: { bids: [[99, 2]] } }]);
    expect(Object.isFrozen((records[0] as typeof input).book.bids[0])).toBe(true);
  });

  it('counts in-flight records and bytes, drops overflow, and drains on shutdown', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let clock = 10;
    const write = vi.fn(async () => {
      await blocked;
    });
    const queue = new BoundedObservationQueue(limits, write, () => clock);
    queue.enqueue({ id: 1 });
    await Promise.resolve();
    queue.enqueue({ id: 2 });
    expect(queue.enqueue({ id: 3 })).toBe('OBSERVATIONAL_DROP');
    expect(queue.health().pendingRecords).toBe(2);
    expect(queue.health().pendingBytes).toBeGreaterThan(0);
    const closing = queue.close();
    expect(queue.enqueue({ id: 4 })).toBe('OBSERVATIONAL_DROP');
    clock = 35;
    release();
    await closing;
    expect(write).toHaveBeenCalledTimes(2);
    expect(queue.health()).toMatchObject({
      pendingRecords: 0,
      pendingBytes: 0,
      written: 2,
      dropped: 2,
      closed: true,
      lastQueueWaitMs: 25,
    });
  });

  it('rejects oversized values before invoking the writer', async () => {
    const write = vi.fn(async () => {});
    const queue = new BoundedObservationQueue(limits, write);
    expect(queue.enqueue({ text: 'x'.repeat(4096) })).toBe('OBSERVATIONAL_DROP');
    await queue.close();
    expect(write).not.toHaveBeenCalled();
    expect(queue.health().peakBytes).toBe(0);
  });

  it('isolates writer errors and continues with the next record', async () => {
    const write = vi.fn().mockRejectedValueOnce(new Error('disk')).mockResolvedValueOnce(undefined);
    const queue = new BoundedObservationQueue(limits, write);
    queue.enqueue(1);
    queue.enqueue(2);
    await queue.close();
    expect(queue.health()).toMatchObject({ failed: 1, written: 1, pendingBytes: 0 });
  });
  it('caps aggregate bytes before the record cap and accounts for a timed-out in-flight writer', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queue = new BoundedObservationQueue(
      { ...limits, maxRecords: 10, maxBytes: 200 },
      async () => blocked,
    );
    expect(queue.enqueue('1234567890')).toBe('QUEUED');
    expect(queue.enqueue('1234567890')).toBe('QUEUED');
    expect(queue.enqueue('1234567890')).toBe('OBSERVATIONAL_DROP');
    await Promise.resolve();
    await queue.close(0);
    expect(queue.health()).toMatchObject({
      drainTimedOut: true,
      pendingRecords: 1,
      pendingBytes: 92,
      dropped: 2,
    });
    release();
    await queue.close();
    expect(queue.health()).toMatchObject({ pendingRecords: 0, pendingBytes: 0, written: 1 });
  });
  it('reuses only internally verified deep-frozen trees with full byte accounting', () => {
    const first = copyObservation({ array: [{ value: 1 }] }, limits);
    const reused = copyObservation(first.value, limits);
    expect(reused.value).toBe(first.value);
    expect(reused.bytes).toBe(first.bytes);
    const shallow = Object.freeze({ nested: { value: 1 } });
    const detached = copyObservation(shallow, limits).value;
    shallow.nested.value = 2;
    expect(detached.nested.value).toBe(1);
    expect(() => copyObservation(first.value, { ...limits, maxBytes: first.bytes - 1 })).toThrow();
  });

  it('bounds nesting and nodes and rejects cycles and accessors without invoking them', () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => copyObservation(cycle, limits)).toThrow('OBSERVATION_CYCLE');
    expect(() => copyObservation(new Array(50), limits)).toThrow('OBSERVATION_SPARSE_ARRAY');
    expect(() => copyObservation(new Array(1_000_000_000), limits)).toThrow(
      'OBSERVATION_COMPLEXITY_EXCEEDED',
    );
    expect(() =>
      copyObservation(
        Array.from({ length: 101 }, () => 1),
        limits,
      ),
    ).toThrow();
    const getter = vi.fn();
    expect(() =>
      copyObservation(Object.defineProperty({}, 'x', { get: getter, enumerable: true }), limits),
    ).toThrow('OBSERVATION_ACCESSOR');
    expect(getter).not.toHaveBeenCalled();
    expect(() => copyObservation({ a: { b: 1 } }, { ...limits, maxDepth: 1 })).toThrow();
  });
});
