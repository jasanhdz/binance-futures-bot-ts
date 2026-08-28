import { describe, expect, it } from 'vitest';
import type {
  CandleObservation,
  CandleSeriesSnapshot,
  OrderBookState,
  QuoteSnapshot,
} from '../../app/ports/MarketData';
import {
  AGG_TRADE_SNAPSHOT_WINDOW_MS,
  MarketSnapshotProvider,
  type MarketSnapshotSources,
  type SnapshotClock,
} from './MarketSnapshotProvider';

function clock(...values: number[]): SnapshotClock {
  let index = 0;
  return { now: () => values[Math.min(index++, values.length - 1)] };
}

function quote(observedAtMs = 1_500): QuoteSnapshot {
  return {
    symbol: 'ETHUSDT',
    bid: 100,
    ask: 100.1,
    mid: 100.05,
    spread: 0.1,
    spreadBps: 10,
    health: 'HEALTHY',
    observedAtMs,
    source: 'SYNCHRONIZED_ORDER_BOOK',
  };
}

function book(): OrderBookState {
  return {
    bids: Array.from({ length: 10 }, (_, index) => ({ price: 100 - index, qty: 2 })),
    asks: Array.from({ length: 10 }, (_, index) => ({ price: 101 + index, qty: 1 })),
    lastUpdateId: 1,
    health: 'HEALTHY',
    observedAtMs: 1_500,
    lastSyncAtMs: 1_400,
    lastDiffAtMs: 1_450,
    gapCount: 0,
    resyncCount: 0,
  };
}

function flow() {
  return {
    buyVolume: 3,
    sellVolume: 1,
    netTakerVolume: 2,
    tradeCount: 4,
    requestedWindowMs: 300_000,
    observedWindowMs: 300_000,
    observedSampleCount: 4,
    eventWatermarkMs: 9_000,
    capacityTruncated: false,
    coverageStartedAtMs: 8_000,
    windowComplete: true,
    gapFree: true,
  };
}

function candles(observedAtMs = 1_500): CandleSeriesSnapshot {
  const candle: CandleObservation = {
    symbol: 'ETHUSDT',
    interval: '1m',
    openTime: 0,
    closeTime: 60_000,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 10,
    buyVolume: 5,
    status: 'CLOSED',
    observedAtMs,
    source: 'REST',
  };
  return {
    symbol: 'ETHUSDT',
    interval: '1m',
    candles: [candle],
    health: 'HEALTHY',
    observedAtMs,
    exchangeSnapshotTimeMs: 60_000,
    gapCount: 0,
    hasGaps: false,
    gapCheck: 'CHECKED',
    source: 'REST',
  };
}

function primarySources(
  quoteSnapshot = quote(),
  flowReader: (windowMs: number) => ReturnType<typeof flow> = () => flow(),
): MarketSnapshotSources {
  return {
    quoteFor: () => ({ getQuote: () => quoteSnapshot }),
    aggTradeFor: () => ({ getTakerFlow: flowReader }),
  };
}

describe('MarketSnapshotProvider', () => {
  it('returns an explicit not-requested snapshot without touching sources', async () => {
    let reads = 0;
    const provider = new MarketSnapshotProvider(
      {
        quoteFor: () => {
          reads += 1;
          return undefined;
        },
      },
      clock(1_000, 1_001),
    );

    const snapshot = await provider.capture({ symbol: 'ethusdt' });

    expect(snapshot.symbol).toBe('ETHUSDT');
    expect(snapshot.health).toBe('UNAVAILABLE');
    expect(snapshot.primary.quote).toMatchObject({
      requested: false,
      status: 'NOT_REQUESTED',
      sourceTimestampDomain: 'NONE',
    });
    expect(reads).toBe(0);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.primary)).toBe(true);
  });

  it('assembles healthy capabilities with separate local and event-time clocks', async () => {
    let requestedWindow: number | undefined;
    const provider = new MarketSnapshotProvider(
      {
        quoteFor: () => ({ getQuote: () => quote() }),
        orderBookFor: () => ({
          start: () => undefined,
          stop: () => undefined,
          getState: () => book(),
          getHealth: () => 'HEALTHY' as const,
          getSnapshot: () => undefined,
        }),
        aggTradeFor: () => ({
          getTakerFlow: (windowMs) => {
            requestedWindow = windowMs;
            return flow();
          },
        }),
      },
      clock(1_000, 2_000),
    );

    const snapshot = await provider.capture({
      symbol: 'ethusdt',
      quote: true,
      orderBookFeatures: true,
      aggTrade: true,
    });

    expect(snapshot.health).toBe('COMPLETE');
    expect(snapshot.primary.quote.value?.spreadBps).toBe(10);
    expect(snapshot.primary.quote.sourceTimestampDomain).toBe('LOCAL_CAPTURE');
    expect(snapshot.primary.aggTrade.value?.observedAtMs).toBe(9_000);
    expect(snapshot.primary.aggTrade.sourceTimestampDomain).toBe('EVENT_TIME');
    expect(snapshot.primary.aggTrade.requestedWindowMs).toBe(300_000);
    expect(requestedWindow).toBe(AGG_TRADE_SNAPSHOT_WINDOW_MS);
    expect(snapshot.snapshotId).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps valid families when another requested family fails', async () => {
    const provider = new MarketSnapshotProvider(
      {
        quoteFor: () => {
          throw new Error('quote failed');
        },
        aggTradeFor: () => ({ getTakerFlow: () => flow() }),
      },
      clock(1_000, 2_000),
    );

    const snapshot = await provider.capture({
      symbol: 'ETHUSDT',
      quote: true,
      aggTrade: { windowMs: 300_000 },
    });

    expect(snapshot.health).toBe('PARTIAL');
    expect(snapshot.primary.quote.status).toBe('UNAVAILABLE');
    expect(snapshot.primary.quote.error).toContain('quote failed');
    expect(snapshot.primary.aggTrade.status).toBe('AVAILABLE');
  });

  it('rejects a future local observation but does not reject a future event watermark', async () => {
    const provider = new MarketSnapshotProvider(
      {
        quoteFor: () => ({ getQuote: () => quote(3_000) }),
        aggTradeFor: () => ({ getTakerFlow: () => ({ ...flow(), eventWatermarkMs: 3_000 }) }),
      },
      clock(1_000, 2_000),
    );

    const snapshot = await provider.capture({
      symbol: 'ETHUSDT',
      quote: true,
      aggTrade: { windowMs: 300_000 },
    });

    expect(snapshot.primary.quote).toMatchObject({
      status: 'UNAVAILABLE',
      health: 'ANOMALOUS',
      error: 'SOURCE_OBSERVED_AFTER_CAPTURE_BOUNDARY',
      sourceTimestampMs: 3_000,
    });
    expect(snapshot.primary.aggTrade.status).toBe('AVAILABLE');
    expect(snapshot.health).toBe('PARTIAL');
  });

  it('preserves unsupported flow metadata without reading the flow source', async () => {
    let reads = 0;
    const provider = new MarketSnapshotProvider(
      primarySources(undefined, () => {
        reads += 1;
        return flow();
      }),
      clock(1_000, 2_000),
    );

    const snapshot = await provider.capture({
      symbol: 'ETHUSDT',
      aggTrade: { windowMs: 5_000 },
    });

    expect(snapshot.primary.aggTrade).toMatchObject({
      requested: true,
      status: 'UNAVAILABLE',
      error: 'Error: AGG_TRADE_WINDOW_NOT_SUPPORTED',
      requestedWindowMs: 5_000,
    });
    expect(snapshot.provenance.request.aggTrade).toEqual({ windowMs: 5_000 });
    expect(reads).toBe(0);
  });

  it('distinguishes not-requested from requested-but-unavailable capabilities', async () => {
    const notRequested = await new MarketSnapshotProvider({}, clock(1_000, 2_000)).capture({
      symbol: 'ETHUSDT',
    });
    const unavailable = await new MarketSnapshotProvider({}, clock(1_000, 2_000)).capture({
      symbol: 'ETHUSDT',
      quote: true,
    });

    expect(notRequested.primary.quote).toMatchObject({
      requested: false,
      status: 'NOT_REQUESTED',
      health: 'NOT_REQUESTED',
      value: null,
      sourceTimestampDomain: 'NONE',
    });
    expect(unavailable.primary.quote).toMatchObject({
      requested: true,
      status: 'UNAVAILABLE',
      health: 'UNAVAILABLE',
      value: null,
      sourceTimestampDomain: 'LOCAL_CAPTURE',
    });
  });

  it('rejects reversed capture boundaries', async () => {
    await expect(
      new MarketSnapshotProvider({}, clock(2_000, 1_000)).capture({ symbol: 'ETHUSDT' }),
    ).rejects.toThrow('INVALID_SNAPSHOT_CAPTURE_BOUNDARY');
  });

  it('assembles candles only when requested and preserves both timestamp domains', async () => {
    let reads = 0;
    const provider = new MarketSnapshotProvider(
      {
        candles: {
          getSeries: async (symbol, interval, limit) => {
            reads += 1;
            expect(symbol).toBe('ETHUSDT');
            expect(interval).toBe('1m');
            expect(limit).toBe(7);
            return candles();
          },
        },
      },
      clock(1_000, 2_000),
    );
    const snapshot = await provider.capture({
      symbol: 'ETHUSDT',
      candles: { interval: '1m', limit: 7 },
    });

    expect(reads).toBe(1);
    expect(snapshot.primary.candles).toMatchObject({
      interval: '1m',
      limit: 7,
      sourceTimestampMs: 1_500,
      sourceTimestampDomain: 'LOCAL_CAPTURE',
      value: { observedAtMs: 1_500, exchangeSnapshotTimeMs: 60_000 },
    });

    const future = await new MarketSnapshotProvider(
      { candles: { getSeries: async () => candles(3_000) } },
      clock(1_000, 2_000),
    ).capture({ symbol: 'ETHUSDT', candles: { interval: '1m', limit: 7 } });
    expect(future.primary.candles).toMatchObject({
      status: 'UNAVAILABLE',
      error: 'SOURCE_OBSERVED_AFTER_CAPTURE_BOUNDARY',
    });
  });

  it('keeps benchmark composition generic and isolated from primary failures', async () => {
    const benchmark = (descriptor: { id: string; symbol: string }) => ({
      descriptor,
      candles: { getSeries: async () => candles() },
      quote: { getQuote: () => quote() },
    });
    const provider = new MarketSnapshotProvider(
      {
        ...primarySources(),
        benchmark: { getBenchmark: benchmark },
      },
      clock(1_000, 2_000),
    );

    const btc = await provider.capture({
      symbol: 'ETHUSDT',
      benchmark: {
        descriptor: { id: 'PRIMARY_CRYPTO_BENCHMARK', symbol: 'btcusdt' },
        quote: true,
        candles: { interval: '1m', limit: 1 },
      },
    });
    const eth = await new MarketSnapshotProvider(
      {
        ...primarySources(),
        benchmark: { getBenchmark: benchmark },
      },
      clock(1_000, 2_000),
    ).capture({
      symbol: 'ETHUSDT',
      benchmark: {
        descriptor: { id: 'SECONDARY_CRYPTO_BENCHMARK', symbol: 'ethusdt' },
        quote: true,
        candles: { interval: '1m', limit: 1 },
      },
    });

    expect(btc.benchmark?.descriptor).toEqual({
      id: 'PRIMARY_CRYPTO_BENCHMARK',
      symbol: 'BTCUSDT',
    });
    expect(eth.benchmark?.descriptor.symbol).toBe('ETHUSDT');
    expect(btc.benchmark?.data.candles.status).toBe('AVAILABLE');
    expect(btc.benchmark?.data.quote.status).toBe('AVAILABLE');
    expect(Object.isFrozen(btc)).toBe(true);
    expect(Object.isFrozen(btc.primary)).toBe(true);
    expect(Object.isFrozen(btc.primary.quote)).toBe(true);
    expect(Object.isFrozen(btc.primary.quote.value)).toBe(true);
    expect(Object.isFrozen(btc.provenance)).toBe(true);
    expect(Object.isFrozen(btc.provenance.request)).toBe(true);
    expect(Object.isFrozen(btc.benchmark)).toBe(true);
    expect(Object.isFrozen(btc.benchmark?.descriptor)).toBe(true);
    expect(Object.isFrozen(btc.benchmark?.data)).toBe(true);

    const primaryFailure = await new MarketSnapshotProvider(
      {
        quoteFor: () => undefined,
        benchmark: { getBenchmark: benchmark },
      },
      clock(1_000, 2_000),
    ).capture({
      symbol: 'ETHUSDT',
      quote: true,
      benchmark: {
        descriptor: { id: 'PRIMARY_CRYPTO_BENCHMARK', symbol: 'BTCUSDT' },
        candles: { interval: '1m', limit: 1 },
      },
    });
    expect(primaryFailure.benchmark?.data.candles.status).toBe('AVAILABLE');
  });

  it('uses canonical identity across object order and changes it for meaningful evidence', async () => {
    const capture = (
      sources: MarketSnapshotSources,
      request: Parameters<MarketSnapshotProvider['capture']>[0],
      times = [1_000, 2_000],
    ) => new MarketSnapshotProvider(sources, clock(...times)).capture(request);
    const baseRequest = {
      symbol: 'ETHUSDT',
      quote: true,
      aggTrade: { windowMs: 5_000 },
      benchmark: {
        descriptor: { id: 'PRIMARY_CRYPTO_BENCHMARK', symbol: 'btcusdt' },
        quote: true,
      },
    } as const;
    const reorderedRequest = {
      benchmark: {
        quote: true,
        descriptor: { symbol: 'btcusdt', id: 'PRIMARY_CRYPTO_BENCHMARK' },
      },
      aggTrade: { windowMs: 5_000 },
      quote: true,
      symbol: 'ETHUSDT',
    } as const;
    const sources = {
      ...primarySources(),
      benchmark: {
        getBenchmark: (descriptor: { id: string; symbol: string }) => ({
          descriptor,
          candles: { getSeries: async () => candles() },
          quote: { getQuote: () => quote() },
        }),
      },
    };
    const base = await capture(sources, baseRequest);
    const reordered = await capture(sources, reorderedRequest);
    expect(reordered.snapshotId).toBe(base.snapshotId);

    const changedQuote = await capture(primarySources(quote(1_500)), {
      symbol: 'ETHUSDT',
      quote: true,
    });
    const otherQuote = await capture(primarySources({ ...quote(), spreadBps: 11 }), {
      symbol: 'ETHUSDT',
      quote: true,
    });
    const changedTimestamp = await capture(primarySources(quote(1_501)), {
      symbol: 'ETHUSDT',
      quote: true,
    });
    const changedBoundary = await capture(
      primarySources(),
      { symbol: 'ETHUSDT', quote: true },
      [1_001, 2_000],
    );
    const changedFlowWindow = await capture(sources, {
      ...baseRequest,
      aggTrade: { windowMs: 6_000 },
    });
    expect(changedQuote.snapshotId).not.toBe(otherQuote.snapshotId);
    expect(changedQuote.snapshotId).not.toBe(changedTimestamp.snapshotId);
    expect(changedQuote.snapshotId).not.toBe(changedBoundary.snapshotId);
    expect(base.snapshotId).not.toBe(changedFlowWindow.snapshotId);
    expect(base.snapshotId).not.toBe(
      (
        await capture(sources, {
          ...baseRequest,
          benchmark: {
            ...baseRequest.benchmark,
            descriptor: { id: 'SECONDARY_CRYPTO_BENCHMARK', symbol: 'ethusdt' },
          },
        })
      ).snapshotId,
    );
  });

  it('never owns the order-book lifecycle or reads at construction', async () => {
    let starts = 0;
    let stops = 0;
    let reads = 0;
    const orderBook = {
      start: () => {
        starts += 1;
      },
      stop: () => {
        stops += 1;
      },
      getState: () => {
        reads += 1;
        return book();
      },
      getHealth: () => {
        reads += 1;
        return 'HEALTHY' as const;
      },
      getSnapshot: () => undefined,
    };
    const provider = new MarketSnapshotProvider(
      { orderBookFor: () => orderBook },
      clock(1_000, 2_000),
    );
    expect(reads).toBe(0);
    await provider.capture({ symbol: 'ETHUSDT', orderBookFeatures: true });
    expect(starts).toBe(0);
    expect(stops).toBe(0);
    expect(reads).toBe(2);
  });
});
