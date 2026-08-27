import { Logger } from '../../../app/ports/Logger';
import { OrderBookDepthLevel } from './MicroBurstTypes';
import {
  BinanceDepthDiffEvent,
  BinanceDepthSnapshot,
  OrderBookHealth,
  SynchronizedOrderBookState,
} from './MicroBurstMarketDataTypes';

const MAX_DEPTH_LEVELS = 20;
const STALE_THRESHOLD_MS = 10_000;
const MAX_DIFF_BUFFER_SIZE = 500;
const MAX_RESYNC_ATTEMPTS = 3;

interface SnapshotSource {
  getSnapshot(symbol: string): Promise<BinanceDepthSnapshot>;
}

interface DiffSource {
  onDiff(symbol: string, callback: (event: BinanceDepthDiffEvent) => void): () => void;
}

interface Clock {
  now(): number;
}

function parsePriceQty(priceStr: string, qtyStr: string): OrderBookDepthLevel | null {
  const price = Number(priceStr);
  const qty = Number(qtyStr);
  if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(qty) || qty < 0) return null;
  return { price, qty };
}

function applyDiffToBook(
  book: Map<number, number>,
  diffs: [string, string][],
): void {
  for (const [priceStr, qtyStr] of diffs) {
    const price = Number(priceStr);
    const qty = Number(qtyStr);
    if (!Number.isFinite(price) || price <= 0) continue;
    if (qty === 0) {
      book.delete(price);
    } else if (Number.isFinite(qty) && qty > 0) {
      book.set(price, qty);
    }
  }
}

function bookToSortedLevels(
  book: Map<number, number>,
  descending: boolean,
): OrderBookDepthLevel[] {
  const entries = Array.from(book.entries());
  entries.sort((a, b) => (descending ? b[0] - a[0] : a[0] - b[0]));
  return entries.slice(0, MAX_DEPTH_LEVELS).map(([price, qty]) => ({ price, qty }));
}

function isCrossedBook(bids: OrderBookDepthLevel[], asks: OrderBookDepthLevel[]): boolean {
  if (bids.length === 0 || asks.length === 0) return false;
  return bids[0].price >= asks[0].price;
}

function isSortedCorrectly(levels: OrderBookDepthLevel[], descending: boolean): boolean {
  for (let i = 1; i < levels.length; i++) {
    if (descending && levels[i - 1].price < levels[i].price) return false;
    if (!descending && levels[i - 1].price > levels[i].price) return false;
  }
  return true;
}

export interface SynchronizedOrderBookDeps {
  snapshotSource: SnapshotSource;
  diffSource: DiffSource;
  logger: Logger;
  clock: Clock;
  getServerTime(): Promise<number>;
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
  private diffUnsubscribe: (() => void) | null = null;
  private readonly symbol: string;

  constructor(
    symbol: string,
    private readonly deps: SynchronizedOrderBookDeps,
    private readonly maxDiffBuffer = MAX_DIFF_BUFFER_SIZE,
    private readonly staleThresholdMs = STALE_THRESHOLD_MS,
  ) {
    this.symbol = symbol;
  }

  start(): void {
    if (this.diffUnsubscribe) return;
    this.diffUnsubscribe = this.deps.diffSource.onDiff(this.symbol, (event) => {
      this.handleDiff(event);
    });
    this.syncFromSnapshot().catch((err) => {
      this.deps.logger.error('MicroBurst OrderBook initial sync failed', {
        symbol: this.symbol,
        error: String(err),
      });
      this.health = 'UNAVAILABLE';
    });
  }

  stop(): void {
    if (this.diffUnsubscribe) {
      this.diffUnsubscribe();
      this.diffUnsubscribe = null;
    }
    this.bidBook.clear();
    this.askBook.clear();
    this.diffBuffer = [];
    this.health = 'UNAVAILABLE';
  }

  getState(): SynchronizedOrderBookState {
    return {
      bids: bookToSortedLevels(this.bidBook, true),
      asks: bookToSortedLevels(this.askBook, false),
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
    this.checkStaleness();
    return this.health;
  }

  getSnapshotForPressure(): {
    bidDepth: OrderBookDepthLevel[];
    askDepth: OrderBookDepthLevel[];
    observedAtMs: number;
    status: 'HEALTHY';
    lastUpdateId: number;
  } | undefined {
    this.checkStaleness();
    if (this.health !== 'HEALTHY') return undefined;
    const bids = bookToSortedLevels(this.bidBook, true);
    const asks = bookToSortedLevels(this.askBook, false);
    if (bids.length === 0 || asks.length === 0) {
      this.health = 'ANOMALOUS';
      return undefined;
    }
    return {
      bidDepth: bids,
      askDepth: asks,
      observedAtMs: this.observedAtMs,
      status: 'HEALTHY' as const,
      lastUpdateId: this.lastUpdateId,
    };
  }

  private checkStaleness(): void {
    if (this.health !== 'HEALTHY' && this.health !== 'UNSYNCED') return;
    const now = this.deps.clock.now();
    if (now - this.observedAtMs > this.staleThresholdMs) {
      this.health = 'STALE';
    }
  }

  private handleDiff(event: BinanceDepthDiffEvent): void {
    if (this.isSyncing) {
      if (this.diffBuffer.length < this.maxDiffBuffer) {
        this.diffBuffer.push(event);
      }
      return;
    }

    if (this.health === 'UNAVAILABLE') {
      if (this.diffBuffer.length < this.maxDiffBuffer) {
        this.diffBuffer.push(event);
      }
      return;
    }

    if (this.health !== 'HEALTHY' && this.health !== 'UNSYNCED') {
      return;
    }

    if (event.lastUpdateId <= this.lastUpdateId) return;

    if (event.lastUpdateId !== this.lastUpdateId + 1) {
      this.gapCount++;
      this.health = 'UNSYNCED';
      this.deps.logger.warn('MicroBurst OrderBook gap detected', {
        symbol: this.symbol,
        expected: this.lastUpdateId + 1,
        received: event.lastUpdateId,
        gapCount: this.gapCount,
      });
      this.resyncFromSnapshot();
      return;
    }

    applyDiffToBook(this.bidBook, event.bids);
    applyDiffToBook(this.askBook, event.asks);
    this.lastUpdateId = event.lastUpdateId;
    this.lastDiffAtMs = this.deps.clock.now();
    this.observedAtMs = event.transactionTime ?? event.eventTime ?? this.deps.clock.now();

    const bids = bookToSortedLevels(this.bidBook, true);
    const asks = bookToSortedLevels(this.askBook, false);
    if (isCrossedBook(bids, asks)) {
      this.health = 'ANOMALOUS';
      this.deps.logger.warn('MicroBurst OrderBook crossed after diff', { symbol: this.symbol });
      return;
    }
    if (!isSortedCorrectly(bids, true) || !isSortedCorrectly(asks, false)) {
      this.health = 'ANOMALOUS';
      return;
    }
    this.health = 'HEALTHY';
  }

  private async syncFromSnapshot(): Promise<void> {
    if (this.isSyncing) return;
    this.isSyncing = true;
    this.diffBuffer = [];

    try {
      const [snapshot, serverTime] = await Promise.all([
        this.deps.snapshotSource.getSnapshot(this.symbol),
        this.deps.getServerTime(),
      ]);

      this.bidBook.clear();
      this.askBook.clear();

      for (const [priceStr, qtyStr] of snapshot.bids) {
        const level = parsePriceQty(priceStr, qtyStr);
        if (level && level.qty > 0) this.bidBook.set(level.price, level.qty);
      }
      for (const [priceStr, qtyStr] of snapshot.asks) {
        const level = parsePriceQty(priceStr, qtyStr);
        if (level && level.qty > 0) this.askBook.set(level.price, level.qty);
      }

      this.lastUpdateId = snapshot.lastUpdateId;
      this.lastSyncAtMs = serverTime;
      this.observedAtMs = serverTime;

      const validBuffered = this.diffBuffer.filter(
        (e) => e.lastUpdateId > this.lastUpdateId,
      );

      if (validBuffered.length > 0) {
        const firstEvent = validBuffered[0];
        if (firstEvent.lastUpdateId !== this.lastUpdateId + 1) {
          this.health = 'UNSYNCED';
          this.gapCount++;
          this.deps.logger.warn('MicroBurst OrderBook post-snapshot gap', {
            symbol: this.symbol,
            expected: this.lastUpdateId + 1,
            firstBuffered: firstEvent.lastUpdateId,
          });
          this.isSyncing = false;
          if (this.resyncCount < MAX_RESYNC_ATTEMPTS) {
            this.resyncCount++;
          }
          return;
        }

        for (const event of validBuffered) {
          if (event.lastUpdateId !== this.lastUpdateId + 1) {
            this.health = 'UNSYNCED';
            this.gapCount++;
            break;
          }
          applyDiffToBook(this.bidBook, event.bids);
          applyDiffToBook(this.askBook, event.asks);
          this.lastUpdateId = event.lastUpdateId;
          this.lastDiffAtMs = event.transactionTime ?? event.eventTime ?? this.deps.clock.now();
          this.observedAtMs = this.lastDiffAtMs;
        }
      }

      const bids = bookToSortedLevels(this.bidBook, true);
      const asks = bookToSortedLevels(this.askBook, false);

      if (bids.length === 0 || asks.length === 0) {
        this.health = 'ANOMALOUS';
      } else if (isCrossedBook(bids, asks)) {
        this.health = 'ANOMALOUS';
      } else if (!isSortedCorrectly(bids, true) || !isSortedCorrectly(asks, false)) {
        this.health = 'ANOMALOUS';
      } else if (this.health !== 'UNSYNCED') {
        this.health = 'HEALTHY';
      }

      this.resyncCount = 0;
    } catch (err) {
      this.health = 'UNAVAILABLE';
      this.deps.logger.error('MicroBurst OrderBook snapshot failed', {
        symbol: this.symbol,
        error: String(err),
      });
    } finally {
      this.isSyncing = false;
    }
  }

  private resyncFromSnapshot(): void {
    if (this.resyncCount >= MAX_RESYNC_ATTEMPTS) {
      this.health = 'ANOMALOUS';
      this.deps.logger.error('MicroBurst OrderBook max resync attempts exceeded', {
        symbol: this.symbol,
        resyncCount: this.resyncCount,
      });
      return;
    }
    this.resyncCount++;
    this.syncFromSnapshot().catch((err) => {
      this.deps.logger.error('MicroBurst OrderBook resync failed', {
        symbol: this.symbol,
        error: String(err),
      });
    });
  }
}
