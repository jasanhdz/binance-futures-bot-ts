import type { Candle } from '../../../core/types';
import type { SharedMarketDataRuntime } from '../../../app/services/SharedMarketDataRuntime';
import type { OrderBookLease } from '../../../core/market-data/OrderBookDataPlane';
import type { AggTradeLease } from '../../../core/market-data/AggTradeDataPlane';
import type { CandleLease } from '../../../core/market-data/CandleDataPlane';
import type { SynchronizedOrderBook } from '../../../core/market-data/SynchronizedOrderBook';
import type { RollingAggTradeBuffer } from '../../../core/market-data/RollingAggTradeBuffer';
import { LiquidityVoidDetector } from '../../../app/services/LiquidityVoidDetector';
import type { Logger } from '../../../app/ports/Logger';

export type AegisRealtimeMarketStatus = 'NO_DATA' | 'FRESH' | 'STALE';

export interface AegisRealtimeMarketSnapshot {
  source: 'SHARED_WEBSOCKET';
  status: AegisRealtimeMarketStatus;
  observedAtMs?: number;
  ageMs?: number;
  orderBookHealth: ReturnType<SynchronizedOrderBook['getHealth']> | 'UNAVAILABLE';
  bestBid?: number;
  bestAsk?: number;
  midPrice?: number;
  aggTradeAgeMs?: number;
  aggTradeGapFree: boolean;
  aggTradeCount: number;
  netTakerVolume: number;
}

export interface AegisRealtimeMarketStateDeps {
  sharedMarketData: SharedMarketDataRuntime;
  logger: Logger;
  clock: { now(): number };
  freshnessMs?: number;
  takerFlowWindowMs?: number;
  depthRefreshMs?: number;
}

/**
 * Operational Aegis view over application-owned shared market data.
 *
 * The class owns only leases. Binance WebSocket subscriptions remain owned by
 * SharedMarketDataRuntime. REST is limited to order-book bootstrap/resync and
 * candle warm-up/recovery inside the shared planes.
 */
export class AegisRealtimeMarketState {
  private readonly bookLeases = new Map<string, OrderBookLease<SynchronizedOrderBook>>();
  private readonly aggTradeLeases = new Map<string, AggTradeLease<RollingAggTradeBuffer>>();
  private readonly candleLeases = new Map<string, CandleLease>();
  private readonly detectors = new Map<string, LiquidityVoidDetector>();
  private readonly lastDepthObservation = new Map<string, number>();
  private readonly freshnessMs: number;
  private readonly takerFlowWindowMs: number;
  private readonly depthRefreshMs: number;
  private depthTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: AegisRealtimeMarketStateDeps) {
    this.freshnessMs = deps.freshnessMs ?? 3_000;
    this.takerFlowWindowMs = deps.takerFlowWindowMs ?? 5_000;
    this.depthRefreshMs = deps.depthRefreshMs ?? 100;
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
      if (!this.candleLeases.has(symbol)) {
        this.candleLeases.set(symbol, this.deps.sharedMarketData.candleDataPlane.acquire(symbol, '5m'));
        void this.deps.sharedMarketData.candleDataPlane.ensureWarm(symbol, '5m', 320).catch(() => undefined);
      }
      if (!this.detectors.has(symbol)) {
        this.detectors.set(symbol, new LiquidityVoidDetector(this.deps.logger));
      }
    }

    if (!this.depthTimer) {
      this.depthTimer = setInterval(() => this.refreshDepthDerivedState(), this.depthRefreshMs);
      this.depthTimer.unref?.();
    }
    this.refreshDepthDerivedState();
  }

  detectorFor(rawSymbol: string): LiquidityVoidDetector {
    const symbol = rawSymbol.toUpperCase();
    let detector = this.detectors.get(symbol);
    if (!detector) {
      detector = new LiquidityVoidDetector(this.deps.logger);
      this.detectors.set(symbol, detector);
    }
    return detector;
  }

  getCandles(rawSymbol: string, limit = 160): Candle[] {
    const symbol = rawSymbol.toUpperCase();
    return [...this.deps.sharedMarketData.candleDataPlane.read(symbol, '5m', limit).candles];
  }

  read(rawSymbol: string): AegisRealtimeMarketSnapshot {
    const symbol = rawSymbol.toUpperCase();
    const now = this.deps.clock.now();
    const book = this.deps.sharedMarketData.orderBookDataPlane.get(symbol);
    const agg = this.deps.sharedMarketData.aggTradeDataPlane.get(symbol);
    if (!book || !agg) return this.noData();

    const orderBookHealth = book.getHealth();
    const state = book.getState();
    const observedAtMs = state.observedAtMs > 0 ? state.observedAtMs : undefined;
    const ageMs = observedAtMs === undefined ? undefined : Math.max(0, now - observedAtMs);
    const bestBid = state.bids[0]?.price;
    const bestAsk = state.asks[0]?.price;
    const midPrice =
      bestBid !== undefined && bestAsk !== undefined ? (bestBid + bestAsk) / 2 : undefined;

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
        bestBid,
        bestAsk,
        midPrice,
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
      bestBid,
      bestAsk,
      midPrice,
      aggTradeAgeMs,
      aggTradeGapFree: flow.gapFree,
      aggTradeCount: flow.tradeCount,
      netTakerVolume: flow.netTakerVolume,
    };
  }

  refreshDepthDerivedState(): void {
    for (const [symbol, detector] of this.detectors.entries()) {
      const book = this.deps.sharedMarketData.orderBookDataPlane.get(symbol);
      if (!book || book.getHealth() !== 'HEALTHY') continue;
      const snapshot = book.getSnapshot();
      if (!snapshot) continue;
      if (this.lastDepthObservation.get(symbol) === snapshot.observedAtMs) continue;
      this.lastDepthObservation.set(symbol, snapshot.observedAtMs);
      detector.processDepthUpdate({
        bidDepth: snapshot.bidDepth.slice(0, 20),
        askDepth: snapshot.askDepth.slice(0, 20),
        receivedAtMs: snapshot.observedAtMs,
      });
    }
  }

  close(): void {
    if (this.depthTimer) clearInterval(this.depthTimer);
    this.depthTimer = null;
    for (const lease of this.bookLeases.values()) lease.release();
    for (const lease of this.aggTradeLeases.values()) lease.release();
    for (const lease of this.candleLeases.values()) lease.release();
    this.bookLeases.clear();
    this.aggTradeLeases.clear();
    this.candleLeases.clear();
    this.detectors.clear();
    this.lastDepthObservation.clear();
  }

  private noData(): AegisRealtimeMarketSnapshot {
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
