import { describe, expect, it } from 'vitest';
import { Candle } from '../../types';
import {
  MicroBurstContextBuilderDeps,
  buildMicroBurstContext,
  filterClosedCandles,
} from './MicroBurstContextBuilder';
import { BtcContext, OrderBookSnapshot } from './MicroBurstTypes';

const SNAPSHOT_AT_MS = 1_700_000_000_000;

function candlesEndingAt(count: number, intervalMs: number, endAtMs: number): Candle[] {
  return Array.from({ length: count }, (_, index) => {
    const closeTime = endAtMs - (count - index - 1) * intervalMs;
    const close = 100 + index * 0.01;
    return {
      openTime: closeTime - intervalMs + 1,
      timestamp: closeTime - intervalMs + 1,
      open: close - 0.01,
      high: close + 0.05,
      low: close - 0.05,
      close,
      volume: 1_000 + index,
      buyVolume: 500,
      closeTime,
    };
  });
}

function healthyBook(overrides: Partial<OrderBookSnapshot> = {}): OrderBookSnapshot {
  return {
    bidDepth: [
      { price: 100, qty: 10 },
      { price: 99.9, qty: 10 },
    ],
    askDepth: [
      { price: 100.05, qty: 10 },
      { price: 100.1, qty: 10 },
    ],
    observedAtMs: SNAPSHOT_AT_MS - 1_000,
    status: 'HEALTHY',
    lastUpdateId: 123,
    ...overrides,
  };
}

function healthyBtc(overrides: Partial<BtcContext> = {}): BtcContext {
  return {
    ret1m: 0,
    ret3m: 0,
    ret5m: 0,
    acceleration: 0,
    conflictFlag: false,
    direction: 'NEUTRAL',
    observedAtMs: SNAPSHOT_AT_MS - 1_000,
    ...overrides,
  };
}

function depsWith(
  candleSets: Record<'1m' | '3m' | '5m', Candle[]>,
  book: OrderBookSnapshot | undefined = healthyBook(),
  btc: BtcContext | null = healthyBtc(),
): MicroBurstContextBuilderDeps {
  return {
    candles: {
      getCandles: async (_symbol, interval) => candleSets[interval as keyof typeof candleSets],
    },
    book: { getDepthSnapshot: () => book },
    btc: { getBtcContext: () => btc ?? undefined },
  };
}

function freshCandleSets(): Record<'1m' | '3m' | '5m', Candle[]> {
  return {
    '1m': candlesEndingAt(40, 60_000, SNAPSHOT_AT_MS),
    '3m': candlesEndingAt(25, 180_000, SNAPSHOT_AT_MS),
    '5m': candlesEndingAt(20, 300_000, SNAPSHOT_AT_MS),
  };
}

describe('MicroBurstContextBuilder deterministic causal contract', () => {
  it('uses Candle.closeTime inclusively to filter closed candles', () => {
    const candles = candlesEndingAt(3, 60_000, SNAPSHOT_AT_MS + 60_000);
    expect(filterClosedCandles(candles, SNAPSHOT_AT_MS).map((item) => item.closeTime)).toEqual([
      SNAPSHOT_AT_MS - 60_000,
      SNAPSHOT_AT_MS,
    ]);
  });

  it('produces the same context for the same snapshot and snapshotAtMs', async () => {
    const deps = depsWith(freshCandleSets());
    const first = await buildMicroBurstContext('ETHUSDT', deps, { snapshotAtMs: SNAPSHOT_AT_MS });
    const second = await buildMicroBurstContext('ETHUSDT', deps, { snapshotAtMs: SNAPSHOT_AT_MS });
    expect(first).toEqual(second);
  });

  it('uses an immutable closed-candle decision price with explicit provenance', async () => {
    const context = await buildMicroBurstContext('ETHUSDT', depsWith(freshCandleSets()), {
      snapshotAtMs: SNAPSHOT_AT_MS,
    });
    expect(context.decisionPrice).toEqual({
      price: context.currentPrice,
      source: 'CANDLE',
      observedAtMs: SNAPSHOT_AT_MS,
    });
    expect(Object.isFrozen(context.decisionPrice)).toBe(true);
  });

  it('fails the whole context when only the 5m timeframe is stale', async () => {
    const candleSets = freshCandleSets();
    candleSets['5m'] = candlesEndingAt(20, 300_000, SNAPSHOT_AT_MS - 700_000);
    const context = await buildMicroBurstContext('ETHUSDT', depsWith(candleSets), {
      snapshotAtMs: SNAPSHOT_AT_MS,
    });
    expect(context.dataQuality.freshness1mMs).toBe(0);
    expect(context.dataQuality.freshness3mMs).toBe(0);
    expect(context.dataQuality.freshness5mMs).toBe(700_000);
    expect(context.dataQuality.contextValid).toBe(false);
    expect(context.dataQuality.invalidReasons).toContain('stale_5m_candles');
  });

  it('fails closed when BTC is unavailable or stale', async () => {
    const unavailable = await buildMicroBurstContext(
      'ETHUSDT',
      depsWith(freshCandleSets(), healthyBook(), null),
      { snapshotAtMs: SNAPSHOT_AT_MS },
    );
    expect(unavailable.dataQuality).toMatchObject({ btcStatus: 'UNAVAILABLE', contextValid: false });

    const stale = await buildMicroBurstContext(
      'ETHUSDT',
      depsWith(
        freshCandleSets(),
        healthyBook(),
        healthyBtc({ observedAtMs: SNAPSHOT_AT_MS - 60_001 }),
      ),
      { snapshotAtMs: SNAPSHOT_AT_MS },
    );
    expect(stale.dataQuality).toMatchObject({ btcStatus: 'STALE', contextValid: false });
  });

  it('ignores all 1m/3m/5m candles after snapshotAtMs', async () => {
    const historical = freshCandleSets();
    const withFuture = {
      '1m': [...historical['1m'], ...candlesEndingAt(30, 60_000, SNAPSHOT_AT_MS + 30 * 60_000)],
      '3m': [...historical['3m'], ...candlesEndingAt(10, 180_000, SNAPSHOT_AT_MS + 30 * 60_000)],
      '5m': [...historical['5m'], ...candlesEndingAt(6, 300_000, SNAPSHOT_AT_MS + 30 * 60_000)],
    };
    const baseline = await buildMicroBurstContext('ETHUSDT', depsWith(historical), {
      snapshotAtMs: SNAPSHOT_AT_MS,
    });
    const replay = await buildMicroBurstContext('ETHUSDT', depsWith(withFuture), {
      snapshotAtMs: SNAPSHOT_AT_MS,
    });
    expect(replay).toEqual(baseline);
    expect(replay.currentPrice).toBe(historical['1m'][historical['1m'].length - 1].close);
    expect(replay.candles.candles1m.every((candle) => candle.closeTime <= SNAPSHOT_AT_MS)).toBe(true);
    expect(replay.candles.candles3m.every((candle) => candle.closeTime <= SNAPSHOT_AT_MS)).toBe(true);
    expect(replay.candles.candles5m.every((candle) => candle.closeTime <= SNAPSHOT_AT_MS)).toBe(true);
    expect(replay.levels.levels.every((level) => level.availableAtMs <= SNAPSHOT_AT_MS)).toBe(true);
  });
});
