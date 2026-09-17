import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockClient = vi.hoisted(() => ({
  futuresPing: vi.fn(() => Promise.resolve({})),
  futuresCandles: vi.fn(),
}));

vi.mock('binance-api-node', () => ({
  default: vi.fn(() => mockClient),
}));

import { BinanceExchange } from './BinanceAdapter';
import { WebSocketManager } from './WebSocketManager';
import { MarketDataCandleProvider } from '../../core/market-data/MarketDataCandleProvider';
import { prepareClosedCandles } from '../../core/market-data/CandleIntegrity';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

describe('BinanceExchange candle compatibility path', () => {
  it('allows preparation through the real serial queue while candle transport is pending', async () => {
    let release!: (value: never[]) => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    mockClient.futuresCandles.mockImplementationOnce(() => {
      started();
      return new Promise<never[]>((resolve) => {
        release = resolve;
      });
    });
    const exchange = new BinanceExchange(logger);
    const candles = exchange.getCandles('ETHUSDT', '1m', 1);
    await entered;
    let prepared = false;
    const preparation = (exchange as any).enqueue(
      async () => {
        prepared = true;
      },
      1,
      'test_prepare',
    );
    try {
      await vi.waitFor(() => expect(prepared).toBe(true), { timeout: 1000 });
    } finally {
      release([]);
      await Promise.all([candles, preparation]);
    }
  });
  it('retains cache origin when a forming REST-derived value becomes application-closed', async () => {
    const exchange = new BinanceExchange(logger);
    let exchangeNow = 59_998;
    const provider = new MarketDataCandleProvider(
      {
        getServerTime: async () => exchangeNow,
        getCandles: (symbol, interval, limit) => exchange.getCandles(symbol, interval, limit),
      },
      { now: () => Date.now() },
    );
    const before = await provider.getSeries('ETHUSDT', '1m', 1);
    exchangeNow = 59_999;
    const after = await provider.getSeries('ETHUSDT', '1m', 1);
    expect(before.candles[0].status).toBe('OPEN');
    expect(after.candles[0].status).toBe('CLOSED');
    expect(before.provenance?.normalizedCache).toBe('MISS');
    expect(after.provenance).toMatchObject({
      normalizedCache: 'HIT',
      transportCache: 'UNKNOWN',
      exchangeFinalization: 'UNKNOWN',
      originRequestedAtMs: before.provenance!.originRequestedAtMs,
      originReceivedAtMs: before.provenance!.originReceivedAtMs,
      classificationExchangeTimeMs: 59_999,
    });
    expect(prepareClosedCandles(after.candles, 60_000, 59_998, 120_000).candles).toHaveLength(0);
    expect(prepareClosedCandles(after.candles, 60_000, 59_999, 120_000).candles).toHaveLength(1);
    expect(mockClient.futuresCandles).toHaveBeenCalledOnce();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.futuresPing.mockResolvedValue({});
    mockClient.futuresCandles.mockResolvedValue([
      {
        openTime: 0,
        open: '100',
        high: '110',
        low: '90',
        close: '105',
        volume: '10',
        baseAssetVolume: '4',
        closeTime: 59_999,
      },
    ]);
  });

  it('preserves REST candle normalization and cache reads', async () => {
    const exchange = new BinanceExchange(logger);

    const candles = await exchange.getCandles('ETHUSDT', '1m', 1);
    const cached = exchange.getCachedCandles('ETHUSDT', '1m', 1);

    expect(candles[0]).toEqual({
      openTime: 0,
      timestamp: 0,
      open: 100,
      high: 110,
      low: 90,
      close: 105,
      volume: 10,
      buyVolume: 4,
      closeTime: 59_999,
    });
    expect(cached).toEqual(candles);
    expect(mockClient.futuresCandles).toHaveBeenCalledOnce();
  });

  it('times out a hung candle consumer without starting an overlapping request', async () => {
    vi.useFakeTimers();
    let resolve!: (candles: unknown[]) => void;
    mockClient.futuresCandles.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const exchange = new BinanceExchange(logger);
    try {
      const first = exchange.getCandles('ETHUSDT', '1m', 1);
      const second = exchange.getCandles('ETHUSDT', '1m', 1);
      const firstError = first.catch((error) => error);
      const secondError = second.catch((error) => error);
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(firstError).resolves.toMatchObject({
        message: 'BINANCE_REQUEST_TIMEOUT:candles:ETHUSDT|1m',
      });
      await expect(secondError).resolves.toMatchObject({
        message: 'BINANCE_REQUEST_TIMEOUT:candles:ETHUSDT|1m',
      });
      expect(mockClient.futuresCandles).toHaveBeenCalledOnce();
      expect(exchange.getCandleRequestDiagnostics()).toMatchObject([
        {
          key: 'ETHUSDT|1m',
          fetchLimit: 240,
          timeoutMs: 15_000,
          cause: 'TRANSPORT_PENDING',
        },
      ]);
      resolve([]);
      await vi.advanceTimersByTimeAsync(0);
      expect(exchange.getCandleRequestDiagnostics()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not satisfy a larger in-flight limit with a smaller response', async () => {
    let resolveFirst!: (candles: unknown[]) => void;
    mockClient.futuresCandles
      .mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolveFirst = done;
          }),
      )
      .mockImplementationOnce(async () =>
        Array.from({ length: 6 }, (_, index) => ({
          openTime: index,
          open: '100',
          high: '110',
          low: '90',
          close: '105',
          volume: '10',
          baseAssetVolume: '4',
          closeTime: index + 1,
        })),
      );
    const exchange = new BinanceExchange(logger);
    const first = exchange.getCandles('ETHUSDT', '1d', 1);
    const larger = exchange.getCandles('ETHUSDT', '1d', 6);
    await vi.waitFor(() => expect(mockClient.futuresCandles).toHaveBeenCalledOnce());
    resolveFirst(
      Array.from({ length: 5 }, (_, index) => ({
        openTime: index,
        open: '100',
        high: '110',
        low: '90',
        close: '105',
        volume: '10',
        baseAssetVolume: '4',
        closeTime: index + 1,
      })),
    );
    await expect(first).resolves.toHaveLength(1);
    await expect(larger).resolves.toHaveLength(6);
    expect(mockClient.futuresCandles).toHaveBeenCalledTimes(2);
  });

  it('preserves the 5m WS candle and AggTrade buyVolume overlay', async () => {
    const candleUnsubscribe = vi.fn();
    const aggTradeUnsubscribe = vi.fn();
    const candleSubscription = vi
      .spyOn(WebSocketManager.prototype, 'connectCandles')
      .mockImplementation((_symbol, _interval, callback) => {
        callback({
          startTime: 300_000,
          closeTime: 599_999,
          open: '100',
          high: '110',
          low: '90',
          close: '105',
          volume: '10',
          baseAssetVolume: '4',
          buyVolume: '4',
        } as any);
        return candleUnsubscribe;
      });
    const aggTradeSubscription = vi
      .spyOn(WebSocketManager.prototype, 'connectAggTrades')
      .mockImplementation((_symbol, callback) => {
        callback({
          isBuyerMaker: false,
          quantity: '2',
          price: '105',
          eventTime: 300_001,
          receivedAtMs: 300_002,
        });
        return aggTradeUnsubscribe;
      });

    const exchange = new BinanceExchange(logger);
    const unsubscribe = exchange.subscribeToCandles('ETHUSDT');
    const current = await exchange.getLastCandle('ETHUSDT');

    expect(current?.openTime).toBe(300_000);
    expect(current?.buyVolume).toBe(6);
    expect(candleSubscription).toHaveBeenCalledWith('ETHUSDT', '5m', expect.any(Function));
    expect(aggTradeSubscription).toHaveBeenCalledWith('ETHUSDT', expect.any(Function));

    unsubscribe();
    expect(candleUnsubscribe).toHaveBeenCalledOnce();
    expect(aggTradeUnsubscribe).toHaveBeenCalledOnce();
    candleSubscription.mockRestore();
    aggTradeSubscription.mockRestore();
  });
});
