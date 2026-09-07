import type { OrderBookLease } from '../../core/market-data/OrderBookDataPlane';
import type { SynchronizedOrderBook } from '../../core/market-data/SynchronizedOrderBook';
import type { Logger } from '../ports/Logger';
import { LiquidityVoidDetector, type LiquidityStressStatus } from './LiquidityVoidDetector';
import type { SharedMarketDataRuntime } from './SharedMarketDataRuntime';

/** Strategy-independent depth20 safety input; owns leases, never strategy scans. */
export class SharedLiquidityState {
  private readonly entries = new Map<
    string,
    {
      lease: OrderBookLease<SynchronizedOrderBook>;
      detector: LiquidityVoidDetector;
      observedAtMs?: number;
    }
  >();
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly deps: {
      sharedMarketData: SharedMarketDataRuntime;
      logger: Logger;
      clock: { now(): number };
    },
  ) {}

  start(symbols: readonly string[]): void {
    for (const raw of symbols) {
      const symbol = raw.toUpperCase();
      if (this.entries.has(symbol)) continue;
      this.entries.set(symbol, {
        lease: this.deps.sharedMarketData.orderBookDataPlane.acquire(symbol),
        detector: new LiquidityVoidDetector(this.deps.logger),
      });
    }
    this.timer ??= setInterval(() => {
      for (const symbol of this.entries.keys()) this.read(symbol, this.deps.clock.now(), 3_000);
    }, 100);
    this.timer.unref?.();
  }

  read(symbol: string, now: number, freshnessMs: number): LiquidityStressStatus {
    const entry = this.entries.get(symbol.toUpperCase());
    const book = this.deps.sharedMarketData.orderBookDataPlane.get(symbol.toUpperCase());
    const snapshot = book?.getHealth() === 'HEALTHY' ? book.getSnapshot() : null;
    if (!entry || !snapshot || !snapshot.bidDepth.length || !snapshot.askDepth.length) {
      return {
        stress: Number.POSITIVE_INFINITY,
        status: 'NO_DATA',
        inputVersion: 'DEPTH20_PARTIAL_V1',
      };
    }
    if (entry.observedAtMs !== snapshot.observedAtMs) {
      entry.detector.processDepthUpdate({
        bidDepth: snapshot.bidDepth.slice(0, 20),
        askDepth: snapshot.askDepth.slice(0, 20),
        receivedAtMs: snapshot.observedAtMs,
      });
      entry.observedAtMs = snapshot.observedAtMs;
    }
    const status = entry.detector.getLiquidityStressStatus(now, freshnessMs);
    if (!Number.isFinite(snapshot.observedAtMs) || snapshot.observedAtMs > now) {
      return { ...status, status: 'STALE' };
    }
    return status;
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const entry of this.entries.values()) entry.lease.release();
    this.entries.clear();
  }
}
