import { describe, expect, it, vi } from 'vitest';
import { AegisRealtimeMarketState } from './AegisRealtimeMarketState';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe('AegisRealtimeMarketState', () => {
  it('uses shared leases and derives liquidity stress from the canonical order book', () => {
    const releases = { book: 0, agg: 0, candle: 0 };
    const book = {
      getHealth: () => 'HEALTHY' as const,
      getState: () => ({
        bids: [{ price: 100, qty: 8 }, { price: 99, qty: 1 }],
        asks: [{ price: 101, qty: 2 }, { price: 102, qty: 2 }],
        observedAtMs: 9_900,
      }),
      getSnapshot: () => ({
        bidDepth: [{ price: 100, qty: 8 }, { price: 99, qty: 1 }],
        askDepth: [{ price: 101, qty: 2 }, { price: 102, qty: 2 }],
        observedAtMs: 9_900,
        status: 'HEALTHY' as const,
        lastUpdateId: 1,
        temporalHistory: [],
      }),
    };
    const agg = {
      getRecent: () => [{ receivedAtMs: 9_950, eventTime: 9_940 }],
      getTakerFlow: () => ({ gapFree: true, tradeCount: 4, netTakerVolume: 3 }),
    };
    const candlePlane = {
      acquire: vi.fn((symbol: string) => ({ symbol, interval: '5m', release: () => releases.candle++ })),
      ensureWarm: vi.fn(async () => undefined),
      read: vi.fn(() => ({ candles: [{ openTime: 0, timestamp: 0, open: 1, high: 2, low: 1, close: 2, volume: 1, buyVolume: 1, closeTime: 299_999 }], status: 'FRESH', restFallbackCount: 0 })),
    };
    const sharedMarketData = {
      orderBookDataPlane: {
        acquire: vi.fn(() => ({ state: book, release: () => releases.book++ })),
        get: vi.fn(() => book),
      },
      aggTradeDataPlane: {
        acquire: vi.fn(() => ({ state: agg, release: () => releases.agg++ })),
        get: vi.fn(() => agg),
      },
      candleDataPlane: candlePlane,
    } as any;

    const state = new AegisRealtimeMarketState({
      sharedMarketData,
      logger: logger as any,
      clock: { now: () => 10_000 },
      depthRefreshMs: 60_000,
    });

    state.start(['btcusdt']);
    state.refreshDepthDerivedState();

    expect(sharedMarketData.orderBookDataPlane.acquire).toHaveBeenCalledTimes(1);
    expect(sharedMarketData.aggTradeDataPlane.acquire).toHaveBeenCalledTimes(1);
    expect(candlePlane.acquire).toHaveBeenCalledTimes(11);
    expect(state.read('BTCUSDT')).toMatchObject({
      source: 'SHARED_WEBSOCKET',
      status: 'FRESH',
      bestBid: 100,
      bestAsk: 101,
      midPrice: 100.5,
      aggTradeGapFree: true,
      aggTradeCount: 4,
      netTakerVolume: 3,
    });
    expect(state.detectorFor('BTCUSDT').getLiquidityStressStatus(10_000, 30_000).status).toBe('FRESH');
    expect(state.getCandles('BTCUSDT', 1)).toHaveLength(1);

    state.close();
    expect(releases).toEqual({ book: 1, agg: 1, candle: 11 });
  });
});
