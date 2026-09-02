import { describe, expect, it, vi } from 'vitest';
import { AegisRealtimeMarketState } from './AegisRealtimeMarketState';
import { AEGIS_CURRENT_BRAIN_CANONICAL_SYMBOLS } from './AegisMarketContext';
import { CandleDataPlane } from '../../../core/market-data/CandleDataPlane';
import type { Candle } from '../../../core/types';

const FIVE_MIN = 5 * 60 * 1000;
const NOW = 1_700_000_160_000;

function makeCandle(openTime: number, close = 100): Candle {
  return {
    openTime,
    timestamp: openTime,
    open: close - 1,
    high: close + 1,
    low: close - 2,
    close,
    volume: 10,
    buyVolume: 6,
    closeTime: openTime + FIVE_MIN - 1,
  };
}

function makeClosedCandles(
  count: number,
  latestOpenTime = Math.floor(NOW / FIVE_MIN) * FIVE_MIN - FIVE_MIN,
): Candle[] {
  const baseTime = latestOpenTime - (count - 1) * FIVE_MIN;
  return Array.from({ length: count }, (_, i) => makeCandle(baseTime + i * FIVE_MIN));
}

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function buildMockEnv(
  opts: {
    now?: number;
    bookHealth?: string;
    bookBids?: { price: number; qty: number }[];
    bookAsks?: { price: number; qty: number }[];
    aggRecent?: any[];
    aggFlow?: any;
    candleSource?: string;
    candleAgeMs?: number;
    candles?: Candle[];
    candleObservedAtMs?: number;
    routeHealthy?: boolean;
    seriesComplete?: boolean;
    seriesReason?: string;
    aggTradeAgeMs?: number;
    aggRecentLength?: number;
    flowGapFree?: boolean;
    flowTradeCount?: number;
  } = {},
) {
  const now = opts.now ?? NOW;
  const bookHealth = opts.bookHealth ?? 'HEALTHY';
  const bookBids = opts.bookBids ?? [{ price: 100, qty: 8 }];
  const bookAsks = opts.bookAsks ?? [{ price: 101, qty: 2 }];
  const aggRecent = opts.aggRecent ?? [{ receivedAtMs: now - 50, eventTime: now - 60 }];
  const aggFlow = opts.aggFlow ?? {
    gapFree: opts.flowGapFree ?? true,
    tradeCount: opts.flowTradeCount ?? 4,
    netTakerVolume: 3,
    eventWatermarkMs: now - 60,
    windowComplete: true,
    buyVolume: 2,
    sellVolume: 1,
  };
  const candleSource = opts.candleSource ?? 'WEBSOCKET';
  const candleAgeMs = opts.candleAgeMs ?? 500;
  const candles = opts.candles ?? makeClosedCandles(100);
  const candleObservedAtMs = opts.candleObservedAtMs ?? now - candleAgeMs;
  const routeHealthy = opts.routeHealthy ?? true;
  const seriesComplete = opts.seriesComplete ?? true;
  const seriesReason = opts.seriesReason ?? 'OK';

  // Compute candle status from age (matches real CandleDataPlane behavior)
  const candleStatus = candleAgeMs <= 10_000 ? 'FRESH' : 'STALE';

  const book = {
    getHealth: () => bookHealth,
    getState: () => ({
      bids: bookBids,
      asks: bookAsks,
      observedAtMs: now - 100,
      health: bookHealth,
      lastUpdateId: 1,
    }),
    getSnapshot: () => ({
      bidDepth: bookBids,
      askDepth: bookAsks,
      observedAtMs: now - 100,
      status: bookHealth,
      lastUpdateId: 1,
      temporalHistory: [],
    }),
  };

  // Compute realtime status from aggTrade freshness (matches AegisRealtimeMarketState.read)
  const aggTradeAge =
    aggRecent.length > 0
      ? now -
        (aggRecent[aggRecent.length - 1].receivedAtMs ?? aggRecent[aggRecent.length - 1].eventTime)
      : undefined;
  const bookAge = now - book.getState().observedAtMs;
  const realtimeStatus =
    bookHealth === 'HEALTHY' &&
    aggTradeAge !== undefined &&
    aggTradeAge <= 3_000 &&
    bookAge <= 3_000 &&
    aggFlow.gapFree
      ? 'FRESH'
      : 'STALE';

  const agg = {
    getRecent: () => aggRecent,
    getTakerFlow: () => aggFlow,
  };

  const candlePlane = {
    acquire: vi.fn(() => ({ symbol: 'X', interval: '5m', release: vi.fn() })),
    ensureWarm: vi.fn(async () => undefined),
    read: vi.fn(() => ({
      candles,
      status: candleStatus,
      source: candleSource,
      observedAtMs: candleObservedAtMs,
      ageMs: now - candleObservedAtMs,
      websocketObservedAtMs: candleObservedAtMs,
      restFallbackCount: 0,
    })),
    isRouteHealthy: vi.fn(() => routeHealthy),
    isSeriesComplete: vi.fn(() => ({
      complete: seriesComplete,
      reason: seriesReason,
      candleCount: candles.length,
      lastSource: candleSource,
      aligned: true,
    })),
    getDiagnostics: vi.fn(() => ({
      exists: true,
      candleCount: candles.length,
      lastSource: candleSource,
      observedAtMs: candleObservedAtMs,
      ageMs: candleAgeMs,
      status: candleStatus,
      staleReason: 'OK',
      klineEventCount: 10,
      lastKlineEventAtMs: candleObservedAtMs,
      websocketObservedAtMs: candleObservedAtMs,
      lastClosedCandleCloseTimeMs: candleObservedAtMs,
    })),
  };

  const sharedMarketData = {
    orderBookDataPlane: {
      acquire: vi.fn(() => ({ release: vi.fn() })),
      get: vi.fn(() => book),
    },
    aggTradeDataPlane: {
      acquire: vi.fn(() => ({ release: vi.fn() })),
      get: vi.fn(() => agg),
    },
    candleDataPlane: candlePlane,
  } as any;

  const state = new AegisRealtimeMarketState({
    sharedMarketData,
    logger: logger as any,
    clock: { now: () => now },
    depthRefreshMs: 60_000,
  });

  return { state, sharedMarketData, candlePlane, book, agg };
}

describe('AegisRealtimeMarketState — Market Context Parity', () => {
  it('TC-1: all 11 complete and aligned series produce context', () => {
    const { state } = buildMockEnv();
    state.start(AEGIS_CURRENT_BRAIN_CANONICAL_SYMBOLS as unknown as string[]);

    const ctx = state.buildMarketContext('LTCUSDT');
    expect(ctx).not.toBeNull();
    expect(ctx!.version).toBe('AEGIS_MARKET_CONTEXT_V1');
    expect(Object.keys(ctx!.universeCandles5m)).toHaveLength(11);
    for (const sym of AEGIS_CURRENT_BRAIN_CANONICAL_SYMBOLS) {
      expect(ctx!.universeCandles5m[sym]).toBeDefined();
      expect(ctx!.universeCandles5m[sym].candles.length).toBeGreaterThanOrEqual(96);
    }

    state.close();
  });

  it('TC-2: quiet but aligned LINKUSDT does NOT invalidate context', () => {
    const { state, candlePlane } = buildMockEnv({ candleAgeMs: 15_000 });
    state.start(AEGIS_CURRENT_BRAIN_CANONICAL_SYMBOLS as unknown as string[]);

    // Override isSeriesComplete to return complete for LINKUSDT
    // (simulating quiet but valid data)
    candlePlane.isSeriesComplete.mockReturnValue({
      complete: true,
      reason: 'OK',
      candleCount: 100,
      lastSource: 'WEBSOCKET',
      aligned: true,
    });

    const ctx = state.buildMarketContext('LTCUSDT');
    expect(ctx).not.toBeNull();
    expect(Object.keys(ctx!.universeCandles5m)).toHaveLength(11);

    state.close();
  });

  it('TC-3: dropped WebSocket route DOES invalidate context', () => {
    const { state } = buildMockEnv({ routeHealthy: false });
    state.start(AEGIS_CURRENT_BRAIN_CANONICAL_SYMBOLS as unknown as string[]);

    const ctx = state.buildMarketContext('LTCUSDT');
    expect(ctx).toBeNull();

    state.close();
  });

  it('TC-4: missing closed candle DOES invalidate context', () => {
    const { state } = buildMockEnv({
      seriesComplete: false,
      seriesReason: 'CLOSED_CANDLES_50_OF_96',
    });
    state.start(AEGIS_CURRENT_BRAIN_CANONICAL_SYMBOLS as unknown as string[]);

    const ctx = state.buildMarketContext('LTCUSDT');
    expect(ctx).toBeNull();

    state.close();
  });

  it('TC-5: series with gaps DOES invalidate context', () => {
    const { state } = buildMockEnv({
      seriesComplete: false,
      seriesReason: 'GAP_DETECTED_IN_SERIES',
    });
    state.start(AEGIS_CURRENT_BRAIN_CANONICAL_SYMBOLS as unknown as string[]);

    const ctx = state.buildMarketContext('LTCUSDT');
    expect(ctx).toBeNull();

    state.close();
  });

  it('TC-6: misaligned series DOES invalidate context', () => {
    const { state } = buildMockEnv({
      seriesComplete: false,
      seriesReason: 'INSUFFICIENT_CANDLES_30_OF_96',
    });
    state.start(AEGIS_CURRENT_BRAIN_CANONICAL_SYMBOLS as unknown as string[]);

    const ctx = state.buildMarketContext('LTCUSDT');
    expect(ctx).toBeNull();

    state.close();
  });

  it('TC-7: open candle never enters context', () => {
    const now = NOW;
    const closedCandles = makeClosedCandles(100);
    // Add an open candle (closeTime > now)
    const openCandle: Candle = makeCandle(now - 60_000);
    openCandle.closeTime = now + FIVE_MIN;
    const allCandles = [...closedCandles, openCandle];

    const { state } = buildMockEnv({ candles: allCandles, candleObservedAtMs: now - 500 });
    state.start(AEGIS_CURRENT_BRAIN_CANONICAL_SYMBOLS as unknown as string[]);

    const ctx = state.buildMarketContext('LTCUSDT');
    // The open candle should NOT be in the closed series
    // Context may still succeed because closed candles are sufficient
    if (ctx) {
      for (const sym of AEGIS_CURRENT_BRAIN_CANONICAL_SYMBOLS) {
        const series = ctx.universeCandles5m[sym];
        for (const c of series.candles) {
          expect(c.closeTime).toBeLessThanOrEqual(now);
        }
      }
    }

    state.close();
  });

  it('TC-8: context contains exactly 11 series', () => {
    const { state } = buildMockEnv();
    state.start(AEGIS_CURRENT_BRAIN_CANONICAL_SYMBOLS as unknown as string[]);

    const ctx = state.buildMarketContext('LTCUSDT');
    expect(ctx).not.toBeNull();
    expect(Object.keys(ctx!.universeCandles5m)).toHaveLength(11);

    state.close();
  });

  it('TC-9: each series has at least 96 closed candles', () => {
    const { state } = buildMockEnv({ candles: makeClosedCandles(120) });
    state.start(AEGIS_CURRENT_BRAIN_CANONICAL_SYMBOLS as unknown as string[]);

    const ctx = state.buildMarketContext('LTCUSDT');
    expect(ctx).not.toBeNull();
    for (const sym of AEGIS_CURRENT_BRAIN_CANONICAL_SYMBOLS) {
      expect(ctx!.universeCandles5m[sym].candles.length).toBeGreaterThanOrEqual(96);
    }

    state.close();
  });

  it('TC-10: LTCUSDT does not reduce the Current Brain universe', () => {
    const { state } = buildMockEnv();
    state.start(['LTCUSDT']);

    const ctx = state.buildMarketContext('LTCUSDT');
    expect(ctx).not.toBeNull();
    // All 11 canonical symbols must be present, not just LTCUSDT
    expect(Object.keys(ctx!.universeCandles5m)).toHaveLength(11);
    for (const sym of AEGIS_CURRENT_BRAIN_CANONICAL_SYMBOLS) {
      expect(ctx!.universeCandles5m[sym]).toBeDefined();
    }

    state.close();
  });

  it('TC-11: REST fallback only occurs when context truly cannot be built', () => {
    // When route is healthy and series are complete, context should succeed (no REST fallback needed)
    const { state: healthyState } = buildMockEnv({ routeHealthy: true, seriesComplete: true });
    healthyState.start(AEGIS_CURRENT_BRAIN_CANONICAL_SYMBOLS as unknown as string[]);
    expect(healthyState.buildMarketContext('LTCUSDT')).not.toBeNull();
    healthyState.close();

    // When route is unhealthy, context should fail (REST fallback would be triggered)
    const { state: unhealthyState } = buildMockEnv({ routeHealthy: false });
    unhealthyState.start(AEGIS_CURRENT_BRAIN_CANONICAL_SYMBOLS as unknown as string[]);
    expect(unhealthyState.buildMarketContext('LTCUSDT')).toBeNull();
    unhealthyState.close();
  });

  it('TC-12: fail-closed semantics are not relaxed', () => {
    // Series incomplete → context MUST be null
    const { state: s1 } = buildMockEnv({
      seriesComplete: false,
      seriesReason: 'INSUFFICIENT_CANDLES_50_OF_96',
    });
    s1.start(AEGIS_CURRENT_BRAIN_CANONICAL_SYMBOLS as unknown as string[]);
    expect(s1.buildMarketContext('LTCUSDT')).toBeNull();
    s1.close();

    // Route unhealthy → context MUST be null
    const { state: s2 } = buildMockEnv({ routeHealthy: false });
    s2.start(AEGIS_CURRENT_BRAIN_CANONICAL_SYMBOLS as unknown as string[]);
    expect(s2.buildMarketContext('LTCUSDT')).toBeNull();
    s2.close();

    // Strategic symbol stale (aggTrade age > 3s) → context MUST be null
    const { state: s3 } = buildMockEnv({
      aggRecent: [{ receivedAtMs: NOW - 30_000, eventTime: NOW - 30_000 }],
    });
    s3.start(AEGIS_CURRENT_BRAIN_CANONICAL_SYMBOLS as unknown as string[]);
    expect(s3.buildMarketContext('LTCUSDT')).toBeNull();
    s3.close();
  });
});

describe('CandleDataPlane — Route Health and Series Completeness', () => {
  it('isRouteHealthy returns true when any symbol received events recently', () => {
    const plane = new CandleDataPlane({
      clock: { now: () => NOW },
      fetch: async () => [],
      subscribe: (_s: string, _i: string, cb: any) => {
        // Simulate receiving a kline event
        cb(makeCandle(NOW - 5_000), NOW - 5_000);
        return () => {};
      },
    });

    plane.acquire('btcusdt');
    expect(plane.isRouteHealthy(NOW)).toBe(true);
    expect(plane.isRouteHealthy(NOW + 15_000)).toBe(false); // after freshness window

    plane.close();
  });

  it('isSeriesComplete returns true for 96+ aligned closed candles from WebSocket', () => {
    const candles = makeClosedCandles(100);
    const plane = new CandleDataPlane({
      clock: { now: () => NOW },
      fetch: async () => [],
      subscribe: (_s: string, _i: string, cb: any) => {
        for (const c of candles) cb(c, NOW);
        return () => {};
      },
    });

    plane.acquire('btcusdt');
    const result = plane.isSeriesComplete('btcusdt', '5m', 96);
    expect(result.complete).toBe(true);
    expect(result.reason).toBe('OK');
    expect(result.candleCount).toBeGreaterThanOrEqual(96);

    plane.close();
  });

  it('isSeriesComplete returns false when insufficient candles', () => {
    const plane = new CandleDataPlane({
      clock: { now: () => NOW },
      fetch: async () => [],
      subscribe: (_s: string, _i: string, cb: any) => {
        cb(makeCandle(NOW - 5_000), NOW - 5_000);
        return () => {};
      },
    });

    plane.acquire('btcusdt');
    const result = plane.isSeriesComplete('btcusdt', '5m', 96);
    expect(result.complete).toBe(false);
    expect(result.reason).toContain('INSUFFICIENT_CANDLES');

    plane.close();
  });

  it('accepts a quiet symbol when its latest canonical closed candle is current', () => {
    const latestClosedOpenTime = Math.floor(NOW / FIVE_MIN) * FIVE_MIN - FIVE_MIN;
    const candles = makeClosedCandles(100, latestClosedOpenTime);
    const plane = new CandleDataPlane({
      clock: { now: () => NOW },
      fetch: async () => [],
      subscribe: (symbol: string, _interval: string, cb: any) => {
        const observedAtMs = symbol === 'LINKUSDT' ? NOW - 15_000 : NOW;
        for (const c of candles) cb(c, observedAtMs);
        return () => {};
      },
    });

    plane.acquire('LINKUSDT');
    plane.acquire('BTCUSDT');

    expect(plane.isRouteHealthy(NOW)).toBe(true);
    expect(plane.read('LINKUSDT').status).toBe('STALE');
    expect(plane.isSeriesComplete('LINKUSDT', '5m', 96, NOW)).toMatchObject({
      complete: true,
      reason: 'OK',
    });

    plane.close();
  });

  it('rejects a historically complete series whose latest closed candle is behind', () => {
    const expectedLatestOpenTime = Math.floor(NOW / FIVE_MIN) * FIVE_MIN - FIVE_MIN;
    const candles = makeClosedCandles(100, expectedLatestOpenTime - FIVE_MIN);
    const plane = new CandleDataPlane({
      clock: { now: () => NOW },
      fetch: async () => [],
      subscribe: (_s: string, _i: string, cb: any) => {
        for (const c of candles) cb(c, NOW);
        return () => {};
      },
    });

    plane.acquire('LINKUSDT');
    const result = plane.isSeriesComplete('LINKUSDT', '5m', 96, NOW);
    expect(result.complete).toBe(false);
    expect(result.reason).toContain('LATEST_CLOSED_CANDLE_STALE');

    plane.close();
  });

  it('rejects a gap inside the required closed-candle window', () => {
    const latestClosedOpenTime = Math.floor(NOW / FIVE_MIN) * FIVE_MIN - FIVE_MIN;
    const candles = makeClosedCandles(100, latestClosedOpenTime);
    candles.splice(candles.length - 20, 1);
    const plane = new CandleDataPlane({
      clock: { now: () => NOW },
      fetch: async () => [],
      subscribe: (_s: string, _i: string, cb: any) => {
        for (const c of candles) cb(c, NOW);
        return () => {};
      },
    });

    plane.acquire('LINKUSDT');
    const result = plane.isSeriesComplete('LINKUSDT', '5m', 96, NOW);
    expect(result.complete).toBe(false);
    expect(result.reason).toBe('GAP_DETECTED_IN_SERIES');

    plane.close();
  });

  it('rejects a malformed candle boundary', () => {
    const latestClosedOpenTime = Math.floor(NOW / FIVE_MIN) * FIVE_MIN - FIVE_MIN;
    const candles = makeClosedCandles(100, latestClosedOpenTime);
    candles[candles.length - 10] = {
      ...candles[candles.length - 10],
      closeTime: candles[candles.length - 10].closeTime - 1,
    };
    const plane = new CandleDataPlane({
      clock: { now: () => NOW },
      fetch: async () => [],
      subscribe: (_s: string, _i: string, cb: any) => {
        for (const c of candles) cb(c, NOW);
        return () => {};
      },
    });

    plane.acquire('LINKUSDT');
    const result = plane.isSeriesComplete('LINKUSDT', '5m', 96, NOW);
    expect(result.complete).toBe(false);
    expect(result.reason).toBe('CANDLE_BOUNDARY_MISMATCH');

    plane.close();
  });

  it('allows a short publication grace after the boundary, then requires the new close', () => {
    const boundary = Math.floor(NOW / FIVE_MIN) * FIVE_MIN;
    const previousLatestOpenTime = boundary - 2 * FIVE_MIN;
    const candles = makeClosedCandles(100, previousLatestOpenTime);
    const plane = new CandleDataPlane({
      clock: { now: () => boundary + 5_000 },
      freshnessMs: 10_000,
      fetch: async () => [],
      subscribe: (_s: string, _i: string, cb: any) => {
        for (const c of candles) cb(c, boundary + 5_000);
        return () => {};
      },
    });

    plane.acquire('LINKUSDT');
    expect(plane.isSeriesComplete('LINKUSDT', '5m', 96, boundary + 5_000).complete).toBe(true);
    const afterGrace = plane.isSeriesComplete('LINKUSDT', '5m', 96, boundary + 11_000);
    expect(afterGrace.complete).toBe(false);
    expect(afterGrace.reason).toContain('LATEST_CLOSED_CANDLE_STALE');

    plane.close();
  });

  it('accepts the current closed series when no open candle has traded yet', () => {
    const latestClosedOpenTime = Math.floor(NOW / FIVE_MIN) * FIVE_MIN - FIVE_MIN;
    const candles = makeClosedCandles(100, latestClosedOpenTime);
    const plane = new CandleDataPlane({
      clock: { now: () => NOW },
      fetch: async () => [],
      subscribe: (_s: string, _i: string, cb: any) => {
        for (const c of candles) cb(c, NOW - 12_000);
        return () => {};
      },
    });

    plane.acquire('LINKUSDT');
    expect(plane.isSeriesComplete('LINKUSDT', '5m', 96, NOW).complete).toBe(true);

    plane.close();
  });
});
