import { describe, expect, it, vi } from 'vitest';
import { BinanceExchange } from './BinanceAdapter';
import {
  reconcileMicroBurstSettlement,
  type MicroBurstSettlementIdentity,
} from '../../strategies/micro-burst/domain/MicroBurstSettlement';

function fixture(side: 'LONG' | 'SHORT' = 'LONG') {
  const identity: MicroBurstSettlementIdentity = {
    tradeId: 'trade',
    episodeId: 'episode',
    symbol: 'ETHUSDT',
    side,
    policyVersion: 'CONTEXTUAL_V3',
    configHash: `sha256:${'a'.repeat(64)}`,
    codeCommitSha: 'b'.repeat(40),
    entryOrderId: '1',
    closeOrderIds: ['2'],
    quantity: 1,
    openedAtMs: 100,
    closedAtMs: 200,
  };
  const trades = [1, 2].map((id) => ({
    id,
    orderId: id,
    symbol: identity.symbol,
    positionSide: 'BOTH',
    side: (side === 'LONG') === (id === 1) ? 'BUY' : 'SELL',
    qty: '1',
    price: id === 1 ? '100' : '99.25',
    realizedPnl: id === 1 ? '0' : '-0.75',
    commission: '0.125',
    commissionAsset: 'USDT',
    time: id === 1 ? 110 : 190,
  }));
  const client = {
    futuresTime: vi.fn(async () => 300),
    futuresUserTrades: vi.fn(async (_request: unknown) => trades),
    futuresGetOrder: vi.fn(async ({ orderId }: { orderId: number }) => ({
      ...trades[orderId - 1],
      status: 'FILLED',
      origQty: '1',
      executedQty: '1',
    })),
    futuresIncome: vi.fn(async (_request: unknown): Promise<Record<string, unknown>[]> => []),
    futuresPositionRisk: vi.fn(async () => [
      { symbol: identity.symbol, positionSide: 'BOTH', positionAmt: '0' },
    ]),
  };
  const exchange = Object.create(BinanceExchange.prototype) as BinanceExchange;
  Object.assign(exchange, {
    cli: client,
    enqueue: vi.fn(async (work: () => Promise<unknown>) => work()),
  });
  return { identity, trades, client, exchange };
}

describe('Binance exact settlement reads', () => {
  it.each(['LONG', 'SHORT'] as const)(
    'accounts both fee legs for %s and confirms empty funding',
    async (side) => {
      const f = fixture(side);
      const evidence = await f.exchange.readMicroBurstSettlement(f.identity);
      expect(reconcileMicroBurstSettlement(f.identity, evidence!)).toMatchObject({
        status: 'VERIFIED',
        netPnlUsdt: -1,
      });
      expect(f.client.futuresIncome).toHaveBeenCalledWith({
        symbol: 'ETHUSDT',
        incomeType: 'FUNDING_FEE',
        startTime: 100,
        endTime: 200,
        limit: 1000,
      });
      expect(f.client.futuresPositionRisk).toHaveBeenCalledTimes(2);
      expect(f.client.futuresTime).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    { commission: undefined },
    { commission: null },
    { commission: '' },
    { realizedPnl: undefined },
    { commissionAsset: 'BNB' },
    { qty: '0.5' },
    { positionSide: 'LONG' },
    { orderId: 3 },
    { symbol: 'BTCUSDT' },
    { id: 9007199254740992 },
    { time: 99 },
    { side: 'UNKNOWN' },
  ])('does not manufacture evidence from %j', async (patch) => {
    const f = fixture();
    Object.assign(f.trades[0], patch);
    expect(await f.exchange.readMicroBurstSettlement(f.identity)).toBeNull();
  });

  it('includes actual funding without converting unsupported assets', async () => {
    const f = fixture();
    const funding = {
      symbol: 'ETHUSDT',
      incomeType: 'FUNDING_FEE',
      tranId: '10',
      asset: 'USDT',
      income: '-0.125',
      time: 150,
    };
    f.client.futuresIncome.mockResolvedValue([funding]);
    const evidence = await f.exchange.readMicroBurstSettlement(f.identity);
    expect(reconcileMicroBurstSettlement(f.identity, evidence!)).toMatchObject({
      netPnlUsdt: -1.125,
    });
    for (const patch of [
      { asset: 'BNB' },
      { income: undefined },
      { time: 100 },
      { time: 200 },
      { symbol: 'BTCUSDT' },
    ]) {
      f.client.futuresIncome.mockResolvedValue([{ ...funding, ...patch }]);
      expect(await f.exchange.readMicroBurstSettlement(f.identity)).toBeNull();
    }
  });

  it('splits a full page into disjoint inclusive windows', async () => {
    const f = fixture();
    f.client.futuresUserTrades.mockImplementation(async (input) => {
      const r = input as { startTime: number; endTime: number };
      return r.startTime === 100 && r.endTime === 200
        ? Array.from({ length: 1000 }, () => f.trades[0])
        : f.trades.filter((trade) => trade.time >= r.startTime && trade.time <= r.endTime);
    });
    expect(await f.exchange.readMicroBurstSettlement(f.identity)).not.toBeNull();
    expect(f.client.futuresUserTrades.mock.calls.map(([r]) => r)).toEqual([
      { symbol: 'ETHUSDT', startTime: 100, endTime: 200, limit: 1000 },
      { symbol: 'ETHUSDT', startTime: 100, endTime: 150, limit: 1000 },
      { symbol: 'ETHUSDT', startTime: 151, endTime: 200, limit: 1000 },
    ]);
  });

  it('bounds dense pagination and never calls an order mutation', async () => {
    const f = fixture();
    f.client.futuresUserTrades.mockResolvedValue(Array.from({ length: 1000 }, () => f.trades[0]));
    expect(await f.exchange.readMicroBurstSettlement(f.identity)).toBeNull();
    expect(f.client.futuresUserTrades.mock.calls.length).toBeLessThanOrEqual(16);
    expect(f.client.futuresGetOrder).not.toHaveBeenCalled();
  });

  it('rejects partial orders, missing flat evidence and future timestamps', async () => {
    const f = fixture();
    f.client.futuresGetOrder.mockResolvedValueOnce({
      ...f.trades[0],
      status: 'PARTIALLY_FILLED',
      origQty: '2',
      executedQty: '1',
    });
    expect(await f.exchange.readMicroBurstSettlement(f.identity)).toBeNull();
    f.client.futuresPositionRisk.mockResolvedValue([]);
    await expect(f.exchange.readMicroBurstSettlement(f.identity)).rejects.toThrow(
      'POSITION_SNAPSHOT_INCOMPLETE',
    );
    f.identity.closedAtMs = 301;
    expect(await f.exchange.readMicroBurstSettlement(f.identity)).toBeNull();
  });

  it('propagates funding outages rather than declaring zero funding', async () => {
    const f = fixture();
    f.client.futuresIncome.mockRejectedValue(new Error('rate budget exhausted'));
    await expect(f.exchange.readMicroBurstSettlement(f.identity)).rejects.toThrow(
      'rate budget exhausted',
    );
  });
});
