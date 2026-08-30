import type { Candle } from '../../../core/types';
import type { SharedMarketDataRuntime } from '../../../app/services/SharedMarketDataRuntime';
import type { OrderBookLease } from '../../../core/market-data/OrderBookDataPlane';
import type { AggTradeLease } from '../../../core/market-data/AggTradeDataPlane';
import type { CandleLease } from '../../../core/market-data/CandleDataPlane';
import type { SynchronizedOrderBook } from '../../../core/market-data/SynchronizedOrderBook';
import type { RollingAggTradeBuffer } from '../../../core/market-data/RollingAggTradeBuffer';
import { LiquidityVoidDetector } from '../../../app/services/LiquidityVoidDetector';
import type { Logger } from '../../../app/ports/Logger';
import {
  AEGIS_MARKET_CONTEXT_VERSION,
  type AegisMarketContextV1,
} from './AegisMarketContext';

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
        void this.deps.sharedMarketData.candleDataPlane
          .ensureWarm(symbol, '5m', 320)
          .catch(() => undefined);
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

  /**
   * Builds the complete causal payload used for Aegis inference.
   * Returns null rather than mixing stale/legacy data into a prediction.
   */
  buildMarketContext(rawSymbol: string, candleLimit = 320): AegisMarketContextV1 | null {
    const symbol = rawSymbol.toUpperCase();
    const now = this.deps.clock.now();
    const realtime = this.read(symbol);
    if (
      realtime.status !== 'FRESH' ||
      realtime.observedAtMs === undefined ||
      realtime.ageMs === undefined ||
      realtime.bestBid === undefined ||
      realtime.bestAsk === undefined ||
      realtime.midPrice === undefined ||
      realtime.aggTradeAgeMs === undefined
    ) {
      return null;
    }

    const book = this.deps.sharedMarketData.orderBookDataPlane.get(symbol);
    const agg = this.deps.sharedMarketData.aggTradeDataPlane.get(symbol);
    if (!book || !agg) return null;
    const bookState = book.getState();
    if (bookState.health !== 'HEALTHY' || !bookState.bids.length || !bookState.asks.length) return null;

    const flow = agg.getTakerFlow(this.takerFlowWindowMs);
    if (!flow.gapFree || flow.tradeCount <= 0 || flow.eventWatermarkMs === null) return null;

    const candleSnapshot = this.deps.sharedMarketData.candleDataPlane.read(
      symbol,
      '5m',
      candleLimit,
    );
    // Warm-up REST is allowed to seed history, but a prediction must have observed
    // at least one live kline update and be fresh at capture time.
    if (
      candleSnapshot.status !== 'FRESH' ||
      candleSnapshot.source !== 'WEBSOCKET' ||
      candleSnapshot.observedAtMs === undefined ||
      candleSnapshot.ageMs === undefined ||
      candleSnapshot.websocketObservedAtMs === undefined ||
      candleSnapshot.candles.length === 0
    ) {
      return null;
    }

    this.refreshDepthDerivedState();
    const liquidity = this.detectorFor(symbol).getLiquidityStressStatus(now, this.freshnessMs);
    if (
      liquidity.status !== 'FRESH' ||
      liquidity.lastReceivedAtMs === undefined ||
      liquidity.receiveAgeMs === undefined
    ) {
      return null;
    }

    const spreadBps =
      ((realtime.bestAsk - realtime.bestBid) / Math.max(realtime.midPrice, Number.EPSILON)) * 10_000;

    return Object.freeze({
      version: AEGIS_MARKET_CONTEXT_VERSION,
      symbol,
      capturedAtMs: now,
      source: 'SHARED_MARKET_DATA_RUNTIME',
      status: 'FRESH',
      quote: Object.freeze({
        bestBid: realtime.bestBid,
        bestAsk: realtime.bestAsk,
        midPrice: realtime.midPrice,
        spreadBps,
        observedAtMs: realtime.observedAtMs,
        ageMs: realtime.ageMs,
      }),
      orderBook: Object.freeze({
        health: bookState.health,
        observedAtMs: realtime.observedAtMs,
        ageMs: realtime.ageMs,
        lastUpdateId: bookState.lastUpdateId,
        bids: Object.freeze(bookState.bids.slice(0, 20).map((level) => Object.freeze({ ...level }))),
        asks: Object.freeze(bookState.asks.slice(0, 20).map((level) => Object.freeze({ ...level }))),
      }),
      aggTrades: Object.freeze({
        windowMs: this.takerFlowWindowMs,
        observedAtMs: flow.eventWatermarkMs,
        ageMs: realtime.aggTradeAgeMs,
        gapFree: flow.gapFree,
        windowComplete: flow.windowComplete,
        tradeCount: flow.tradeCount,
        buyVolume: flow.buyVolume,
        sellVolume: flow.sellVolume,
        netTakerVolume: flow.netTakerVolume,
      }),
      candles5m: Object.freeze({
        source: candleSnapshot.source,
        status: candleSnapshot.status,
        observedAtMs: candleSnapshot.observedAtMs,
        ageMs: candleSnapshot.ageMs,
        websocketObservedAtMs: candleSnapshot.websocketObservedAtMs,
        restFallbackCount: candleSnapshot.restFallbackCount,
        candles: Object.freeze(candleSnapshot.candles.map((candle) => Object.freeze({ ...candle }))),
      }),
      liquidity: Object.freeze({
        stress: liquidity.stress,
        status: 'FRESH',
        observedAtMs: liquidity.lastReceivedAtMs,
        ageMs: liquidity.receiveAgeMs,
        inputVersion: liquidity.inputVersion,
      }),
    });
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
