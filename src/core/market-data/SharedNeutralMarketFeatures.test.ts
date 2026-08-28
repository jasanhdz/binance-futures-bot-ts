import { describe, expect, it } from 'vitest';
import type {
  CandleObservation,
  CandleSeriesSnapshot,
  OrderBookState,
  QuoteSnapshot,
} from '../../app/ports/MarketData';
import {
  calculateAggTradeFeaturesV1,
  calculateCandleFeaturesV1,
  calculateOrderBookFeaturesV1,
  calculateQuoteFeaturesV1,
} from './SharedNeutralMarketFeatures';

function quote(overrides: Partial<QuoteSnapshot> = {}): QuoteSnapshot {
  return {
    symbol: 'ETHUSDT',
    bid: 100,
    ask: 100.1,
    mid: 100.05,
    spread: 0.1,
    spreadBps: 10,
    health: 'HEALTHY',
    observedAtMs: 123,
    source: 'SYNCHRONIZED_ORDER_BOOK',
    ...overrides,
  };
}

function book(levelCount = 10, bidQty = 2, askQty = 1): OrderBookState {
  return {
    bids: Array.from({ length: levelCount }, (_, index) => ({
      price: 100 - index,
      qty: bidQty,
    })),
    asks: Array.from({ length: levelCount }, (_, index) => ({
      price: 101 + index,
      qty: askQty,
    })),
    lastUpdateId: 5,
    health: 'HEALTHY',
    observedAtMs: 456,
    lastSyncAtMs: 400,
    lastDiffAtMs: 450,
    gapCount: 0,
    resyncCount: 0,
  };
}

function flow(overrides: Partial<Parameters<typeof calculateAggTradeFeaturesV1>[0]> = {}) {
  return {
    buyVolume: 3,
    sellVolume: 1,
    netTakerVolume: 2,
    tradeCount: 4,
    requestedWindowMs: 300_000,
    observedWindowMs: 150_000,
    observedSampleCount: 4,
    eventWatermarkMs: 900,
    capacityTruncated: false,
    coverageStartedAtMs: 750,
    windowComplete: true,
    gapFree: true,
    ...overrides,
  };
}

function candle(close: number, closeTime: number, status: CandleObservation['status'] = 'CLOSED') {
  return {
    symbol: 'ETHUSDT',
    interval: '1m',
    openTime: closeTime - 60_000,
    closeTime,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
    buyVolume: 1,
    status,
    observedAtMs: 10_000,
    source: 'REST' as const,
  };
}

function series(
  candles: readonly CandleObservation[],
  health: CandleSeriesSnapshot['health'] = 'HEALTHY',
) {
  return {
    symbol: 'ETHUSDT',
    interval: '1m',
    candles,
    health,
    observedAtMs: 10_000,
    exchangeSnapshotTimeMs: 300_000,
    gapCount: 0,
    hasGaps: false,
    gapCheck: 'CHECKED' as const,
    source: 'REST' as const,
  };
}

describe('shared neutral market features v1', () => {
  it('calculates spread in basis points and preserves the quote timestamp', () => {
    expect(calculateQuoteFeaturesV1(quote())).toEqual({
      schemaVersion: 1,
      observedAtMs: 123,
      health: 'HEALTHY',
      spreadBps: 10,
    });
  });

  it('does not fabricate a quote feature for unhealthy or anomalous quotes', () => {
    expect(calculateQuoteFeaturesV1(quote({ health: 'STALE' }))).toMatchObject({
      health: 'STALE',
      spreadBps: null,
    });
    expect(calculateQuoteFeaturesV1(quote({ health: 'HEALTHY', spreadBps: null }))).toMatchObject({
      health: 'ANOMALOUS',
      spreadBps: null,
    });
  });

  it('calculates deterministic top-five and top-ten book features', () => {
    const result = calculateOrderBookFeaturesV1({ state: book() });
    expect(result).toMatchObject({
      schemaVersion: 1,
      observedAtMs: 456,
      health: 'HEALTHY',
      signedImbalanceTop5: 1 / 3,
      signedImbalanceTop10: 1 / 3,
      bidDepthTop5Levels: 5,
      askDepthTop5Levels: 5,
      bidDepthTop10Levels: 10,
      askDepthTop10Levels: 10,
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it('selects the same levels regardless of input ordering', () => {
    const ordered = calculateOrderBookFeaturesV1({ state: book() });
    const source = book();
    const shuffled = calculateOrderBookFeaturesV1({
      state: { ...source, bids: [...source.bids].reverse(), asks: [...source.asks].reverse() },
    });

    expect(shuffled).toEqual(ordered);
  });

  it('returns signed zero for balanced quantities and negative values for ask-heavy books', () => {
    expect(calculateOrderBookFeaturesV1({ state: book(10, 1, 1) }).signedImbalanceTop5).toBe(0);
    expect(calculateOrderBookFeaturesV1({ state: book(10, 1, 2) }).signedImbalanceTop10).toBe(
      -1 / 3,
    );
  });

  it('fails closed for unavailable, incomplete, empty, or zero-denominator books', () => {
    expect(calculateOrderBookFeaturesV1({ state: { ...book(), health: 'STALE' } })).toMatchObject({
      health: 'STALE',
      signedImbalanceTop5: null,
    });
    expect(
      calculateOrderBookFeaturesV1({ state: { ...book(), bids: [], asks: [] } }),
    ).toMatchObject({ health: 'ANOMALOUS', signedImbalanceTop5: null });
    expect(
      calculateOrderBookFeaturesV1({
        state: {
          ...book(),
          bids: book().bids.map((x) => ({ ...x, qty: 0 })),
          asks: book().asks.map((x) => ({ ...x, qty: 0 })),
        },
      }),
    ).toMatchObject({ health: 'ANOMALOUS', signedImbalanceTop5: null });
  });

  it('preserves valid empty flow separately from unavailable flow', () => {
    const empty = calculateAggTradeFeaturesV1(
      flow({ buyVolume: 0, sellVolume: 0, netTakerVolume: 0, tradeCount: 0 }),
    );
    expect(empty).toMatchObject({
      health: 'HEALTHY',
      takerBuyVolume: 0,
      takerSellVolume: 0,
      tradeCount: 0,
      coverageRatio: 0.5,
    });
    expect(calculateAggTradeFeaturesV1(flow({ windowComplete: false }))).toMatchObject({
      health: 'UNAVAILABLE',
      takerBuyVolume: null,
      coverageRatio: null,
      observedAtMs: 900,
    });
  });

  it('propagates flow continuity and capacity failures without returning numeric values', () => {
    for (const failed of [{ gapFree: false }, { capacityTruncated: true }]) {
      expect(calculateAggTradeFeaturesV1(flow(failed))).toMatchObject({
        health: 'UNAVAILABLE',
        netTakerVolume: null,
        gapFree: failed.gapFree ?? true,
        capacityTruncated: failed.capacityTruncated ?? false,
      });
    }
  });

  it('calculates explicit flow coverage and preserves the causal event watermark', () => {
    expect(calculateAggTradeFeaturesV1(flow())).toMatchObject({
      observedAtMs: 900,
      requestedWindowMs: 300_000,
      observedWindowMs: 150_000,
      coverageRatio: 0.5,
      takerBuyVolume: 3,
      takerSellVolume: 1,
      netTakerVolume: 2,
      tradeCount: 4,
    });
  });

  it('calculates closed-candle decimal returns using at-or-before lookup', () => {
    const result = calculateCandleFeaturesV1(
      series([
        candle(100, 0),
        candle(101, 60_000),
        candle(102, 120_000),
        candle(103, 180_000),
        candle(104, 240_000),
        candle(110, 300_000),
      ]),
    );
    expect(result).toMatchObject({
      health: 'HEALTHY',
      observedAtMs: 10_000,
      exchangeSnapshotTimeMs: 300_000,
      return1m: 6 / 104,
      return3m: 8 / 102,
      return5m: 10 / 100,
    });
  });

  it('excludes open candles and fails closed for gapped or missing history', () => {
    expect(
      calculateCandleFeaturesV1(series([candle(100, 0), candle(110, 300_000, 'OPEN')])),
    ).toMatchObject({ health: 'HEALTHY', return1m: null, return3m: null, return5m: null });
    expect(calculateCandleFeaturesV1(series([candle(100, 0)], 'GAPPED'))).toMatchObject({
      health: 'GAPPED',
      return1m: null,
    });
    expect(calculateCandleFeaturesV1(series([candle(100, 0), candle(110, 360_000)]))).toMatchObject(
      { return1m: null, return3m: null, return5m: null },
    );
  });
});
