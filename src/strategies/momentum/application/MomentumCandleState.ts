import type { Candle } from '../../../core/types';
import type { CandleLease, SharedCandleSnapshot } from '../../../core/market-data/CandleDataPlane';
import type { SharedMarketDataRuntime } from '../../../app/services/SharedMarketDataRuntime';

export interface MomentumCandleSnapshot {
  candles: Candle[];
  source?: SharedCandleSnapshot['source'];
  status: SharedCandleSnapshot['status'];
  observedAtMs?: number;
  ageMs?: number;
  websocketObservedAtMs?: number;
  restFallbackCount: number;
  usedRestFallback: boolean;
}

/**
 * Momentum-specific view over the application-owned shared 5m candle plane.
 * REST is used only for history warm-up and stale recovery; the steady-state
 * candle is fed by the shared Binance kline WebSocket.
 */
export class MomentumCandleState {
  private readonly leases = new Map<string, CandleLease>();

  constructor(
    private readonly sharedMarketData: SharedMarketDataRuntime,
    private readonly interval = '5m',
    private readonly warmupLimit = 320,
  ) {}

  start(symbols: readonly string[]): void {
    for (const rawSymbol of symbols) {
      const symbol = rawSymbol.toUpperCase();
      if (this.leases.has(symbol)) continue;
      this.leases.set(symbol, this.sharedMarketData.candleDataPlane.acquire(symbol, this.interval));
      void this.sharedMarketData.candleDataPlane
        .ensureWarm(symbol, this.interval, this.warmupLimit)
        .catch(() => undefined);
    }
  }

  async read(rawSymbol: string, limit = 300): Promise<MomentumCandleSnapshot> {
    const symbol = rawSymbol.toUpperCase();
    if (!this.leases.has(symbol)) {
      this.leases.set(symbol, this.sharedMarketData.candleDataPlane.acquire(symbol, this.interval));
    }

    let snapshot = this.sharedMarketData.candleDataPlane.read(symbol, this.interval, limit);
    let usedRestFallback = false;

    if (snapshot.candles.length < limit) {
      await this.sharedMarketData.candleDataPlane.ensureWarm(symbol, this.interval, this.warmupLimit);
      snapshot = this.sharedMarketData.candleDataPlane.read(symbol, this.interval, limit);
    } else if (snapshot.status === 'STALE') {
      await this.sharedMarketData.candleDataPlane.recover(symbol, this.interval, this.warmupLimit);
      usedRestFallback = true;
      snapshot = this.sharedMarketData.candleDataPlane.read(symbol, this.interval, limit);
    }

    return {
      candles: [...snapshot.candles],
      source: snapshot.source,
      status: snapshot.status,
      observedAtMs: snapshot.observedAtMs,
      ageMs: snapshot.ageMs,
      websocketObservedAtMs: snapshot.websocketObservedAtMs,
      restFallbackCount: snapshot.restFallbackCount,
      usedRestFallback,
    };
  }

  close(): void {
    for (const lease of this.leases.values()) lease.release();
    this.leases.clear();
  }
}
