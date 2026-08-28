import { describe, expect, it } from 'vitest';
import type {
  CandleObservation,
  CandlePort,
  CandleSeriesSnapshot,
  OrderBookPort,
  QuotePort,
  QuoteSnapshot,
} from '../../app/ports/MarketData';
import type { BenchmarkMarketDataPort } from './BenchmarkMarketData';
import {
  MarketDataCapabilityCatalog,
  composeMarketSnapshotRequest,
  defineMarketDataConsumerProfile,
} from './MarketDataCapabilityComposition';
import { MarketSnapshotProvider, type SnapshotClock } from './MarketSnapshotProvider';

function clock(...values: number[]): SnapshotClock {
  let index = 0;
  return { now: () => values[Math.min(index++, values.length - 1)] };
}

function quote(symbol = 'ETHUSDT'): QuoteSnapshot {
  return {
    symbol,
    bid: 100,
    ask: 100.1,
    mid: 100.05,
    spread: 0.1,
    spreadBps: 10,
    health: 'HEALTHY',
    observedAtMs: 1_500,
    source: 'SYNCHRONIZED_ORDER_BOOK',
  };
}

function quotePort(symbol = 'ETHUSDT'): QuotePort {
  return { getQuote: () => quote(symbol) };
}

function candleSeries(symbol: string): CandleSeriesSnapshot {
  const candle: CandleObservation = {
    symbol,
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
    observedAtMs: 1_500,
    source: 'REST',
  };
  return {
    symbol,
    interval: '1m',
    candles: [candle],
    health: 'HEALTHY',
    observedAtMs: 1_500,
    exchangeSnapshotTimeMs: 60_000,
    gapCount: 0,
    hasGaps: false,
    gapCheck: 'CHECKED',
    source: 'REST',
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

describe('MarketDataCapabilityCatalog', () => {
  it(
    'normalizes symbols, isolates registrations, and replaces/unregisters without lifecycle calls',
    () => {
      let starts = 0;
      let stops = 0;
      const firstBook: OrderBookPort = {
        start: () => {
          starts += 1;
        },
        stop: () => {
          stops += 1;
        },
        getState: () => ({
          bids: [],
          asks: [],
          lastUpdateId: 0,
          health: 'UNAVAILABLE',
          observedAtMs: 0,
          lastSyncAtMs: 0,
          lastDiffAtMs: 0,
          gapCount: 0,
          resyncCount: 0,
        }),
        getHealth: () => 'UNAVAILABLE',
        getSnapshot: () => undefined,
      };
      const firstQuote = quotePort();
      const replacementQuote = quotePort('BTCUSDT');
      const catalog = new MarketDataCapabilityCatalog();

      catalog.registerSymbol('ethusdt', { quote: firstQuote, orderBook: firstBook });
      expect(catalog.getSymbolCapabilities('ETHUSDT')?.quote).toBe(firstQuote);
      expect(catalog.getSymbolCapabilities('ethusdt')?.orderBook).toBe(firstBook);
      expect(catalog.getSymbolCapabilities('BTCUSDT')).toBeUndefined();

      catalog.registerSymbol('ETHUSDT', { quote: replacementQuote });
      expect(catalog.getSymbolCapabilities('ethusdt')?.quote).toBe(replacementQuote);
      expect(catalog.getSymbolCapabilities('ethusdt')?.orderBook).toBeUndefined();
      expect(starts).toBe(0);
      expect(stops).toBe(0);

      expect(catalog.unregisterSymbol('eThUsDt')).toBe(true);
      expect(catalog.getSymbolCapabilities('ETHUSDT')).toBeUndefined();
      expect(starts).toBe(0);
      expect(stops).toBe(0);
    },
  );

  it(
    'adapts the exact registered handles into MarketSnapshotSources without reading at construction',
    () => {
      let quoteReads = 0;
      let flowReads = 0;
      const quoteHandle: QuotePort = {
        getQuote: () => {
          quoteReads += 1;
          return quote();
        },
      };
      const flowHandle = {
        getTakerFlow: () => {
          flowReads += 1;
          return flow();
        },
      };
      const candles: CandlePort = { getSeries: async (symbol) => candleSeries(symbol) };
      const catalog = new MarketDataCapabilityCatalog();
      catalog.registerSymbol('ETHUSDT', { quote: quoteHandle, aggTrade: flowHandle });
      catalog.registerShared({ candles });

      const sources = catalog.asSnapshotSources();
      expect(quoteReads).toBe(0);
      expect(flowReads).toBe(0);
      expect(sources.quoteFor?.('ethusdt')).toBe(quoteHandle);
      expect(sources.aggTradeFor?.('ETHUSDT')).toBe(flowHandle);
      expect(sources.candles).toBe(candles);
      expect(Object.isFrozen(sources)).toBe(true);
      expect(quoteReads).toBe(0);
      expect(flowReads).toBe(0);
    },
  );
});

describe('market data consumer composition', () => {
  it('composes an exact quote-only request without hidden capability expansion', () => {
    const profile = defineMarketDataConsumerProfile({
      id: 'QUOTE_ONLY',
      primary: { quote: true },
    });

    expect(composeMarketSnapshotRequest(profile, 'ethusdt')).toEqual({
      symbol: 'ETHUSDT',
      quote: true,
    });
    expect(Object.isFrozen(profile)).toBe(true);
    expect(Object.isFrozen(profile.primary)).toBe(true);
  });

  it('keeps different consumer requirements isolated for the same symbol', () => {
    const quoteOnly = defineMarketDataConsumerProfile({
      id: 'QUOTE_ONLY',
      primary: { quote: true },
    });
    const bookAndFlow = defineMarketDataConsumerProfile({
      id: 'BOOK_FLOW',
      primary: { orderBookFeatures: true, aggTrade: true },
    });

    expect(composeMarketSnapshotRequest(quoteOnly, 'ETHUSDT')).toEqual({
      symbol: 'ETHUSDT',
      quote: true,
    });
    expect(composeMarketSnapshotRequest(bookAndFlow, 'ETHUSDT')).toEqual({
      symbol: 'ETHUSDT',
      orderBookFeatures: true,
      aggTrade: true,
    });
  });

  it('proves availability does not create dependency and optional failures stay isolated', async () => {
    let bookReads = 0;
    let flowReads = 0;
    let candleReads = 0;
    const catalog = new MarketDataCapabilityCatalog();
    catalog.registerSymbol('ETHUSDT', {
      quote: quotePort(),
      orderBook: {
        start: () => undefined,
        stop: () => undefined,
        getState: () => {
          bookReads += 1;
          throw new Error('book should not be read');
        },
        getHealth: () => {
          bookReads += 1;
          throw new Error('book should not be read');
        },
        getSnapshot: () => undefined,
      },
      aggTrade: {
        getTakerFlow: () => {
          flowReads += 1;
          throw new Error('flow should not be read');
        },
      },
    });
    catalog.registerShared({
      candles: {
        getSeries: async (symbol) => {
          candleReads += 1;
          return candleSeries(symbol);
        },
      },
    });
    const profile = defineMarketDataConsumerProfile({
      id: 'QUOTE_ONLY',
      primary: { quote: true },
    });
    const snapshot = await new MarketSnapshotProvider(
      catalog.asSnapshotSources(),
      clock(1_000, 2_000),
    ).capture(composeMarketSnapshotRequest(profile, 'ETHUSDT'));

    expect(snapshot.health).toBe('COMPLETE');
    expect(snapshot.primary.quote.status).toBe('AVAILABLE');
    expect(snapshot.primary.orderBookFeatures.status).toBe('NOT_REQUESTED');
    expect(snapshot.primary.aggTrade.status).toBe('NOT_REQUESTED');
    expect(snapshot.primary.candles.status).toBe('NOT_REQUESTED');
    expect(bookReads).toBe(0);
    expect(flowReads).toBe(0);
    expect(candleReads).toBe(0);

    const bookFlowProfile = defineMarketDataConsumerProfile({
      id: 'BOOK_FLOW',
      primary: { orderBookFeatures: true, aggTrade: true },
    });
    const failingSnapshot = await new MarketSnapshotProvider(
      catalog.asSnapshotSources(),
      clock(1_000, 2_000),
    ).capture(composeMarketSnapshotRequest(bookFlowProfile, 'ETHUSDT'));
    expect(failingSnapshot.health).toBe('UNAVAILABLE');
    expect(failingSnapshot.primary.orderBookFeatures.status).toBe('UNAVAILABLE');
    expect(failingSnapshot.primary.aggTrade.status).toBe('UNAVAILABLE');
    expect(bookReads).toBe(1);
    expect(flowReads).toBe(1);
    expect(candleReads).toBe(0);
  });

  it('turns an unregistered requested capability into explicit UNAVAILABLE evidence', async () => {
    const catalog = new MarketDataCapabilityCatalog();
    const profile = defineMarketDataConsumerProfile({
      id: 'BOOK_ONLY',
      primary: { orderBookFeatures: true },
    });
    const snapshot = await new MarketSnapshotProvider(
      catalog.asSnapshotSources(),
      clock(1_000, 2_000),
    ).capture(composeMarketSnapshotRequest(profile, 'ETHUSDT'));

    expect(snapshot.primary.orderBookFeatures).toMatchObject({
      requested: true,
      status: 'UNAVAILABLE',
      health: 'UNAVAILABLE',
      value: null,
    });
    expect(snapshot.health).toBe('UNAVAILABLE');
  });

  it('injects generic benchmark descriptors without BTC-specific composition policy', async () => {
    const benchmarkPort: BenchmarkMarketDataPort = {
      getBenchmark: (descriptor) => ({
        descriptor,
        candles: {
          getSeries: async () => candleSeries(descriptor.symbol),
        },
      }),
    };
    const catalog = new MarketDataCapabilityCatalog();
    catalog.registerSymbol('ETHUSDT', { quote: quotePort() });
    catalog.registerShared({ benchmark: benchmarkPort });
    const profile = defineMarketDataConsumerProfile({
      id: 'PRIMARY_PLUS_BENCHMARK_CANDLES',
      primary: { quote: true },
      benchmark: { candles: { interval: '1m', limit: 1 } },
    });

    const btcRequest = composeMarketSnapshotRequest(profile, 'ETHUSDT', {
      id: 'PRIMARY_CRYPTO_BENCHMARK',
      symbol: 'btcusdt',
    });
    const ethRequest = composeMarketSnapshotRequest(profile, 'ETHUSDT', {
      id: 'SECONDARY_CRYPTO_BENCHMARK',
      symbol: 'ethusdt',
    });
    expect(btcRequest.benchmark?.descriptor).toEqual({
      id: 'PRIMARY_CRYPTO_BENCHMARK',
      symbol: 'BTCUSDT',
    });
    expect(ethRequest.benchmark?.descriptor).toEqual({
      id: 'SECONDARY_CRYPTO_BENCHMARK',
      symbol: 'ETHUSDT',
    });

    const btcSnapshot = await new MarketSnapshotProvider(
      catalog.asSnapshotSources(),
      clock(1_000, 2_000),
    ).capture(btcRequest);
    const ethSnapshot = await new MarketSnapshotProvider(
      catalog.asSnapshotSources(),
      clock(1_000, 2_000),
    ).capture(ethRequest);
    expect(btcSnapshot.benchmark?.descriptor.symbol).toBe('BTCUSDT');
    expect(ethSnapshot.benchmark?.descriptor.symbol).toBe('ETHUSDT');
    expect(btcSnapshot.benchmark?.data.candles.status).toBe('AVAILABLE');
    expect(ethSnapshot.benchmark?.data.candles.status).toBe('AVAILABLE');
  });

  it('returns detached immutable profiles and requests', () => {
    const mutableProfile = {
      id: 'IMMUTABLE',
      primary: { aggTrade: { windowMs: 300_000 }, candles: { interval: '1m', limit: 10 } },
      benchmark: { quote: true },
    };
    const profile = defineMarketDataConsumerProfile(mutableProfile);
    const request = composeMarketSnapshotRequest(profile, 'ethusdt', {
      id: 'PRIMARY_CRYPTO_BENCHMARK',
      symbol: 'btcusdt',
    });

    mutableProfile.primary.aggTrade.windowMs = 5_000;
    mutableProfile.primary.candles.limit = 99;
    expect(profile.primary).toEqual({
      aggTrade: { windowMs: 300_000 },
      candles: { interval: '1m', limit: 10 },
    });
    expect(request.aggTrade).toEqual({ windowMs: 300_000 });
    expect(request.candles).toEqual({ interval: '1m', limit: 10 });
    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.aggTrade)).toBe(true);
    expect(Object.isFrozen(request.candles)).toBe(true);
    expect(Object.isFrozen(request.benchmark)).toBe(true);
    expect(Object.isFrozen(request.benchmark?.descriptor)).toBe(true);
  });

  it('requires a runtime benchmark descriptor only when the profile requests benchmark data', () => {
    const benchmarkProfile = defineMarketDataConsumerProfile({
      id: 'BENCHMARKED',
      primary: {},
      benchmark: { quote: true },
    });
    expect(() => composeMarketSnapshotRequest(benchmarkProfile, 'ETHUSDT')).toThrow(
      'BENCHMARK_DESCRIPTOR_REQUIRED',
    );

    const primaryOnly = defineMarketDataConsumerProfile({ id: 'PRIMARY_ONLY', primary: {} });
    expect(composeMarketSnapshotRequest(primaryOnly, 'ETHUSDT')).toEqual({ symbol: 'ETHUSDT' });
  });
});
