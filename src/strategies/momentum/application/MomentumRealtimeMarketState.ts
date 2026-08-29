import type { SharedMarketDataRuntime } from '../../../app/services/SharedMarketDataRuntime';
import type { OrderBookLease } from '../../../core/market-data/OrderBookDataPlane';
import type { AggTradeLease } from '../../../core/market-data/AggTradeDataPlane';
import type { SynchronizedOrderBook } from '../../../core/market-data/SynchronizedOrderBook';
import type { RollingAggTradeBuffer } from '../../../core/market-data/RollingAggTradeBuffer';

export type MomentumRealtimeMarketStatus = 'NO_DATA' | 'FRESH' | 'STALE';

export interface MomentumRealtimeMarketSnapshot {
  source: 'SHARED_WEBSOCKET';
  status: MomentumRealtimeMarketStatus;
  observedAtMs?: number;
  ageMs?: number;
  orderBookHealth: ReturnType<SynchronizedOrderBook['getHealth']> | 'UNAVAILABLE';
  aggTradeAgeMs?: number;
  aggTradeGapFree: boolean;
  aggTradeCount: number;
  netTakerVolume: number;
}

export interface MomentumRealtimeMarketStateDeps {
  sharedMarketData: SharedMarketDataRuntime;
  clock: { now(): number };
  freshnessMs?: number;
  takerFlowWindowMs?: number;
}

/**
 * Operational Momentum market-state reader backed by the application-owned
 * shared WebSocket planes. It owns leases only; never opens duplicate feeds.
 */
export class MomentumRealtimeMarketState {
  private readonly bookLeases = new Map<string, OrderBookLease<SynchronizedOrderBook>>();
  private readonly aggTradeLeases = new Map<string, AggTradeLease<RollingAggTradeBuffer>>();
  private readonly freshnessMs: number;
  private readonly takerFlowWindowMs: number;

  constructor(private readonly deps: MomentumRealtimeMarketStateDeps) {
    this.freshnessMs = deps.freshnessMs ?? 3_000;
    this.takerFlowWindowMs = deps.takerFlowWindowMs ?? 5_000;
  }

  start(symbols: readonly string[]): void {
    for (const rawSymbol of symbols) {
      const symbol = rawSymbol.toUpperCase();
      if (!this.bookLeases.has(symbol)) {
        this.bookLeases.set(symbol, this.deps.sharedMarketData.orderBookDataPlane.acquire(symbol));
      }
      if (!this.aggTradeLeases.has(symbol)) {
        this.aggTradeLeases.set(symbol, this.deps.sharedMarketData.aggTradeDataPlane.acquire(symbol));
      }
    }
  }

  read(rawSymbol: string): MomentumRealtimeMarketSnapshot {
    const symbol = rawSymbol.toUpperCase();
    const now = this.deps.clock.now();
    const book = this.deps.sharedMarketData.orderBookDataPlane.get(symbol);
    const agg = this.deps.sharedMarketData.aggTradeDataPlane.get(symbol);
    if (!book || !agg) return this.noData();

    const orderBookHealth = book.getHealth();
    const state = book.getState();
    const observedAtMs = state.observedAtMs > 0 ? state.observedAtMs : undefined;
    const ageMs = observedAtMs === undefined ? undefined : Math.max(0, now - observedAtMs);
    const recent = agg.getRecent(this.takerFlowWindowMs);
    const lastTrade = recent[recent.length - 1];
    const lastTradeAt = lastTrade?.receivedAtMs ?? lastTrade?.eventTime;
    const aggTradeAgeMs =
      lastTradeAt === undefined ? undefined : Math.max(0, now - lastTradeAt);
    const flow = agg.getTakerFlow(this.takerFlowWindowMs);

    if (observedAtMs === undefined || aggTradeAgeMs === undefined || recent.length === 0) {
      return {
        source: 'SHARED_WEBSOCKET',
        status: 'NO_DATA',
        observedAtMs,
        ageMs,
        orderBookHealth,
        aggTradeAgeMs,
        aggTradeGapFree: flow.gapFree,
        aggTradeCount: flow.tradeCount,
        netTakerVolume: flow.netTakerVolume,
      };
    }

    const fresh =
      orderBookHealth === 'HEALTHY' &&
      ageMs !== undefined &&
      ageMs <= this.freshnessMs &&
      aggTradeAgeMs <= this.freshnessMs &&
      flow.gapFree;

    return {
      source: 'SHARED_WEBSOCKET',
      status: fresh ? 'FRESH' : 'STALE',
      observedAtMs,
      ageMs,
      orderBookHealth,
      aggTradeAgeMs,
      aggTradeGapFree: flow.gapFree,
      aggTradeCount: flow.tradeCount,
      netTakerVolume: flow.netTakerVolume,
    };
  }

  close(): void {
    for (const lease of this.bookLeases.values()) lease.release();
    for (const lease of this.aggTradeLeases.values()) lease.release();
    this.bookLeases.clear();
    this.aggTradeLeases.clear();
  }

  private noData(): MomentumRealtimeMarketSnapshot {
    return {
      source: 'SHARED_WEBSOCKET',
      status: 'NO_DATA',
      orderBookHealth: 'UNAVAILABLE',
      aggTradeGapFree: false,
      aggTradeCount: 0,
      netTakerVolume: 0,
    };
  }
}
