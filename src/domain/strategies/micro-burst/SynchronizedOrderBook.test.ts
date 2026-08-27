import { describe, expect, it, vi } from 'vitest';
import { SynchronizedOrderBook } from './SynchronizedOrderBook';
import {
  BinanceDepthDiffEvent,
  BinanceDepthSnapshot,
  SYNCHRONIZED_ORDER_BOOK_SNAPSHOT_DEPTH,
} from './MicroBurstMarketDataTypes';

const SYMBOL = 'ETHUSDT';
const NOW = 1_700_000_000_000;

function snapshot(lastUpdateId = 100): BinanceDepthSnapshot {
  return {
    lastUpdateId,
    bids: [
      ['100', '10'],
      ['99', '5'],
    ],
    asks: [
      ['101', '10'],
      ['102', '5'],
    ],
    receivedAtMs: NOW,
  };
}

function diff(
  U: number,
  u: number,
  pu: number,
  overrides: Partial<BinanceDepthDiffEvent> = {},
): BinanceDepthDiffEvent {
  return {
    U,
    u,
    pu,
    bids: [],
    asks: [],
    E: NOW + u,
    T: NOW + u,
    receivedAtMs: NOW + u,
    ...overrides,
  };
}

function deps(snapshots: BinanceDepthSnapshot[] = [snapshot()]) {
  let callback: ((event: BinanceDepthDiffEvent) => void) | undefined;
  return {
    snapshotSource: { getSnapshot: vi.fn(async () => snapshots.shift() ?? snapshot()) },
    diffSource: {
      onDiff: vi.fn((_symbol, next) => {
        callback = next;
        return () => {
          callback = undefined;
        };
      }),
      emit: (event: BinanceDepthDiffEvent) => callback?.(event),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    clock: { now: vi.fn(() => NOW) },
  };
}

async function healthy(book: SynchronizedOrderBook): Promise<void> {
  await vi.waitFor(() => expect(book.getState().health).toBe('HEALTHY'));
}

async function startAndBridge(
  book: SynchronizedOrderBook,
  d: ReturnType<typeof deps>,
): Promise<void> {
  book.start();
  d.diffSource.emit(diff(100, 101, 100));
  await vi.waitFor(() => expect(book.getState().lastUpdateId).toBe(101));
  await vi.waitFor(() => expect(book.getState().health).toBe('HEALTHY'));
}

describe('SynchronizedOrderBook USD-M diff-depth synchronization', () => {
  it('bootstraps through U <= snapshot + 1 <= u and discards stale buffered events', async () => {
    let resolveSnapshot!: (value: BinanceDepthSnapshot) => void;
    const source = new Promise<BinanceDepthSnapshot>((resolve) => {
      resolveSnapshot = resolve;
    });
    const d = deps();
    d.snapshotSource.getSnapshot.mockReturnValueOnce(source);
    const book = new SynchronizedOrderBook(SYMBOL, d);
    book.start();
    d.diffSource.emit(diff(95, 100, 94));
    d.diffSource.emit(diff(99, 102, 98, { bids: [['100', '12']] }));
    resolveSnapshot(snapshot(100));
    await vi.waitFor(() => expect(book.getState().lastUpdateId).toBe(102));
    expect(book.getState().bids[0].qty).toBe(12);
  });

  it('uses the exact USD-M bridge U <= snapshot.lastUpdateId <= u', async () => {
    const d = deps();
    const book = new SynchronizedOrderBook(SYMBOL, d);
    book.start();
    d.diffSource.emit(diff(100, 101, 99));
    await vi.waitFor(() => expect(book.getState().lastUpdateId).toBe(101));
    expect(d.snapshotSource.getSnapshot).toHaveBeenCalledWith(
      SYMBOL,
      SYNCHRONIZED_ORDER_BOOK_SNAPSHOT_DEPTH,
    );
  });

  it('accepts non-contiguous u values when pu chains to the preceding u', async () => {
    const d = deps();
    const book = new SynchronizedOrderBook(SYMBOL, d);
    await startAndBridge(book, d);
    d.diffSource.emit(diff(102, 105, 101));
    d.diffSource.emit(diff(106, 109, 105));
    expect(book.getState().lastUpdateId).toBe(109);
    expect(book.getHealth()).toBe('HEALTHY');
  });

  it('does not fetch snapshots while a healthy book remains fresh', async () => {
    const d = deps();
    const book = new SynchronizedOrderBook(SYMBOL, d, 500, 10);
    await startAndBridge(book, d);
    d.clock.now.mockReturnValue(NOW + 105);

    expect(book.getHealth()).toBe('HEALTHY');
    expect(book.getHealth()).toBe('HEALTHY');
    expect(d.snapshotSource.getSnapshot).toHaveBeenCalledTimes(1);
  });

  it('uses receivedAtMs, not Binance or server timestamps, for staleness', async () => {
    const d = deps();
    const book = new SynchronizedOrderBook(SYMBOL, d, 500, 10);
    await startAndBridge(book, d);
    d.diffSource.emit(diff(102, 102, 101, { E: 1, T: 2, receivedAtMs: NOW + 5 }));
    d.clock.now.mockReturnValue(NOW + 16);
    expect(book.getHealth()).toBe('STALE');
  });

  it('buffers new diffs and resynchronizes after becoming stale', async () => {
    const d = deps([snapshot(100), snapshot(200)]);
    const book = new SynchronizedOrderBook(SYMBOL, d, 500, 10);
    await startAndBridge(book, d);
    d.clock.now.mockReturnValue(NOW + 112);
    expect(book.getHealth()).toBe('STALE');
    d.diffSource.emit(diff(200, 201, 200));
    await vi.waitFor(() => expect(book.getState().lastUpdateId).toBe(201));
    expect(book.getState().lastUpdateId).toBe(201);
    expect(d.snapshotSource.getSnapshot).toHaveBeenCalledTimes(2);
  });

  it('starts only one snapshot resync when repeated health checks find a stale book', async () => {
    let resolveSnapshot!: (value: BinanceDepthSnapshot) => void;
    const resyncSnapshot = new Promise<BinanceDepthSnapshot>((resolve) => {
      resolveSnapshot = resolve;
    });
    const d = deps([snapshot(100)]);
    const book = new SynchronizedOrderBook(SYMBOL, d, 500, 10);
    await startAndBridge(book, d);
    d.snapshotSource.getSnapshot.mockImplementationOnce(() => resyncSnapshot);
    d.clock.now.mockReturnValue(NOW + 112);

    expect(book.getHealth()).toBe('STALE');
    expect(book.getHealth()).toBe('STALE');
    expect(book.getHealth()).toBe('STALE');
    expect(d.snapshotSource.getSnapshot).toHaveBeenCalledTimes(2);

    resolveSnapshot({ ...snapshot(200), receivedAtMs: NOW + 112 });
    await vi.waitFor(() => expect(book.getState().lastUpdateId).toBe(200));
    expect(book.getHealth()).toBe('UNSYNCED');
    expect(d.snapshotSource.getSnapshot).toHaveBeenCalledTimes(2);
  });

  it('deletes zero-quantity levels', async () => {
    const d = deps();
    const book = new SynchronizedOrderBook(SYMBOL, d);
    await startAndBridge(book, d);
    d.diffSource.emit(diff(102, 102, 101, { bids: [['99', '0']] }));
    expect(book.getState().bids.some((level) => level.price === 99)).toBe(false);
  });

  it('resyncs from a new REST snapshot on a pu mismatch and never reports healthy from the old book', async () => {
    const d = deps([snapshot(100), snapshot(200)]);
    const book = new SynchronizedOrderBook(SYMBOL, d);
    await startAndBridge(book, d);
    d.diffSource.emit(diff(102, 105, 99));
    expect(book.getHealth()).not.toBe('HEALTHY');
    await vi.waitFor(() =>
      expect(d.snapshotSource.getSnapshot.mock.calls.length).toBeGreaterThanOrEqual(2),
    );
    expect(book.getState().lastUpdateId).toBe(200);
  });

  it('rejects a malformed event and obtains a new snapshot', async () => {
    const d = deps([snapshot(100), snapshot(200)]);
    const book = new SynchronizedOrderBook(SYMBOL, d);
    await startAndBridge(book, d);
    d.diffSource.emit({ ...diff(101, 101, 100), u: Number.NaN });
    await vi.waitFor(() =>
      expect(d.snapshotSource.getSnapshot.mock.calls.length).toBeGreaterThanOrEqual(2),
    );
    expect(book.getState().lastUpdateId).toBe(200);
  });

  it('keeps resyncCount cumulative across successful resynchronizations', async () => {
    let resolveSecondSnapshot!: (value: BinanceDepthSnapshot) => void;
    const secondSnapshot = new Promise<BinanceDepthSnapshot>((resolve) => {
      resolveSecondSnapshot = resolve;
    });
    let resolveThirdSnapshot!: (value: BinanceDepthSnapshot) => void;
    const thirdSnapshot = new Promise<BinanceDepthSnapshot>((resolve) => {
      resolveThirdSnapshot = resolve;
    });
    const d = deps([snapshot(100)]);
    const book = new SynchronizedOrderBook(SYMBOL, d);
    await startAndBridge(book, d);

    d.snapshotSource.getSnapshot.mockImplementationOnce(() => secondSnapshot);
    d.diffSource.emit({ ...diff(102, 102, 101), u: Number.NaN });
    d.diffSource.emit(diff(200, 201, 200));
    resolveSecondSnapshot(snapshot(200));
    await healthy(book);

    d.snapshotSource.getSnapshot.mockImplementationOnce(() => thirdSnapshot);
    d.diffSource.emit({ ...diff(202, 202, 201), u: Number.NaN });
    d.diffSource.emit(diff(300, 301, 300));
    resolveThirdSnapshot(snapshot(300));
    await healthy(book);
    expect(book.getState().resyncCount).toBe(2);
  });

  it('does not become healthy when the snapshot bridge is absent', async () => {
    let resolveSnapshot!: (value: BinanceDepthSnapshot) => void;
    const source = new Promise<BinanceDepthSnapshot>((resolve) => {
      resolveSnapshot = resolve;
    });
    const d = deps([snapshot(100), snapshot(200)]);
    d.snapshotSource.getSnapshot.mockReturnValueOnce(source);
    const book = new SynchronizedOrderBook(SYMBOL, d);
    book.start();
    d.diffSource.emit(diff(103, 105, 102));
    resolveSnapshot(snapshot(100));
    await vi.waitFor(() => expect(d.snapshotSource.getSnapshot).toHaveBeenCalledTimes(2));
    expect(book.getHealth()).not.toBe('HEALTHY');
  });

  it('marks crossed books anomalous', async () => {
    const d = deps();
    const book = new SynchronizedOrderBook(SYMBOL, d);
    await startAndBridge(book, d);
    d.diffSource.emit(diff(102, 102, 101, { bids: [['101', '5']] }));
    expect(book.getHealth()).toBe('ANOMALOUS');
  });

  it('bounds the bootstrap buffer and forces a new snapshot', async () => {
    let resolveSnapshot!: (value: BinanceDepthSnapshot) => void;
    const source = new Promise<BinanceDepthSnapshot>((resolve) => {
      resolveSnapshot = resolve;
    });
    const d = deps([snapshot(100), snapshot(200)]);
    d.snapshotSource.getSnapshot.mockReturnValueOnce(source);
    const book = new SynchronizedOrderBook(SYMBOL, d, 1);
    book.start();
    d.diffSource.emit(diff(101, 101, 100));
    d.diffSource.emit(diff(102, 102, 101));
    resolveSnapshot(snapshot(100));
    await vi.waitFor(() => expect(d.snapshotSource.getSnapshot).toHaveBeenCalledTimes(2));
  });
});
