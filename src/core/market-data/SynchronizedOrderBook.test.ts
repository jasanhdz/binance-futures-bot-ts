import { describe, expect, it, vi } from 'vitest';
import { SynchronizedOrderBook } from './SynchronizedOrderBook';
import { LocalCausalSequence } from './LocalCausalWatermark';

describe('shared synchronized order book', () => {
  it('exposes a neutral read-only snapshot after the USD-M bridge', async () => {
    let emit: ((event: any) => void) | undefined;
    const clock = { now: vi.fn(() => 1_700_000_000_000) };
    const book = new SynchronizedOrderBook('ETHUSDT', {
      snapshotSource: {
        getSnapshot: vi.fn(async () => ({
          lastUpdateId: 100,
          bids: [['100', '10'] as [string, string]],
          asks: [['101', '10'] as [string, string]],
          receivedAtMs: clock.now(),
        })),
      },
      diffSource: {
        onDiff: vi.fn((_symbol, callback) => {
          emit = callback;
          return () => {
            emit = undefined;
          };
        }),
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      clock,
    });

    book.start();
    emit?.({
      U: 100,
      u: 101,
      pu: 99,
      bids: [['100', '12']],
      asks: [],
      E: 1_700_000_000_001,
      T: 1_700_000_000_001,
      receivedAtMs: 1_700_000_000_001,
    });

    await vi.waitFor(() => expect(book.getHealth()).toBe('HEALTHY'));
    expect(book.getSnapshot()).toEqual(
      expect.objectContaining({
        bidDepth: [{ price: 100, qty: 12 }],
        askDepth: [{ price: 101, qty: 10 }],
        status: 'HEALTHY',
      }),
    );
    book.stop();
  });

  it('preserves exchange and wall-clock regressions while exposing applied local sequence state', async () => {
    let emit: ((event: any) => void) | undefined;
    let now = 1_000;
    const causal = new LocalCausalSequence('runtime-a', () => now++);
    const clock = { now: vi.fn(() => 1_000) };
    const book = new SynchronizedOrderBook('ETHUSDT', {
      snapshotSource: {
        getSnapshot: vi.fn(async () => ({
          lastUpdateId: 100,
          bids: [['100', '10'] as [string, string]],
          asks: [['101', '10'] as [string, string]],
          receivedAtMs: 1_000,
        })),
      },
      diffSource: {
        onDiff: vi.fn((_symbol, callback) => {
          emit = callback;
          return () => {
            emit = undefined;
          };
        }),
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      clock,
    });
    book.start();
    emit?.({
      U: 100,
      u: 101,
      pu: 99,
      bids: [['100', '11']],
      asks: [],
      E: 1_000,
      T: 1_000,
      receivedAtMs: 1_000,
      localCausality: causal.receive(1),
    });
    emit?.({
      U: 102,
      u: 102,
      pu: 101,
      bids: [['100', '12']],
      asks: [],
      E: 900,
      T: 900,
      receivedAtMs: 900,
      localCausality: causal.receive(1),
    });
    emit?.({
      U: 103,
      u: 103,
      pu: 102,
      bids: [['100', '13']],
      asks: [],
      E: 800,
      T: 800,
      receivedAtMs: 900,
      localCausality: causal.receive(2),
    });

    await vi.waitFor(() => expect(book.getHealth()).toBe('HEALTHY'));
    expect(book.getState().observedAtMs).toBe(900);
    expect(book.getSnapshot()?.localCausality).toMatchObject({
      processGenerationId: 'runtime-a',
      connectionGeneration: 2,
      receivedSequence: 3,
      lastAppliedReceiveSequence: 3,
      appliedStateVersion: expect.any(Number),
    });
    expect(book.getSnapshot()?.bidDepth[0].qty).toBe(13);
    book.stop();
  });

  it('distinguishes a received diff buffered during snapshot sync from a diff applied to state', async () => {
    let emit: ((event: any) => void) | undefined;
    let resolveSnapshot: ((snapshot: any) => void) | undefined;
    const causal = new LocalCausalSequence('process-pending', () => 10);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const book = new SynchronizedOrderBook('ETHUSDT', {
      snapshotSource: {
        getSnapshot: () =>
          new Promise((resolve) => {
            resolveSnapshot = resolve;
          }),
      },
      diffSource: {
        onDiff: vi.fn((_symbol, callback) => {
          emit = callback;
          return () => undefined;
        }),
      },
      logger,
      clock: { now: () => 1_000 },
    });

    book.start();
    emit?.({
      U: 100,
      u: 101,
      pu: 99,
      bids: [['100', '11']],
      asks: [],
      E: 1_000,
      T: 1_000,
      receivedAtMs: 1_000,
      localCausality: causal.receive(1),
    });
    expect(book.getState().localCausality).toMatchObject({
      receivedSequence: 1,
      lastAppliedReceiveSequence: null,
      appliedStateVersion: 0,
    });

    resolveSnapshot?.({
      lastUpdateId: 100,
      bids: [['100', '10']],
      asks: [['101', '10']],
      receivedAtMs: 1_000,
    });
    await vi.waitFor(() => expect(book.getHealth()).toBe('HEALTHY'));
    expect(book.getState().localCausality).toMatchObject({
      receivedSequence: 1,
      lastAppliedReceiveSequence: 1,
      appliedStateVersion: 2,
    });
    const synchronizationLog = logger.info.mock.calls.find(
      ([message]) => message === 'market_data_order_book_snapshot_synchronized',
    );
    expect(synchronizationLog?.[1]).toMatchObject({
      snapshotLastUpdateId: 100,
      bufferLengthAfter: 1,
      bufferProcessGenerationId: 'process-pending',
      bufferFirstReceiveSequence: 1,
      bufferLastReceiveSequence: 1,
      localCausality: { lastAppliedReceiveSequence: 1, appliedStateVersion: 2 },
    });
    book.stop();
  });
});
