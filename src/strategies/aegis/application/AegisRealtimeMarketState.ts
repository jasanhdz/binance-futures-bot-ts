import type { Candle } from '../../../core/types';
import type { SharedMarketDataRuntime } from '../../../app/services/SharedMarketDataRuntime';
import type { OrderBookLease } from '../../../core/market-data/OrderBookDataPlane';
import type { AggTradeLease } from '../../../core/market-data/AggTradeDataPlane';
import type { CandleLease } from '../../../core/market-data/CandleDataPlane';
import type { CandleDataPlane } from '../../../core/market-data/CandleDataPlane';
import type { SynchronizedOrderBook } from '../../../core/market-data/SynchronizedOrderBook';
import type { RollingAggTradeBuffer } from '../../../core/market-data/RollingAggTradeBuffer';
import { LiquidityVoidDetector } from '../../../app/services/LiquidityVoidDetector';
import type { Logger } from '../../../app/ports/Logger';
import {
  AEGIS_CURRENT_BRAIN_CANONICAL_SYMBOLS,
  AEGIS_MARKET_CONTEXT_VERSION,
  type AegisCandleSeriesV1,
  type AegisMarketContextV1,
} from './AegisMarketContext';
import { registerAegisMarketContextProvider } from './AegisMarketContextRegistry';

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
  private releaseMarketContextProvider: (() => void) | null = null;

  constructor(private readonly deps: AegisRealtimeMarketStateDeps) {
    this.freshnessMs = deps.freshnessMs ?? 3_000;
    this.takerFlowWindowMs = deps.takerFlowWindowMs ?? 5_000;
    this.depthRefreshMs = deps.depthRefreshMs ?? 100;
  }

  start(symbols: readonly string[]): void {
    const activeSymbols = [...new Set(symbols.map((value) => value.toUpperCase()))];

    // Instantaneous microstructure is required only for actively evaluated symbols.
    for (const symbol of activeSymbols) {
      if (!this.bookLeases.has(symbol)) {
        this.bookLeases.set(symbol, this.deps.sharedMarketData.orderBookDataPlane.acquire(symbol));
      }
      if (!this.aggTradeLeases.has(symbol)) {
        this.aggTradeLeases.set(symbol, this.deps.sharedMarketData.aggTradeDataPlane.acquire(symbol));
      }
      if (!this.detectors.has(symbol)) {
        this.detectors.set(symbol, new LiquidityVoidDetector(this.deps.logger));
      }
    }

    // The frozen 83-feature Current Brain evaluates all 11 symbols together.
    // Keep their 5m histories warm from the shared plane without opening extra
    // order-book/aggTrade streams for symbols that are not actively traded.
    const candleSymbols = new Set<string>([
      ...AEGIS_CURRENT_BRAIN_CANONICAL_SYMBOLS,
      ...activeSymbols,
    ]);
    for (const symbol of candleSymbols) {
      if (this.candleLeases.has(symbol)) continue;
      this.candleLeases.set(symbol, this.deps.sharedMarketData.candleDataPlane.acquire(symbol, '5m'));
      void this.deps.sharedMarketData.candleDataPlane
        .ensureWarm(symbol, '5m', 320)
        .catch(() => undefined);
    }

    if (!this.releaseMarketContextProvider) {
      this.releaseMarketContextProvider = registerAegisMarketContextProvider((symbol) =>
        this.buildMarketContext(symbol),
      );
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

    const universeCandles5m: Record<string, AegisCandleSeriesV1> = {};
    for (const universeSymbol of AEGIS_CURRENT_BRAIN_CANONICAL_SYMBOLS) {
      const series = this.readFreshCandleSeries(universeSymbol, candleLimit);
      if (!series) return null;
      universeCandles5m[universeSymbol] = series;
    }
    const candleSnapshot = universeCandles5m[symbol] ?? this.readFreshCandleSeries(symbol, candleLimit);
    if (!candleSnapshot) return null;

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
      candles5m: candleSnapshot,
      universeCandles5m: Object.freeze(universeCandles5m),
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
    this.releaseMarketContextProvider?.();
    this.releaseMarketContextProvider = null;
    for (const lease of this.bookLeases.values()) lease.release();
    for (const lease of this.aggTradeLeases.values()) lease.release();
    for (const lease of this.candleLeases.values()) lease.release();
    this.bookLeases.clear();
    this.aggTradeLeases.clear();
    this.candleLeases.clear();
    this.detectors.clear();
    this.lastDepthObservation.clear();
  }

  /** DIAGNOSTIC: returns per-symbol freshness info for all canonical symbols */
  getDiagnostics(): Record<string, {
    candlePlane: ReturnType<CandleDataPlane['getDiagnostics']>;
    buildMarketContextWouldSucceed: boolean;
    buildMarketContextRejectReason?: string;
  }> {
    const result: Record<string, any> = {};
    for (const sym of AEGIS_CURRENT_BRAIN_CANONICAL_SYMBOLS) {
      const candleDiag = this.deps.sharedMarketData.candleDataPlane.getDiagnostics(sym, '5m');
      const { wouldSucceed, rejectReason } = this.diagnoseBuildMarketContext(sym);
      result[sym] = {
        candlePlane: candleDiag,
        buildMarketContextWouldSucceed: wouldSucceed,
        buildMarketContextRejectReason: rejectReason,
      };
    }
    return result;
  }

  private diagnoseBuildMarketContext(rawSymbol: string): { wouldSucceed: boolean; rejectReason?: string } {
    const symbol = rawSymbol.toUpperCase();
    const now = this.deps.clock.now();
    const realtime = this.read(symbol);
    if (realtime.status !== 'FRESH') return { wouldSucceed: false, rejectReason: `REALTIME_STATUS_${realtime.status}` };
    if (realtime.observedAtMs === undefined) return { wouldSucceed: false, rejectReason: 'NO_OBSERVED_AT' };
    if (realtime.ageMs === undefined) return { wouldSucceed: false, rejectReason: 'NO_AGE' };
    if (realtime.bestBid === undefined) return { wouldSucceed: false, rejectReason: 'NO_BEST_BID' };
    if (realtime.bestAsk === undefined) return { wouldSucceed: false, rejectReason: 'NO_BEST_ASK' };
    if (realtime.midPrice === undefined) return { wouldSucceed: false, rejectReason: 'NO_MID_PRICE' };
    if (realtime.aggTradeAgeMs === undefined) return { wouldSucceed: false, rejectReason: 'NO_AGG_TRADE_AGE' };

    const book = this.deps.sharedMarketData.orderBookDataPlane.get(symbol);
    const agg = this.deps.sharedMarketData.aggTradeDataPlane.get(symbol);
    if (!book || !agg) return { wouldSucceed: false, rejectReason: 'NO_BOOK_OR_AGG' };
    const bookState = book.getState();
    if (bookState.health !== 'HEALTHY') return { wouldSucceed: false, rejectReason: `BOOK_HEALTH_${bookState.health}` };
    if (!bookState.bids.length || !bookState.asks.length) return { wouldSucceed: false, rejectReason: 'EMPTY_BOOK' };

    const flow = agg.getTakerFlow(this.takerFlowWindowMs);
    if (!flow.gapFree) return { wouldSucceed: false, rejectReason: 'AGG_TRADE_GAP' };
    if (flow.tradeCount <= 0) return { wouldSucceed: false, rejectReason: 'NO_TRADES' };
    if (flow.eventWatermarkMs === null) return { wouldSucceed: false, rejectReason: 'NO_EVENT_WATERMARK' };

    for (const universeSymbol of AEGIS_CURRENT_BRAIN_CANONICAL_SYMBOLS) {
      const series = this.readFreshCandleSeriesWithReason(universeSymbol, 320);
      if (!series.ok) return { wouldSucceed: false, rejectReason: `CANDLE_${universeSymbol}:${series.reason}` };
    }

    const liquidity = this.detectorFor(symbol).getLiquidityStressStatus(now, this.freshnessMs);
    if (liquidity.status !== 'FRESH') return { wouldSucceed: false, rejectReason: `LIQUIDITY_STATUS_${liquidity.status}` };
    if (liquidity.lastReceivedAtMs === undefined) return { wouldSucceed: false, rejectReason: 'NO_LIQUIDITY_OBSERVED' };
    if (liquidity.receiveAgeMs === undefined) return { wouldSucceed: false, rejectReason: 'NO_LIQUIDITY_AGE' };

    return { wouldSucceed: true };
  }

  private readFreshCandleSeriesWithReason(symbol: string, limit: number): { ok: true; series: AegisCandleSeriesV1 } | { ok: false; reason: string } {
    const snapshot = this.deps.sharedMarketData.candleDataPlane.read(symbol, '5m', limit);

    const routeHealthy = this.deps.sharedMarketData.candleDataPlane.isRouteHealthy();
    if (!routeHealthy) return { ok: false, reason: 'ROUTE_UNHEALTHY' };

    const seriesInfo = this.deps.sharedMarketData.candleDataPlane.isSeriesComplete(symbol, '5m', 96);
    if (!seriesInfo.complete) return { ok: false, reason: seriesInfo.reason };

    const now = this.deps.clock.now();
    const observedAtMs = snapshot.observedAtMs ?? now;
    const ageMs = snapshot.ageMs ?? 0;

    // Filter out open candles: only include candles where closeTime <= now
    const closedCandles = snapshot.candles.filter((c) => c.closeTime <= now);

    return {
      ok: true,
      series: Object.freeze({
        source: snapshot.source ?? 'WEBSOCKET',
        status: snapshot.status,
        observedAtMs,
        ageMs,
        websocketObservedAtMs: snapshot.websocketObservedAtMs,
        restFallbackCount: snapshot.restFallbackCount,
        candles: Object.freeze(closedCandles.map((candle) => Object.freeze({ ...candle }))),
      }),
    };
  }

  private readFreshCandleSeries(symbol: string, limit: number): AegisCandleSeriesV1 | null {
    const snapshot = this.deps.sharedMarketData.candleDataPlane.read(symbol, '5m', limit);

    // SEPARATED CHECKS:
    // 1. Transport health: the WebSocket route must be alive (any symbol received events recently)
    // 2. Data completeness: the series must have 96+ closed candles, aligned, from WebSocket
    // 3. Strategic freshness: the observedAtMs age check is ONLY for the strategic symbol,
    //    NOT for every universe symbol. A quiet symbol with complete data should not invalidate context.

    const routeHealthy = this.deps.sharedMarketData.candleDataPlane.isRouteHealthy();
    const seriesInfo = this.deps.sharedMarketData.candleDataPlane.isSeriesComplete(symbol, '5m', 96);

    // FAIL-CLOSED: route must be healthy
    if (!routeHealthy) return null;

    // FAIL-CLOSED: series must be complete (96+ closed candles, aligned, no gaps, source WEBSOCKET)
    if (!seriesInfo.complete) return null;

    // The data is valid: route is alive, series is complete and aligned.
    // observedAtMs age is NOT checked here — a quiet symbol with valid closed candles
    // should not invalidate the entire context. The strategic symbol's freshness
    // is checked separately in buildMarketContext() via this.read(symbol).

    // Use observedAtMs from the snapshot if available, otherwise compute from last closed candle
    const now = this.deps.clock.now();
    const observedAtMs = snapshot.observedAtMs ?? now;
    const ageMs = snapshot.ageMs ?? 0;

    // Filter out open candles: only include candles where closeTime <= now
    const closedCandles = snapshot.candles.filter((c) => c.closeTime <= now);

    return Object.freeze({
      source: snapshot.source ?? 'WEBSOCKET',
      status: snapshot.status,
      observedAtMs,
      ageMs,
      websocketObservedAtMs: snapshot.websocketObservedAtMs,
      restFallbackCount: snapshot.restFallbackCount,
      candles: Object.freeze(closedCandles.map((candle) => Object.freeze({ ...candle }))),
    });
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
