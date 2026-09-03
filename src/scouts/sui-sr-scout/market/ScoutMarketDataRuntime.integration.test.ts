import { describe, expect, it } from 'vitest';
import type { Candle } from '../../../core/types';
import type { Logger } from '../../../app/ports/Logger';
import { createScoutMarketDataRuntime, type MarketDataCallbacks } from './ScoutMarketDataRuntime';
import type { ScoutMarketDataSource } from './BinanceScoutMarketDataSource';
import type { SuiSrScoutConfig } from '../domain/ScoutTypes';

const logger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

function config(): SuiSrScoutConfig {
  return {
    enabled: true,
    executionMode: 'OBSERVE',
    liveEnabled: false,
    symbol: 'SUIUSDT',
    contextSymbol: 'BTCUSDT',
    maxOpenPositions: 1,
    maxQuoteNotional: 0,
    maxLeverage: 0,
    maxRiskPerTradeBps: 0,
    maxDailyLossBps: 0,
    cooldownAfterStopMs: 0,
    minNetRMultiple: 1.5,
    tickIntervalMs: 100,
    feedStaleThresholdMs: 5_000,
    feedGapThresholdMs: 2_000,
    candleIntervals: ['1m'],
    srZoneAtrTolerance: 0.15,
    srMinTouchCount: 2,
    srZoneScoreMin: 0.4,
    breakConfirmationCandles: 2,
    btcAggressiveThreshold: 0.65,
    killSwitch: true,
  };
}

function candles(intervalMs: number, count: number): Candle[] {
  const start = 1_700_000_000_000;
  return Array.from({ length: count }, (_, index) => ({
    openTime: start + index * intervalMs,
    timestamp: start + index * intervalMs,
    open: 1 + index / 10_000,
    high: 1.01 + index / 10_000,
    low: 0.99 + index / 10_000,
    close: 1 + index / 10_000,
    volume: 100,
    buyVolume: 50,
    closeTime: start + (index + 1) * intervalMs - 1,
  }));
}

function sourceWith(callbackSink: {
  callbacks?: MarketDataCallbacks;
  symbols?: string[];
}): ScoutMarketDataSource {
  return {
    async getCandles(_symbol, interval, limit) {
      return candles(interval === '1m' ? 60_000 : 180_000, limit);
    },
    async getMarkPrice() {
      return 1;
    },
    async getFundingRate() {
      return { rate: 0.0001 };
    },
    subscribe(_symbol, callbacks) {
      callbackSink.symbols ??= [];
      callbackSink.symbols.push(_symbol);
      callbackSink.callbacks = callbacks;
      return [() => {}];
    },
  };
}

describe('ScoutMarketDataRuntime integration', () => {
  it('requires complete 240x1m warmup before ready and subscribes only its two symbols', async () => {
    const sink: { callbacks?: MarketDataCallbacks; symbols?: string[] } = {};
    const runtime = createScoutMarketDataRuntime(config(), logger, sourceWith(sink));
    const warmup = await runtime.start({});
    expect(warmup.ready).toBe(true);
    expect(warmup.candles1m).toEqual({ BTCUSDT: 240, SUIUSDT: 240 });
    expect(warmup.candles3m).toEqual({ BTCUSDT: 80, SUIUSDT: 80 });
    expect(runtime.isReady()).toBe(true);
    expect(sink.symbols).toEqual(['BTCUSDT', 'SUIUSDT']);
  });

  it('marks a depth sequence gap and blocks healthy status', async () => {
    const sink: { callbacks?: MarketDataCallbacks } = {};
    const runtime = createScoutMarketDataRuntime(config(), logger, sourceWith(sink));
    await runtime.start({});
    const callback = sink.callbacks!;
    callback.onDepth?.({
      symbol: 'SUIUSDT',
      bids: [[1, 10]],
      asks: [[1.01, 10]],
      firstUpdateId: 1,
      previousUpdateId: 0,
      lastUpdateId: 1,
      eventTime: 10,
      receivedAtMs: Date.now(),
    });
    callback.onDepth?.({
      symbol: 'SUIUSDT',
      bids: [[1, 10]],
      asks: [[1.01, 10]],
      firstUpdateId: 3,
      previousUpdateId: 2,
      lastUpdateId: 3,
      eventTime: 11,
      receivedAtMs: Date.now(),
    });
    expect(runtime.getHealth('SUIUSDT').feed).toBe('GAPPED');
    expect(runtime.isHealthy('SUIUSDT')).toBe(false);
  });

  it('rejects out-of-order aggregate trades', async () => {
    const sink: { callbacks?: MarketDataCallbacks } = {};
    const runtime = createScoutMarketDataRuntime(config(), logger, sourceWith(sink));
    await runtime.start({});
    const callback = sink.callbacks!;
    callback.onAggTrade?.({
      symbol: 'BTCUSDT',
      price: 1,
      quantity: 1,
      isBuyerMaker: false,
      tradeTime: 10,
      receivedAtMs: Date.now(),
      aggregateTradeId: 10,
    });
    callback.onAggTrade?.({
      symbol: 'BTCUSDT',
      price: 1,
      quantity: 1,
      isBuyerMaker: false,
      tradeTime: 9,
      receivedAtMs: Date.now(),
      aggregateTradeId: 9,
    });
    expect(runtime.getHealth('BTCUSDT').outOfOrderCount).toBeGreaterThan(0);
  });

  it('does not classify the REST/WS candle overlap as a gap', async () => {
    const sink: { callbacks?: MarketDataCallbacks } = {};
    const runtime = createScoutMarketDataRuntime(config(), logger, sourceWith(sink));
    await runtime.start({});
    const last = runtime.getState('SUIUSDT').candles1m.last()!;
    sink.callbacks!.onCandle?.({
      symbol: 'SUIUSDT',
      interval: '1m',
      openTime: last.openTime,
      open: last.open,
      high: last.high,
      low: last.low,
      close: last.close,
      volume: last.volume,
      closeTime: last.closeTime,
      isClosed: false,
      exchangeTime: last.closeTime,
      receivedAtMs: Date.now(),
    });
    sink.callbacks!.onCandle?.({
      symbol: 'SUIUSDT',
      interval: '1m',
      openTime: last.openTime + 60_000,
      open: 1,
      high: 1,
      low: 1,
      close: 1,
      volume: 1,
      closeTime: last.closeTime + 60_000,
      isClosed: false,
      exchangeTime: last.closeTime + 60_000,
      receivedAtMs: Date.now(),
    });
    expect(runtime.getHealth('SUIUSDT').gapCount).toBe(0);
  });
});
