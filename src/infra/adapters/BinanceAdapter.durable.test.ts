import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDurableEntryIntent } from '../../execution-durable/DurableExecutionLifecycle';

const mockClient = vi.hoisted(() => ({
  futuresPing: vi.fn(),
  futuresPositionMode: vi.fn(),
  futuresOrder: vi.fn(),
  futuresGetOrder: vi.fn(),
  futuresUserTrades: vi.fn(),
  futuresAccountInfo: vi.fn(),
  futuresOpenOrders: vi.fn(),
}));

vi.mock('binance-api-node', () => ({ default: vi.fn(() => mockClient) }));

import { BinanceExchange } from './BinanceAdapter';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

function intent() {
  return createDurableEntryIntent({
    signalId: 'signal-1',
    symbol: 'ETHUSDT',
    side: 'LONG',
    quantity: 0.25,
    expectedPrice: 100,
    policyId: 'v18-test',
    featureHash: 'feature-hash',
    createdAt: '2026-08-12T00:00:00Z',
  });
}

describe('Binance durable execution transport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.futuresPing.mockResolvedValue({});
    mockClient.futuresPositionMode.mockResolvedValue({ dualSidePosition: false });
    mockClient.futuresOrder.mockResolvedValue({ orderId: 1 });
    mockClient.futuresUserTrades.mockResolvedValue([]);
    mockClient.futuresAccountInfo.mockResolvedValue({ positions: [] });
    mockClient.futuresOpenOrders.mockResolvedValue([]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => [] })),
    );
  });

  it('submits entry and reduce-only exit with deterministic client identities', async () => {
    const exchange = new BinanceExchange(logger as any);
    const entry = intent();
    await exchange.submitEntry(entry);
    expect(mockClient.futuresOrder).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        newClientOrderId: entry.clientOrderId,
        side: 'BUY',
        type: 'MARKET',
        quantity: '0.25',
      }),
    );
    await exchange.submitReduceOnlyClose(entry, {
      symbol: entry.symbol,
      side: entry.side,
      quantity: entry.quantity,
      entryPrice: 100,
    });
    expect(mockClient.futuresOrder).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        newClientOrderId: entry.closeClientOrderId,
        side: 'SELL',
        reduceOnly: 'true',
      }),
    );
  });

  it('reconciles order, fills, position and protection by durable identity', async () => {
    const exchange = new BinanceExchange(logger as any);
    const entry = intent();
    mockClient.futuresGetOrder
      .mockResolvedValueOnce({
        status: 'PARTIALLY_FILLED',
        clientOrderId: entry.clientOrderId,
        orderId: 77,
        origQty: '0.25',
        executedQty: '0.10',
        avgPrice: '101',
      })
      .mockRejectedValueOnce({ code: -2013, message: 'Order does not exist' });
    mockClient.futuresUserTrades.mockResolvedValue([
      { orderId: 77, side: 'BUY', price: '101', qty: '0.10', time: 1 },
      { orderId: 88, side: 'BUY', price: '99', qty: '1', time: 1 },
    ]);
    mockClient.futuresAccountInfo.mockResolvedValue({
      positions: [
        {
          symbol: 'ETHUSDT',
          positionAmt: '0.10',
          positionSide: 'BOTH',
          entryPrice: '101',
        },
      ],
    });
    mockClient.futuresOpenOrders.mockResolvedValue([
      {
        orderId: 1,
        type: 'STOP_MARKET',
        side: 'SELL',
        positionSide: 'BOTH',
        stopPrice: '95',
        closePosition: true,
      },
      {
        orderId: 2,
        type: 'TAKE_PROFIT_MARKET',
        side: 'SELL',
        positionSide: 'BOTH',
        stopPrice: '110',
        closePosition: true,
      },
    ]);
    const truth = await exchange.readTruth(entry);
    expect(truth.conclusive).toBe(true);
    expect(truth.order.status).toBe('PARTIALLY_FILLED');
    expect(truth.fillsQuantity).toBe(0.1);
    expect(truth.position?.quantity).toBe(0.1);
    expect(truth.protection).toEqual({
      stopPresent: true,
      takeProfitPresent: true,
      protectedQuantity: 0.1,
      stopPrice: 95,
      takeProfitPrice: 110,
    });
  });

  it('does not report a position as fully protected when either bracket covers less quantity', async () => {
    const exchange = new BinanceExchange(logger as any);
    const entry = intent();
    mockClient.futuresGetOrder
      .mockRejectedValueOnce({ code: -2013, message: 'Order does not exist' })
      .mockRejectedValueOnce({ code: -2013, message: 'Order does not exist' });
    mockClient.futuresAccountInfo.mockResolvedValue({
      positions: [
        {
          symbol: 'ETHUSDT',
          positionAmt: '0.25',
          positionSide: 'BOTH',
          entryPrice: '100',
        },
      ],
    });
    mockClient.futuresOpenOrders.mockResolvedValue([
      {
        orderId: 1,
        type: 'STOP_MARKET',
        side: 'SELL',
        positionSide: 'BOTH',
        stopPrice: '95',
        origQty: '0.25',
      },
      {
        orderId: 2,
        type: 'TAKE_PROFIT_MARKET',
        side: 'SELL',
        positionSide: 'BOTH',
        stopPrice: '110',
        origQty: '0.10',
      },
    ]);
    const truth = await exchange.readTruth(entry);
    expect(truth.protection.protectedQuantity).toBe(0.1);
  });

  it('returns conclusive NOT_FOUND only for Binance unknown-order responses', async () => {
    const exchange = new BinanceExchange(logger as any);
    const entry = intent();
    mockClient.futuresGetOrder
      .mockRejectedValueOnce({ code: -2013, message: 'Order does not exist' })
      .mockRejectedValueOnce({ code: -2013, message: 'Order does not exist' });
    const truth = await exchange.readTruth(entry);
    expect(truth.conclusive).toBe(true);
    expect(truth.order.status).toBe('NOT_FOUND');

    mockClient.futuresGetOrder.mockReset();
    mockClient.futuresGetOrder
      .mockRejectedValueOnce(new Error('network timeout'))
      .mockRejectedValueOnce({ code: -2013, message: 'Order does not exist' });
    const ambiguous = await exchange.readTruth(entry);
    expect(ambiguous.conclusive).toBe(false);
  });
});
