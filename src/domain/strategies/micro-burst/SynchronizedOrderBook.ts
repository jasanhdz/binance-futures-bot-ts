import { Logger } from '../../../app/ports/Logger';
import { OrderBookDepthLevel } from './MicroBurstTypes';
import {
  BinanceDepthDiffEvent,
  BinanceDepthSnapshot,
  BOOK_PRESSURE_FEATURE_DEPTH,
  OrderBookHealth,
  SynchronizedOrderBookState,
  SYNCHRONIZED_ORDER_BOOK_SNAPSHOT_DEPTH,
  TemporalBookSnapshot,
} from './MicroBurstMarketDataTypes';

const MAX_FEATURE_DEPTH_LEVELS = BOOK_PRESSURE_FEATURE_DEPTH;
const STALE_THRESHOLD_MS = 10_000;
const MAX_DIFF_BUFFER_SIZE = 500;

interface SnapshotSource {
  getSnapshot(symbol: string, levels: number): Promise<BinanceDepthSnapshot>;
}

interface DiffSource {
  onDiff(symbol: string, callback: (event: BinanceDepthDiffEvent) => void): () => void;
}

interface Clock {
  now(): number;
}

function isUpdateId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function parseLevel(priceStr: string, qtyStr: string): OrderBookDepthLevel | null {
  const price = Number(priceStr);
  const qty = Number(qtyStr);
  return Number.isFinite(price) && price > 0 && Number.isFinite(qty) && qty >= 0
    ? { price, qty }
    : null;
}

function validateDiff(event: BinanceDepthDiffEvent): boolean {
  return (
    isUpdateId(event.U) &&
    isUpdateId(event.u) &&
    isUpdateId(event.pu) &&
    event.U <= event.u &&
    isTimestamp(event.E) &&
    isTimestamp(event.T) &&
    isTimestamp(event.receivedAtMs) &&
    Array.isArray(event.bids) &&
    Array.isArray(event.asks) &&
    [...event.bids, ...event.asks].every(
      (level) =>
        Array.isArray(level) && level.length === 2 && parseLevel(level[0], level[1]) !== null,
    )
  );
}

function applyDiff(book: Map<number, number>, levels: [string, string][]): void {
  for (const [priceStr, qtyStr] of levels) {
    const level = parseLevel(priceStr, qtyStr)!;
    if (level.qty === 0) book.delete(level.price);
    else book.set(level.price, level.qty);
  }
}

function sortedLevels(book: Map<number, number>, descending: boolean): OrderBookDepthLevel[] {
  return Array.from(book.entries())
    .sort((a, b) => (descending ? b[0] - a[0] : a[0] - b[0]))
    .slice(0, MAX_FEATURE_DEPTH_LEVELS)
    .map(([price, qty]) => ({ price, qty }));
}

export interface SynchronizedOrderBookDeps {
  snapshotSource: SnapshotSource;
  diffSource: DiffSource;
  logger: Logger;
  clock: Clock;
  /** Retained for existing runtime construction; receive-time is used instead. */
  getServerTime?: () => Promise<number>;
}

export class SynchronizedOrderBook {
  private readonly bidBook = new Map<number, number>();
  private readonly askBook = new Map<number, number>();
  private diffBuffer: BinanceDepthDiffEvent[] = [];
  private lastUpdateId = 0;
  private health: OrderBookHealth = 'UNAVAILABLE';
  private observedAtMs = 0;
  private lastSyncAtMs = 0;
  private lastDiffAtMs = 0;
  private gapCount = 0;
  private resyncCount = 0;
  private isSyncing = false;
  private resyncRequested = false;
  private temporalHistory: TemporalBookSnapshot[] = [];
  private diffUnsubscribe: (() => void) | null = null;

  constructor(
    private readonly symbol: string,
    private readonly deps: SynchronizedOrderBookDeps,
    private readonly maxDiffBuffer = MAX_DIFF_BUFFER_SIZE,
    private readonly staleThresholdMs = STALE_THRESHOLD_MS,
  ) {}

  start(): void {
    if (this.diffUnsubscribe) return;
    this.diffUnsubscribe = this.deps.diffSource.onDiff(this.symbol, (event) =>
      this.handleDiff(event),
    );
    this.syncFromSnapshot();
  }

  stop(): void {
    this.diffUnsubscribe?.();
    this.diffUnsubscribe = null;
    this.bidBook.clear();
    this.askBook.clear();
    this.diffBuffer = [];
    this.health = 'UNAVAILABLE';
  }

  getState(): SynchronizedOrderBookState {
    return {
      bids: sortedLevels(this.bidBook, true),
      asks: sortedLevels(this.askBook, false),
      lastUpdateId: this.lastUpdateId,
      health: this.health,
      observedAtMs: this.observedAtMs,
      lastSyncAtMs: this.lastSyncAtMs,
      lastDiffAtMs: this.lastDiffAtMs,
      gapCount: this.gapCount,
      resyncCount: this.resyncCount,
    };
  }

  getHealth(): OrderBookHealth {
    if (
      (this.health === 'HEALTHY' || this.health === 'UNSYNCED') &&
      this.deps.clock.now() - this.observedAtMs > this.staleThresholdMs
    ) {
      this.health = 'STALE';
      this.syncFromSnapshot();
    }
    return this.health;
  }

  getSnapshotForPressure():
    | {
        bidDepth: OrderBookDepthLevel[];
        askDepth: OrderBookDepthLevel[];
        observedAtMs: number;
        status: 'HEALTHY';
        lastUpdateId: number;
        temporalHistory: TemporalBookSnapshot[];
      }
    | undefined {
    if (this.getHealth() !== 'HEALTHY') return undefined;
    const bidDepth = sortedLevels(this.bidBook, true);
    const askDepth = sortedLevels(this.askBook, false);
    if (!bidDepth.length || !askDepth.length) {
      this.health = 'ANOMALOUS';
      return undefined;
    }
    return {
      bidDepth,
      askDepth,
      observedAtMs: this.observedAtMs,
      status: 'HEALTHY',
      lastUpdateId: this.lastUpdateId,
      temporalHistory: [...this.temporalHistory],
    };
  }

  private handleDiff(event: BinanceDepthDiffEvent): void {
    if (!validateDiff(event)) {
      this.desync('malformed diff-depth event');
      return;
    }
    if (this.isSyncing || this.health === 'UNAVAILABLE') {
      this.buffer(event);
      return;
    }
    if (this.health === 'UNSYNCED' || this.health === 'STALE') {
      this.buffer(event);
      this.syncFromSnapshot();
      return;
    }
    if (this.health !== 'HEALTHY') return;
    if (event.u <= this.lastUpdateId) return; // stale/duplicate event
    if (event.pu !== this.lastUpdateId) {
      this.desync('diff-depth predecessor mismatch');
      return;
    }
    this.apply(event);
  }

  private buffer(event: BinanceDepthDiffEvent): void {
    if (this.diffBuffer.length >= this.maxDiffBuffer) {
      this.desync('diff-depth buffer overflow');
      return;
    }
    this.diffBuffer.push(event);
  }

  private async syncFromSnapshot(): Promise<void> {
    if (this.isSyncing || !this.diffUnsubscribe) return;
    this.isSyncing = true;
    try {
      const snapshot = await this.deps.snapshotSource.getSnapshot(
        this.symbol,
        SYNCHRONIZED_ORDER_BOOK_SNAPSHOT_DEPTH,
      );
      if (!isUpdateId(snapshot.lastUpdateId) || !this.loadSnapshot(snapshot)) {
        this.health = 'ANOMALOUS';
        return;
      }
      this.lastUpdateId = snapshot.lastUpdateId;
      this.lastSyncAtMs = snapshot.receivedAtMs ?? this.deps.clock.now();
      this.observedAtMs = this.lastSyncAtMs;
      this.lastDiffAtMs = 0;
      this.temporalHistory = [];

      const buffered = this.diffBuffer.filter((event) => event.u > this.lastUpdateId);
      this.diffBuffer = [];
      if (!buffered.length) {
        this.health = 'UNSYNCED';
        return;
      }
      {
        const first = buffered[0];
        const snapshotUpdateId = this.lastUpdateId;
        if (!(first.U <= snapshotUpdateId && snapshotUpdateId <= first.u)) {
          this.desync('snapshot bridge missing');
          return;
        }
        this.apply(first);
        for (let index = 1; index < buffered.length; index++) {
          const event = buffered[index];
          if (event.pu !== this.lastUpdateId) {
            this.desync('buffered diff-depth predecessor mismatch');
            return;
          }
          this.apply(event);
        }
      }
      if (!this.isBookValid()) {
        this.health = 'ANOMALOUS';
        return;
      }
      this.health = 'HEALTHY';
    } catch (error) {
      this.health = 'UNAVAILABLE';
      this.deps.logger.error('MicroBurst OrderBook snapshot failed', {
        symbol: this.symbol,
        error: String(error),
      });
    } finally {
      this.isSyncing = false;
      if (this.resyncRequested) {
        this.resyncRequested = false;
        this.syncFromSnapshot();
      }
    }
  }

  private loadSnapshot(snapshot: BinanceDepthSnapshot): boolean {
    this.bidBook.clear();
    this.askBook.clear();
    for (const [price, qty] of snapshot.bids) {
      const level = parseLevel(price, qty);
      if (!level) return false;
      if (level.qty) this.bidBook.set(level.price, level.qty);
    }
    for (const [price, qty] of snapshot.asks) {
      const level = parseLevel(price, qty);
      if (!level) return false;
      if (level.qty) this.askBook.set(level.price, level.qty);
    }
    return true;
  }

  private apply(event: BinanceDepthDiffEvent): void {
    applyDiff(this.bidBook, event.bids);
    applyDiff(this.askBook, event.asks);
    this.lastUpdateId = event.u;
    this.lastDiffAtMs = event.receivedAtMs;
    this.observedAtMs = event.receivedAtMs;
    this.health = this.isBookValid() ? 'HEALTHY' : 'ANOMALOUS';
    if (this.health === 'HEALTHY') this.recordTemporalObservation();
  }

  private isBookValid(): boolean {
    const bids = sortedLevels(this.bidBook, true);
    const asks = sortedLevels(this.askBook, false);
    return bids.length > 0 && asks.length > 0 && bids[0].price < asks[0].price;
  }

  private desync(reason: string): void {
    this.gapCount++;
    this.health = 'UNSYNCED';
    this.bidBook.clear();
    this.askBook.clear();
    this.diffBuffer = [];
    this.temporalHistory = [];
    this.resyncCount++;
    this.deps.logger.warn('MicroBurst OrderBook desynchronized', {
      symbol: this.symbol,
      reason,
      gapCount: this.gapCount,
    });
    if (this.isSyncing) this.resyncRequested = true;
    else this.syncFromSnapshot();
  }

  private recordTemporalObservation(): void {
    const bidDepth = sortedLevels(this.bidBook, true);
    const askDepth = sortedLevels(this.askBook, false);
    const bidTop5Qty = bidDepth.slice(0, 5).reduce((total, level) => total + level.qty, 0);
    const askTop5Qty = askDepth.slice(0, 5).reduce((total, level) => total + level.qty, 0);
    const totalQty = bidTop5Qty + askTop5Qty;
    this.temporalHistory.push({
      observedAtMs: this.observedAtMs,
      signedTopOfBookImbalance: totalQty > 0 ? (bidTop5Qty - askTop5Qty) / totalQty : 0,
      topOfBookImbalance: totalQty > 0 ? Math.abs(bidTop5Qty - askTop5Qty) / totalQty : 0,
      bestBidQty: bidDepth[0]?.qty ?? 0,
      bestAskQty: askDepth[0]?.qty ?? 0,
      bidTop5Qty,
      askTop5Qty,
      spreadBps: ((askDepth[0].price - bidDepth[0].price) / bidDepth[0].price) * 10_000,
    });
    if (this.temporalHistory.length > this.maxDiffBuffer) this.temporalHistory.shift();
  }
}
