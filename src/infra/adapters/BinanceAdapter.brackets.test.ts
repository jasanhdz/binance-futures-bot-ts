import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockClient = vi.hoisted(() => ({
  futuresPing: vi.fn(() => Promise.resolve({})),
  futuresPositionMode: vi.fn(() => Promise.resolve({ dualSidePosition: true })),
  futuresOrder: vi.fn(() => Promise.resolve({ orderId: 123 })),
  futuresOpenOrders: vi.fn(() => Promise.resolve([])),
  futuresGetOrder: vi.fn(() =>
    Promise.resolve({ orderId: 123, avgPrice: '100', status: 'FILLED' }),
  ),
  futuresLeverage: vi.fn(() => Promise.resolve({ leverage: 20 })),
  futuresMarginType: vi.fn(() => Promise.resolve({})),
  futuresPositionRisk: vi.fn(() => Promise.resolve([{ symbol: 'BTCUSDT', leverage: '20' }])),
  futuresAccountInfo: vi.fn(() =>
    Promise.resolve({ positions: [{ symbol: 'BTCUSDT', marginType: 'isolated' }] }),
  ),
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
    mockClient.futuresGetOrder.mockResolvedValue({
      orderId: 123,
      avgPrice: '100',
      status: 'FILLED',
    });
    mockClient.futuresLeverage.mockResolvedValue({ leverage: 20 });
    mockClient.futuresMarginType.mockResolvedValue({});
    mockClient.futuresPositionRisk.mockResolvedValue([{ symbol: 'BTCUSDT', leverage: '20' }]);
    mockClient.futuresAccountInfo.mockResolvedValue({
      positions: [{ symbol: 'BTCUSDT', marginType: 'isolated' }],
    });
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

  it.each([
    ['one-way long', 'LONG', 'BOTH', 'SELL', { reduceOnly: 'true' }],
    ['one-way short', 'SHORT', 'BOTH', 'BUY', { reduceOnly: 'true' }],
    ['hedge long', 'LONG', 'LONG', 'SELL', { positionSide: 'LONG' }],
    ['hedge short', 'SHORT', 'SHORT', 'BUY', { positionSide: 'SHORT' }],
  ] as const)(
    'closes %s with a protected market payload',
    async (_name, side, sideMode, orderSide, modeFields) => {
      const exchange = new BinanceExchange(logger as any);

      await exchange.closeSideMarketSafe('BTCUSDT', side, 0.02, sideMode);

      expect(mockClient.futuresOrder).toHaveBeenCalledTimes(1);
      expect(mockClient.futuresOrder).toHaveBeenCalledWith({
        symbol: 'BTCUSDT',
        type: 'MARKET',
        quantity: '0.02',
        newOrderRespType: 'RESULT',
        side: orderSide,
        ...modeFields,
      });
    },
  );

  it('fails closed for an unknown close mode', async () => {
    const exchange = new BinanceExchange(logger as any);

    await expect(
      exchange.closeSideMarketSafe('BTCUSDT', 'LONG', 0.02, 'UNKNOWN' as any),
    ).rejects.toThrow('position mode is unknown or mismatched');

    expect(mockClient.futuresOrder).not.toHaveBeenCalled();
  });

  it.each(['Position side does not match', 'ReduceOnly Order is rejected'])(
    'does not retry a protected close as an unrestricted market order after %s',
    async (message) => {
      mockClient.futuresOrder.mockRejectedValueOnce(new Error(message));
      const exchange = new BinanceExchange(logger as any);

      await expect(exchange.closeSideMarketSafe('BTCUSDT', 'LONG', 0.02, 'BOTH')).rejects.toThrow(
        message,
      );

      expect(mockClient.futuresOrder).toHaveBeenCalledTimes(1);
      expect(mockClient.futuresOrder).toHaveBeenCalledWith(
        expect.objectContaining({ reduceOnly: 'true' }),
      );
    },
  );

  it('blocks order mutations when position mode detection fails', async () => {
    mockClient.futuresPositionMode.mockRejectedValueOnce(new Error('position mode unavailable'));
    const exchange = new BinanceExchange(logger as any);

    await expect(exchange.marketOpen('BTCUSDT', 'LONG', 0.02)).rejects.toThrow(
      'Binance position mode is unknown',
    );

    expect(mockClient.futuresOrder).not.toHaveBeenCalled();
  });

  it('forwards a client order ID and reads market opens by that ID', async () => {
    const exchange = new BinanceExchange(logger as any);

    await exchange.marketOpen('BTCUSDT', 'LONG', 0.02, 'se_client-order-123');
    const order = await exchange.readMarketOpenByClientOrderId('BTCUSDT', 'se_client-order-123');

    expect(mockClient.futuresOrder).toHaveBeenCalledWith(
      expect.objectContaining({ newClientOrderId: 'se_client-order-123' }),
    );
    expect(mockClient.futuresGetOrder).toHaveBeenCalledWith({
      symbol: 'BTCUSDT',
      origClientOrderId: 'se_client-order-123',
    });
    expect(order).toEqual({ avgPrice: 100, orderId: '123' });
  });

  it('fails closed when leverage readback disagrees', async () => {
    mockClient.futuresPositionRisk.mockResolvedValue([{ symbol: 'BTCUSDT', leverage: '10' }]);
    const exchange = new BinanceExchange(logger as any);

    await expect(exchange.setLeverage('BTCUSDT', 20)).rejects.toThrow('leverage readback mismatch');
  });

  it('does not accept an ambiguous margin-type change', async () => {
    mockClient.futuresAccountInfo.mockResolvedValue({
      positions: [{ symbol: 'BTCUSDT', marginType: 'cross' }],
    });
    const exchange = new BinanceExchange(logger as any);

    await expect(exchange.ensureMarginType('BTCUSDT', 'ISOLATED')).rejects.toThrow(
      'margin type readback mismatch',
    );
  });

  it('maps Binance cross margin readback to CROSSED', async () => {
    mockClient.futuresAccountInfo.mockResolvedValue({
      positions: [{ symbol: 'BTCUSDT', marginType: 'cross' }],
    });
    const exchange = new BinanceExchange(logger as any);

    await exchange.ensureMarginType('BTCUSDT', 'CROSSED');

    expect(mockClient.futuresMarginType).not.toHaveBeenCalled();
  });

  it('uses distinct owned client IDs for repeated bracket placements', async () => {
    const exchange = new BinanceExchange(logger as any);

    await exchange.placeStopClose('BTCUSDT', 'LONG', 100);
    await exchange.placeStopClose('BTCUSDT', 'LONG', 100);

    const calls = mockClient.futuresOrder.mock.calls as unknown as Array<[Record<string, unknown>]>;
    const ids = calls.map((call) => call[0].newClientOrderId);
    expect(ids[0]).toMatch(/^se_sl_/);
    expect(ids[1]).toMatch(/^se_sl_/);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('reports listing failure instead of converting it to empty discovery', async () => {
    mockClient.futuresOpenOrders.mockRejectedValueOnce(new Error('orders unavailable'));
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: true, json: async () => [] })),
    );
    const exchange = new BinanceExchange(logger as any);

    await expect(exchange.listCloseOrdersForSide('BTCUSDT', 'LONG')).rejects.toThrow(
      'close-order listing failed',
    );
    vi.unstubAllGlobals();
  });
});
