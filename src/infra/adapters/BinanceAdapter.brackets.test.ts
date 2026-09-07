import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockClient = vi.hoisted(() => ({
  futuresUserTrades: vi.fn(),
  futuresPing: vi.fn(() => Promise.resolve({})),
  futuresPositionMode: vi.fn(() => Promise.resolve({ dualSidePosition: true })),
  futuresOrder: vi.fn(() =>
    Promise.resolve({ orderId: 123, symbol: 'BTCUSDT', clientOrderId: 'se_client-order-123' }),
  ),
  futuresOpenOrders: vi.fn<() => Promise<Array<Record<string, unknown>>>>(async () => []),
  futuresGetOrder: vi.fn(() =>
    Promise.resolve({
      orderId: 123,
      avgPrice: '100',
      status: 'FILLED',
      symbol: 'BTCUSDT',
      clientOrderId: 'se_client-order-123',
      type: 'MARKET',
    }),
  ),
  futuresLeverage: vi.fn(() => Promise.resolve({ leverage: 20 })),
  futuresMarginType: vi.fn(() => Promise.resolve({})),
  futuresPositionRisk: vi.fn(() => Promise.resolve([{ symbol: 'BTCUSDT', leverage: '20' }])),
  futuresAccountInfo: vi.fn(() =>
    Promise.resolve({ positions: [{ symbol: 'BTCUSDT', marginType: 'isolated' }] }),
  ),
  futuresBook: vi.fn(() =>
    Promise.resolve({
      lastUpdateId: 1,
      bids: [{ price: '100', quantity: '1' }],
      asks: [{ price: '101', quantity: '1' }],
    }),
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
  it.each(['BOTH', 'LONG', 'SHORT'] as const)(
    'identified close sends once and queries exact %s evidence',
    async (positionSide) => {
      const side = positionSide === 'SHORT' ? ('SHORT' as const) : ('LONG' as const);
      const request = {
        symbol: 'BTCUSDT',
        side,
        positionSide,
        quantity: 2,
        clientOrderId: 'bot_cl_' + 'a'.repeat(28),
        notBeforeMs: 100,
      };
      mockClient.futuresOrder.mockRejectedValueOnce(
        Object.assign(new Error('lost ACK'), { code: -4061 }),
      );
      const exchange = new BinanceExchange(logger);
      await expect(exchange.sendMarketCloseOnce(request)).rejects.toThrow('lost ACK');
      expect(mockClient.futuresOrder).toHaveBeenCalledTimes(1);
      expect(mockClient.futuresOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          newClientOrderId: request.clientOrderId,
          quantity: '2',
          positionSide,
          ...(positionSide === 'BOTH' ? { reduceOnly: 'true' } : {}),
        }),
      );
      if (positionSide !== 'BOTH')
        expect((mockClient.futuresOrder.mock.calls as unknown[][])[0][0]).not.toHaveProperty(
          'reduceOnly',
        );
      const response = {
        symbol: request.symbol,
        clientOrderId: request.clientOrderId,
        orderId: 99,
        type: 'MARKET',
        side: side === 'LONG' ? 'SELL' : 'BUY',
        positionSide,
        reduceOnly: positionSide === 'BOTH',
        status: 'FILLED',
        origQty: '2',
        executedQty: '2',
        time: 100,
        updateTime: 101,
      };
      mockClient.futuresGetOrder.mockResolvedValue(response as any);
      expect(await exchange.readMarketCloseByClientOrderId(request)).toMatchObject({
        orderId: '99',
        status: 'FILLED',
        executedQuantity: 2,
      });
      expect(mockClient.futuresGetOrder).toHaveBeenLastCalledWith({
        symbol: 'BTCUSDT',
        origClientOrderId: request.clientOrderId,
      });
      for (const patch of [
        { symbol: 'ETHUSDT' },
        { clientOrderId: 'other' },
        { orderId: 9007199254740992 },
        { type: 'LIMIT' },
        { side: side === 'LONG' ? 'BUY' : 'SELL' },
        { positionSide: 'UNKNOWN' },
        { origQty: '1' },
        { executedQty: '1' },
        { reduceOnly: !response.reduceOnly },
        { reduceOnly: undefined },
        { status: 'UNKNOWN' },
        { time: 99 },
        { updateTime: 98 },
      ]) {
        mockClient.futuresGetOrder.mockResolvedValue({ ...response, ...patch } as any);
        expect(
          await exchange.readMarketCloseByClientOrderId(request),
          JSON.stringify(patch),
        ).toBeNull();
      }
      mockClient.futuresGetOrder.mockResolvedValue({
        ...response,
        status: 'PARTIALLY_FILLED',
        executedQty: '1',
      } as any);
      expect(await exchange.readMarketCloseByClientOrderId(request)).toMatchObject({
        status: 'PARTIALLY_FILLED',
        executedQuantity: 1,
      });
      mockClient.futuresGetOrder.mockRejectedValueOnce(
        Object.assign(new Error('absent'), { code: -2013 }),
      );
      await expect(exchange.readMarketCloseByClientOrderId(request)).rejects.toThrow('absent');
      expect(mockClient.futuresOrder).toHaveBeenCalledTimes(1);
    },
  );
  it.each(['standard', 'algo'] as const)(
    'queries exact %s cancel target, not a CID or open-order list',
    async (kind) => {
      const algo = kind === 'algo';
      const request = {
        symbol: 'BTCUSDT',
        side: 'LONG' as const,
        orderId: algo ? 'ALGO_123' : '123',
        type: 'STOP_MARKET' as const,
        positionSide: 'LONG' as const,
        stopPrice: 90,
      };
      let response: Record<string, unknown> = {
        symbol: 'BTCUSDT',
        side: 'SELL',
        positionSide: 'LONG',
        closePosition: true,
        orderId: 123,
        algoId: 123,
        type: 'STOP_MARKET',
        orderType: 'STOP_MARKET',
        algoType: 'CONDITIONAL',
        stopPrice: '90',
        triggerPrice: '90',
        status: 'CANCELED',
        algoStatus: 'CANCELED',
        clientOrderId: 'se_legacy',
        clientAlgoId: 'bot_sl_' + 'a'.repeat(28),
      };
      mockClient.futuresGetOrder.mockImplementation(async () => response as any);
      const fetch = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async () => new Response(JSON.stringify(response), { status: 200 }));
      try {
        const exchange = new BinanceExchange(logger);
        expect(await exchange.readCancelTarget(request)).toBe('CANCELED');
        if (algo) {
          const url = String(fetch.mock.calls[0][0]);
          expect(url).toContain('/fapi/v1/algoOrder?');
          expect(url).toContain('algoId=123');
          expect(url).not.toContain('clientAlgoId=');
          expect(mockClient.futuresGetOrder).not.toHaveBeenCalled();
        } else {
          expect(mockClient.futuresGetOrder).toHaveBeenCalledExactlyOnceWith({
            symbol: 'BTCUSDT',
            orderId: 123,
          });
          expect(fetch).not.toHaveBeenCalled();
        }
        const original = { ...response };
        for (const patch of [
          { symbol: 'ETHUSDT' },
          { side: 'BUY' },
          { positionSide: 'SHORT' },
          { clientOrderId: 'manual', clientAlgoId: 'manual' },
          { orderId: 124, algoId: 124 },
          { stopPrice: '91', triggerPrice: '91' },
          { type: 'LIMIT', orderType: 'LIMIT' },
          { closePosition: false },
          { status: 'EXPIRED', algoStatus: 'FINISHED' },
          { orderId: Number.MAX_SAFE_INTEGER + 1, algoId: Number.MAX_SAFE_INTEGER + 1 },
        ]) {
          response = { ...original, ...patch };
          expect(await exchange.readCancelTarget(request)).toBeNull();
        }
        response = { ...original, status: 'FILLED', algoStatus: 'FILLED' };
        expect(await exchange.readCancelTarget(request)).toBe('FILLED');
        expect(mockClient.futuresOpenOrders).not.toHaveBeenCalled();
        expect(mockClient.futuresOrder).not.toHaveBeenCalled();
      } finally {
        fetch.mockRestore();
      }
    },
  );

  it.each([
    ['se_legacy', 'BOT'],
    ['bot_sl_' + 'a'.repeat(28), 'BOT'],
    ['bot_sl_manual', 'UNKNOWN'],
    ['bot_sl_' + 'a'.repeat(29), 'UNKNOWN'],
    ['manual', 'UNKNOWN'],
  ])('preserves side and recognizes protection ID %s as %s in both listings', async (id, owner) => {
    mockClient.futuresOpenOrders.mockResolvedValueOnce([
      {
        orderId: 123,
        type: 'STOP_MARKET',
        stopPrice: '90',
        side: 'SELL',
        positionSide: 'LONG',
        closePosition: true,
        workingType: 'MARK_PRICE',
        clientOrderId: id,
      },
    ]);
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            algoId: 456,
            algoType: 'CONDITIONAL',
            orderType: 'STOP_MARKET',
            triggerPrice: '90',
            side: 'SELL',
            positionSide: 'LONG',
            closePosition: true,
            workingType: 'MARK_PRICE',
            clientAlgoId: id,
          },
        ]),
        { status: 200 },
      ),
    );
    try {
      const orders = await new BinanceExchange(logger).listCloseOrdersForSide('BTCUSDT', 'LONG');
      expect(orders).toHaveLength(2);
      expect(orders).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ orderId: '123', side: 'SELL', owner }),
          expect.objectContaining({ orderId: 'ALGO_456', side: 'SELL', owner }),
        ]),
      );
      expect(mockClient.futuresOrder).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });
  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.futuresPing.mockResolvedValue({});
    mockClient.futuresPositionMode.mockResolvedValue({ dualSidePosition: true });
    mockClient.futuresOrder.mockResolvedValue({
      orderId: 123,
      symbol: 'BTCUSDT',
      clientOrderId: 'se_client-order-123',
    });
    mockClient.futuresGetOrder.mockResolvedValue({
      orderId: 123,
      avgPrice: '100',
      status: 'FILLED',
      symbol: 'BTCUSDT',
      clientOrderId: 'se_client-order-123',
      type: 'MARKET',
    });
    mockClient.futuresLeverage.mockResolvedValue({ leverage: 20 });
    mockClient.futuresMarginType.mockResolvedValue({});
    mockClient.futuresPositionRisk.mockResolvedValue([{ symbol: 'BTCUSDT', leverage: '20' }]);
    mockClient.futuresAccountInfo.mockResolvedValue({
      positions: [{ symbol: 'BTCUSDT', marginType: 'isolated' }],
    });
    mockClient.futuresBook.mockResolvedValue({
      lastUpdateId: 1,
      bids: [{ price: '100', quantity: '1' }],
      asks: [{ price: '101', quantity: '1' }],
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

  it('sends identified conditional stop exactly once and queries the same clientAlgoId', async () => {
    const request = {
      symbol: 'BTCUSDT',
      side: 'LONG' as const,
      positionSide: 'BOTH' as const,
      triggerPrice: 90,
      closePosition: true as const,
      workingType: 'MARK_PRICE' as const,
      clientOrderId: `bot_sl_${'a'.repeat(28)}`,
    };
    const order = {
      symbol: request.symbol,
      clientAlgoId: request.clientOrderId,
      algoId: 456,
      algoStatus: 'NEW',
      algoType: 'CONDITIONAL',
      orderType: 'STOP_MARKET',
      side: 'SELL',
      positionSide: 'BOTH',
      triggerPrice: '90',
      workingType: 'MARK_PRICE',
      closePosition: true,
    };
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(order)));
    try {
      const exchange = new BinanceExchange(logger);
      expect(await exchange.sendStopCloseOnce(request)).toEqual({
        clientOrderId: request.clientOrderId,
        orderId: '456',
      });
      const body = new URLSearchParams(String(fetch.mock.calls[0][1]?.body));
      expect(body.get('clientAlgoId')).toBe(request.clientOrderId);
      expect(body.get('quantity')).toBeNull();
      expect(body.get('closePosition')).toBe('true');
      fetch.mockResolvedValue(new Response(JSON.stringify(order)));
      expect(await exchange.readStopCloseByClientOrderId(request)).toEqual({
        clientOrderId: request.clientOrderId,
        orderId: '456',
      });
      const query = new URL(String(fetch.mock.calls[1][0]));
      expect(query.pathname).toBe('/fapi/v1/algoOrder');
      expect(query.searchParams.get('clientAlgoId')).toBe(request.clientOrderId);
      expect(fetch.mock.calls[1][1]?.method).toBe('GET');
      expect(mockClient.futuresOrder).not.toHaveBeenCalled();
      expect(mockClient.futuresPositionMode).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

  it.each(['NEW', 'CANCELED', 'TRIGGERED', 'FINISHED', 'EXPIRED', 'UNKNOWN'])(
    'exposes only explicitly understood conditional lifecycle %s',
    async (status) => {
      const request = {
        symbol: 'BTCUSDT',
        side: 'LONG' as const,
        positionSide: 'BOTH' as const,
        triggerPrice: 90,
        closePosition: true as const,
        workingType: 'MARK_PRICE' as const,
        clientOrderId: `bot_sl_${'a'.repeat(28)}`,
      };
      const order = {
        symbol: request.symbol,
        clientAlgoId: request.clientOrderId,
        algoId: 456,
        algoStatus: status,
        algoType: 'CONDITIONAL',
        orderType: 'STOP_MARKET',
        side: 'SELL',
        positionSide: 'BOTH',
        triggerPrice: '90',
        workingType: 'MARK_PRICE',
        closePosition: true,
      };
      const fetch = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async () => new Response(JSON.stringify(order)));
      try {
        const exchange = new BinanceExchange(logger);
        const observed = await exchange.readStopCloseState(request);
        if (status === 'NEW' || status === 'CANCELED')
          expect(observed).toEqual({
            clientOrderId: request.clientOrderId,
            orderId: '456',
            status,
          });
        else expect(observed).toBeNull();
        const protectedOrder = await exchange.readStopCloseByClientOrderId(request);
        expect(protectedOrder !== null).toBe(status === 'NEW');
        expect(fetch.mock.calls.every(([, options]) => options?.method === 'GET')).toBe(true);
        expect(mockClient.futuresOrder).not.toHaveBeenCalled();
      } finally {
        fetch.mockRestore();
      }
    },
  );

  it('fresh position reads do not reuse cached account flat/open evidence', async () => {
    const row = {
      symbol: 'BTCUSDT',
      positionSide: 'BOTH',
      positionAmt: '0.02',
      entryPrice: '100',
      leverage: '20',
      marginType: 'isolated',
    };
    mockClient.futuresAccountInfo.mockResolvedValueOnce({ positions: [row] });
    const exchange = new BinanceExchange(logger);
    expect(await exchange.readActivePosition('BTCUSDT', 'LONG')).toMatchObject({ qtyAbs: 0.02 });
    const flat = { ...row, positionAmt: '0' };
    mockClient.futuresPositionRisk.mockResolvedValueOnce([flat]);
    expect(await exchange.readFreshActivePosition('BTCUSDT', 'LONG')).toBeNull();
    mockClient.futuresPositionRisk.mockResolvedValueOnce([row]);
    expect(await exchange.readFreshActivePosition('BTCUSDT', 'LONG')).toMatchObject({
      qtyAbs: 0.02,
    });
    expect(mockClient.futuresPositionRisk).toHaveBeenCalledTimes(2);
    expect(mockClient.futuresAccountInfo).toHaveBeenCalledTimes(1);
  });

  it.each([
    'missing-row',
    'duplicate-row',
    'invalid-quantity',
    'missing-quantity',
    'invalid-price',
    'invalid-leverage',
  ])('rejects fresh position uncertainty %s instead of returning null', async (failure) => {
    const row = {
      symbol: 'BTCUSDT',
      positionSide: 'BOTH',
      positionAmt: '0.02',
      entryPrice: '100',
      leverage: '20',
    };
    const invalid = {
      ...row,
      ...(failure === 'invalid-quantity' ? { positionAmt: 'NaN' } : {}),
      ...(failure === 'missing-quantity' ? { positionAmt: '' } : {}),
      ...(failure === 'invalid-price' ? { entryPrice: '0' } : {}),
      ...(failure === 'invalid-leverage' ? { leverage: 'NaN' } : {}),
    };
    mockClient.futuresPositionRisk.mockResolvedValueOnce(
      failure === 'missing-row' ? [] : failure === 'duplicate-row' ? [row, row] : [invalid],
    );
    await expect(
      new BinanceExchange(logger).readFreshActivePosition('BTCUSDT', 'LONG'),
    ).rejects.toThrow();
    expect(mockClient.futuresOrder).not.toHaveBeenCalled();
  });

  it.each([
    { clientAlgoId: 'other' },
    { algoId: null },
    { algoStatus: 'CANCELED' },
    { algoStatus: 'TRIGGERED' },
    { symbol: 'OTHER' },
    { positionSide: 'LONG' },
    { side: 'BUY' },
    { triggerPrice: '89' },
    { closePosition: false },
    { workingType: 'CONTRACT_PRICE' },
    { orderType: 'TAKE_PROFIT_MARKET' },
  ])('does not confirm mismatching conditional evidence %j', async (override) => {
    const request = {
      symbol: 'BTCUSDT',
      side: 'LONG' as const,
      positionSide: 'BOTH' as const,
      triggerPrice: 90,
      closePosition: true as const,
      workingType: 'MARK_PRICE' as const,
      clientOrderId: `bot_sl_${'a'.repeat(28)}`,
    };
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          symbol: request.symbol,
          clientAlgoId: request.clientOrderId,
          algoId: 456,
          algoStatus: 'NEW',
          algoType: 'CONDITIONAL',
          orderType: 'STOP_MARKET',
          side: 'SELL',
          positionSide: 'BOTH',
          triggerPrice: '90',
          workingType: 'MARK_PRICE',
          closePosition: true,
          ...override,
        }),
      ),
    );
    try {
      expect(await new BinanceExchange(logger).readStopCloseByClientOrderId(request)).toBeNull();
    } finally {
      fetch.mockRestore();
    }
  });

  it.each([-4061, -4120, -2013])(
    'identified conditional transport never retries error %s',
    async (code) => {
      const fetch = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(JSON.stringify({ code, msg: 'fixture' }), { status: 400 }));
      try {
        await expect(
          new BinanceExchange(logger).sendStopCloseOnce({
            symbol: 'BTCUSDT',
            side: 'LONG',
            positionSide: 'BOTH',
            triggerPrice: 90,
            closePosition: true,
            workingType: 'MARK_PRICE',
            clientOrderId: `bot_sl_${'a'.repeat(28)}`,
          }),
        ).rejects.toThrow();
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(mockClient.futuresOrder).not.toHaveBeenCalled();
      } finally {
        fetch.mockRestore();
      }
    },
  );

  it.each(['timeout', 'network lost', 'Position side does not match'])(
    'does not resend a stop via fallback on uncoded %s',
    async (message) => {
      const error = new Error(message);
      mockClient.futuresOrder.mockRejectedValueOnce(error);
      const fetch = vi
        .spyOn(globalThis, 'fetch')
        .mockRejectedValue(new Error('unexpected network'));
      try {
        await expect(
          new BinanceExchange(logger).placeStopClose('BTCUSDT', 'LONG', 90),
        ).rejects.toBe(error);
        expect(mockClient.futuresOrder).toHaveBeenCalledTimes(1);
        expect(fetch).not.toHaveBeenCalled();
      } finally {
        fetch.mockRestore();
      }
    },
  );

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

  it('does not fallback or resend an identified open after position-mode rejection', async () => {
    const error = Object.assign(new Error('Position side does not match'), { code: -4061 });
    mockClient.futuresOrder.mockRejectedValueOnce(error);
    const exchange = new BinanceExchange(logger);
    await expect(exchange.marketOpen('BTCUSDT', 'LONG', 0.02, 'se_client-order-123')).rejects.toBe(
      error,
    );
    expect(mockClient.futuresOrder).toHaveBeenCalledTimes(1);
  });

  it.each([
    {},
    { side: 'SELL' },
    { positionSide: 'SHORT' },
    { executedQty: '0.01' },
    { origQty: '0.03' },
    { status: 'PARTIALLY_FILLED' },
    { time: 999 },
    { avgPrice: 'NaN' },
  ])('requires exact fully executed request evidence for recovery: %j', async (patch) => {
    mockClient.futuresGetOrder.mockResolvedValueOnce({
      orderId: 123,
      avgPrice: '100',
      status: 'FILLED',
      symbol: 'BTCUSDT',
      clientOrderId: 'se_client-order-123',
      type: 'MARKET',
      side: 'BUY',
      positionSide: 'BOTH',
      origQty: '0.02',
      executedQty: '0.02',
      time: 1000,
      ...patch,
    });
    const exchange = new BinanceExchange(logger);
    const result = exchange.readMarketOpenByClientOrderId('BTCUSDT', 'se_client-order-123', {
      side: 'LONG',
      quantity: 0.02,
      notBeforeMs: 1000,
    });
    if (Object.keys(patch).length === 0)
      await expect(result).resolves.toEqual({ orderId: '123', avgPrice: 100 });
    else await expect(result).rejects.toThrow('ENTRY_RECOVERY_EXECUTION_MISMATCH');
    expect(mockClient.futuresOrder).not.toHaveBeenCalled();
  });

  it.each(['symbol', 'clientOrderId', 'type'] as const)(
    'rejects lookup with a different %s',
    async (field) => {
      mockClient.futuresGetOrder.mockResolvedValueOnce({
        orderId: 123,
        avgPrice: '100',
        status: 'FILLED',
        symbol: 'BTCUSDT',
        clientOrderId: 'se_client-order-123',
        type: 'MARKET',
        [field]: 'different',
      });
      const exchange = new BinanceExchange(logger);
      await expect(
        exchange.readMarketOpenByClientOrderId('BTCUSDT', 'se_client-order-123'),
      ).rejects.toThrow('ENTRY_LOOKUP_IDENTITY_MISMATCH');
      expect(mockClient.futuresOrder).not.toHaveBeenCalled();
    },
  );

  it('fails closed when leverage readback disagrees', async () => {
    mockClient.futuresPositionRisk.mockResolvedValue([{ symbol: 'BTCUSDT', leverage: '10' }]);
    const exchange = new BinanceExchange(logger as any);

    await expect(exchange.setLeverage('BTCUSDT', 20)).rejects.toThrow('leverage readback mismatch');
  });

  it.each(['valid', 'other-fill', 'duplicate', 'partial', 'full-page', 'position-changed'])(
    'requires bounded attribution of the current position: %s',
    async (scenario) => {
      const time = Date.now() - 1000;
      const opening = {
        orderId: 123,
        avgPrice: '100',
        status: 'FILLED',
        symbol: 'BTCUSDT',
        clientOrderId: 'se_client-order-123',
        type: 'MARKET',
        side: 'BUY',
        positionSide: 'BOTH',
        origQty: '0.02',
        executedQty: '0.02',
        time,
        updateTime: time + 100,
        reduceOnly: false,
        closePosition: false,
      };
      mockClient.futuresGetOrder.mockResolvedValueOnce(opening);
      const position = {
        symbol: 'BTCUSDT',
        leverage: '20',
        entryPrice: '100',
        positionAmt: '0.02',
        positionSide: 'BOTH',
        updateTime: time + 100,
      };
      mockClient.futuresPositionRisk.mockResolvedValue([position]);
      const changedPosition = { ...position, updateTime: time + 200 };
      if (scenario === 'position-changed')
        mockClient.futuresPositionRisk
          .mockResolvedValueOnce([position])
          .mockResolvedValueOnce([changedPosition]);
      const fill = {
        symbol: 'BTCUSDT',
        id: 1,
        orderId: 123,
        side: 'BUY',
        positionSide: 'BOTH',
        qty: '0.02',
        price: '100',
        time: time + 100,
      };
      mockClient.futuresUserTrades.mockResolvedValue(
        scenario === 'full-page'
          ? Array(1000).fill(fill)
          : scenario === 'duplicate'
            ? [fill, fill]
            : [
                {
                  ...fill,
                  ...(scenario === 'other-fill' ? { orderId: 999 } : {}),
                  ...(scenario === 'partial' ? { qty: '0.01' } : {}),
                },
              ],
      );
      const exchange = new BinanceExchange(logger);
      const result = await exchange.readRecoverableEntryPosition('BTCUSDT', 'se_client-order-123', {
        side: 'LONG',
        quantity: 0.02,
        notBeforeMs: time,
      });
      if (scenario === 'valid')
        expect(result).toMatchObject({
          source: 'BINANCE_ORDER_AND_TRADES_V1',
          fillIds: ['1'],
          position: { qtyAbs: 0.02 },
        });
      else expect(result).toBeNull();
      expect(mockClient.futuresOrder).not.toHaveBeenCalled();
    },
  );

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

  it('coalesces concurrent margin reconciliation for one symbol', async () => {
    const exchange = new BinanceExchange(logger as any);

    await Promise.all([
      exchange.ensureMarginType('BTCUSDT', 'ISOLATED'),
      exchange.ensureMarginType('BTCUSDT', 'ISOLATED'),
    ]);

    expect(mockClient.futuresAccountInfo).toHaveBeenCalledTimes(1);
    expect(mockClient.futuresMarginType).not.toHaveBeenCalled();
  });

  it('accounts for the weighted depth request in the shared scheduler', async () => {
    const exchange = new BinanceExchange(logger as any);

    await exchange.getDepthSnapshot('BTCUSDT', 20);

    expect(exchange.getRequestMetrics()).toMatchObject({
      requests: 2,
      totalWeight: 25,
      weightUsed: 25,
    });
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
