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

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

describe('BinanceExchange candle compatibility path', () => {
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
