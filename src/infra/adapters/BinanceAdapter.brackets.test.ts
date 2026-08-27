import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockClient = vi.hoisted(() => ({
  futuresPing: vi.fn(() => Promise.resolve({})),
  futuresPositionMode: vi.fn(() => Promise.resolve({ dualSidePosition: true })),
  futuresOrder: vi.fn(() => Promise.resolve({ orderId: 123 })),
}));

vi.mock('binance-api-node', () => ({
  default: vi.fn(() => mockClient),
}));

import { BinanceExchange } from './BinanceAdapter';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

describe('BinanceExchange bracket placement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.futuresPing.mockResolvedValue({});
    mockClient.futuresPositionMode.mockResolvedValue({ dualSidePosition: true });
    mockClient.futuresOrder.mockResolvedValue({ orderId: 123 });
  });

  it('places stop brackets as standard close-position orders first', async () => {
    const exchange = new BinanceExchange(logger as any);

    await exchange.placeStopClose('BTCUSDT', 'LONG', 100);

    expect(mockClient.futuresOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: 'BTCUSDT',
        side: 'SELL',
        type: 'STOP_MARKET',
        stopPrice: '100.00',
        closePosition: 'true',
        positionSide: 'LONG',
        workingType: 'MARK_PRICE',
      }),
    );
  });

  it('places take-profit brackets as standard hedge-side close orders when quantity is provided', async () => {
    const exchange = new BinanceExchange(logger as any);

    await exchange.placeTpClose('BTCUSDT', 'SHORT', 95, 0.02);

    expect(mockClient.futuresOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: 'BTCUSDT',
        side: 'BUY',
        type: 'TAKE_PROFIT_MARKET',
        stopPrice: '95.00',
        quantity: '0.02',
        positionSide: 'SHORT',
        workingType: 'MARK_PRICE',
      }),
    );
    const firstCallParams = (
      mockClient.futuresOrder.mock.calls[0] as unknown as [Record<string, unknown>]
    )[0];
    expect(firstCallParams).not.toHaveProperty('reduceOnly');
  });
});
