import { describe, expect, it, vi } from 'vitest';
import { SynchronizedOrderBook } from './SynchronizedOrderBook';
import { BinanceDepthDiffEvent, BinanceDepthSnapshot } from './MicroBurstMarketDataTypes';

const SYMBOL = 'ETHUSDT';
const SNAPSHOT_ID = 100;

function makeSnapshot(lastUpdateId = SNAPSHOT_ID): BinanceDepthSnapshot {
  return {
    lastUpdateId,
    bids: [
      ['100.00', '10'],
      ['99.95', '5'],
      ['99.90', '8'],
      ['99.85', '3'],
      ['99.80', '7'],
    ],
    asks: [
      ['100.05', '10'],
      ['100.10', '5'],
      ['100.15', '8'],
      ['100.20', '3'],
      ['100.25', '7'],
    ],
  };
}

function makeDiff(lastUpdateId: number, overrides?: { bids?: [string, string][]; asks?: [string, string][] }): BinanceDepthDiffEvent {
  return {
    lastUpdateId,
    bids: overrides?.bids ?? [],
    asks: overrides?.asks ?? [],
    eventTime: 1_700_000_001_000 + lastUpdateId,
    transactionTime: 1_700_000_001_000 + lastUpdateId,
  };
}

function createDeps(overrides?: {
  snapshot?: BinanceDepthSnapshot;
  snapshotError?: Error;
  serverTime?: number;
}) {
  let diffCallback: ((event: BinanceDepthDiffEvent) => void) | null = null;

  return {
    snapshotSource: {
      getSnapshot: overrides?.snapshotError
        ? vi.fn().mockRejectedValue(overrides.snapshotError)
        : vi.fn().mockResolvedValue(overrides?.snapshot ?? makeSnapshot()),
    },
    diffSource: {
      onDiff: vi.fn((_symbol: string, callback: (event: BinanceDepthDiffEvent) => void) => {
        diffCallback = callback;
        return vi.fn(() => { diffCallback = null; });
      }),
      emit: (event: BinanceDepthDiffEvent) => diffCallback?.(event),
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    clock: { now: vi.fn(() => 1_700_000_000_000) },
    getServerTime: vi.fn().mockResolvedValue(overrides?.serverTime ?? 1_700_000_000_000),
  };
}

async function waitForHealthy(book: SynchronizedOrderBook, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (book.getHealth() !== 'HEALTHY' && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('SynchronizedOrderBook', () => {
  it('starts in UNAVAILABLE state', () => {
    const deps = createDeps();
    const book = new SynchronizedOrderBook(SYMBOL, deps);
    expect(book.getHealth()).toBe('UNAVAILABLE');
  });

  it('syncs from snapshot and becomes HEALTHY', async () => {
    const deps = createDeps();
    const book = new SynchronizedOrderBook(SYMBOL, deps);
    book.start();
    await waitForHealthy(book);

    expect(book.getHealth()).toBe('HEALTHY');
    const state = book.getState();
    expect(state.lastUpdateId).toBe(SNAPSHOT_ID);
    expect(state.bids.length).toBeGreaterThan(0);
    expect(state.asks.length).toBeGreaterThan(0);
    expect(state.bids[0].price).toBeGreaterThanOrEqual(state.bids[1].price);
    expect(state.asks[0].price).toBeLessThanOrEqual(state.asks[1].price);

    book.stop();
  });

  it('applies valid sequential diffs', async () => {
    const deps = createDeps();
    const book = new SynchronizedOrderBook(SYMBOL, deps);
    book.start();
    await waitForHealthy(book);

    deps.diffSource.emit(makeDiff(SNAPSHOT_ID + 1, { bids: [['100.00', '15']] }));

    const state = book.getState();
    expect(state.lastUpdateId).toBe(SNAPSHOT_ID + 1);
    expect(state.bids[0].qty).toBe(15);
    expect(book.getHealth()).toBe('HEALTHY');

    book.stop();
  });

  it('ignores stale updates (lastUpdateId <= current)', async () => {
    const deps = createDeps();
    const book = new SynchronizedOrderBook(SYMBOL, deps);
    book.start();
    await waitForHealthy(book);

    deps.diffSource.emit(makeDiff(SNAPSHOT_ID - 5));

    expect(book.getState().lastUpdateId).toBe(SNAPSHOT_ID);
    book.stop();
  });

  it('qty=0 removes level', async () => {
    const deps = createDeps();
    const book = new SynchronizedOrderBook(SYMBOL, deps);
    book.start();
    await waitForHealthy(book);

    deps.diffSource.emit(makeDiff(SNAPSHOT_ID + 1, { bids: [['99.95', '0']] }));

    const state = book.getState();
    expect(state.bids.find((l) => l.price === 99.95)).toBeUndefined();
    book.stop();
  });

  it('gap => UNSYNCED and triggers resync', async () => {
    const deps = createDeps();
    const book = new SynchronizedOrderBook(SYMBOL, deps);
    book.start();
    await waitForHealthy(book);

    deps.diffSource.emit(makeDiff(SNAPSHOT_ID + 5));

    expect(book.getHealth()).toBe('UNSYNCED');
    book.stop();
  });

  it('crossed book => ANOMALOUS', async () => {
    const deps = createDeps();
    const book = new SynchronizedOrderBook(SYMBOL, deps);
    book.start();
    await waitForHealthy(book);

    deps.diffSource.emit(makeDiff(SNAPSHOT_ID + 1, {
      bids: [['100.10', '5']],
      asks: [['100.00', '5']],
    }));

    expect(book.getHealth()).toBe('ANOMALOUS');
    book.stop();
  });

  it('malformed price => ignored', async () => {
    const deps = createDeps();
    const book = new SynchronizedOrderBook(SYMBOL, deps);
    book.start();
    await waitForHealthy(book);

    deps.diffSource.emit(makeDiff(SNAPSHOT_ID + 1, {
      bids: [['NaN', '5']],
    }));

    expect(book.getState().lastUpdateId).toBe(SNAPSHOT_ID + 1);
    book.stop();
  });

  it('stale snapshot => STALE', async () => {
    const deps = createDeps({ serverTime: 1_700_000_000_000 });
    const book = new SynchronizedOrderBook(SYMBOL, deps, 500, 10_000);
    book.start();
    await waitForHealthy(book);

    expect(book.getHealth()).toBe('HEALTHY');

    deps.clock.now.mockReturnValue(1_700_000_000_000 + 15_000);
    expect(book.getHealth()).toBe('STALE');
    book.stop();
  });

  it('snapshot failure => UNAVAILABLE', async () => {
    const deps = createDeps({ snapshotError: new Error('network') });
    const book = new SynchronizedOrderBook(SYMBOL, deps);
    book.start();

    await vi.waitFor(() => {
      expect(deps.snapshotSource.getSnapshot).toHaveBeenCalled();
    });

    expect(book.getHealth()).toBe('UNAVAILABLE');
    book.stop();
  });

  it('getSnapshotForPressure returns undefined when not HEALTHY', async () => {
    const deps = createDeps();
    const book = new SynchronizedOrderBook(SYMBOL, deps);
    expect(book.getSnapshotForPressure()).toBeUndefined();
    book.stop();
  });

  it('getSnapshotForPressure returns valid data when HEALTHY', async () => {
    const deps = createDeps();
    const book = new SynchronizedOrderBook(SYMBOL, deps);
    book.start();
    await waitForHealthy(book);

    const pressure = book.getSnapshotForPressure();
    expect(pressure).toBeDefined();
    expect(pressure!.status).toBe('HEALTHY');
    expect(pressure!.bidDepth.length).toBeGreaterThan(0);
    expect(pressure!.askDepth.length).toBeGreaterThan(0);

    book.stop();
  });

  it('stop clears state', async () => {
    const deps = createDeps();
    const book = new SynchronizedOrderBook(SYMBOL, deps);
    book.start();
    await waitForHealthy(book);

    book.stop();
    expect(book.getHealth()).toBe('UNAVAILABLE');
    expect(book.getState().bids).toHaveLength(0);
    expect(book.getState().asks).toHaveLength(0);
  });

  it('does not duplicate subscriptions on multiple start calls', async () => {
    const deps = createDeps();
    const book = new SynchronizedOrderBook(SYMBOL, deps);
    book.start();
    book.start();

    expect(deps.diffSource.onDiff).toHaveBeenCalledTimes(1);
    await waitForHealthy(book);

    book.stop();
  });
});
