import { describe, expect, it } from 'vitest';
import type {
  CandleSeriesSnapshot,
  OrderBookState,
  QuoteSnapshot,
} from '../../app/ports/MarketData';
import { MarketSnapshotProvider, type SnapshotClock } from './MarketSnapshotProvider';

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
        aggTradeFor: () => ({ getTakerFlow: () => flow() }),
      },
      clock(1_000, 2_000),
    );

    const snapshot = await provider.capture({
      symbol: 'ethusdt',
      quote: true,
      orderBookFeatures: true,
      aggTrade: { windowMs: 300_000 },
    });

    expect(snapshot.health).toBe('COMPLETE');
    expect(snapshot.primary.quote.value?.spreadBps).toBe(10);
    expect(snapshot.primary.quote.sourceTimestampDomain).toBe('LOCAL_CAPTURE');
    expect(snapshot.primary.aggTrade.value?.observedAtMs).toBe(9_000);
    expect(snapshot.primary.aggTrade.sourceTimestampDomain).toBe('EVENT_TIME');
    expect(snapshot.primary.aggTrade.requestedWindowMs).toBe(300_000);
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
});
