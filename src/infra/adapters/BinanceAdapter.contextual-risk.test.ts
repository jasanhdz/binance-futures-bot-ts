import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../config/environment', () => ({
  CONFIG: {
    API_KEY: 'synthetic-key',
    API_SECRET: 'synthetic-secret',
    HTTP_FUTURES: 'https://exchange.invalid',
    IS_TESTNET: true,
  },
}));
import { BinanceExchange } from './BinanceAdapter';
import { sizeMicroBurstLiveEntry } from '../../strategies/micro-burst/application/MicroBurstLiveSizing';
import { createMicroBurstTradePolicy } from '../../strategies/micro-burst/domain/MicroBurstTradePolicy';
import { createMicroBurstContextualIdentity } from '../../strategies/micro-burst/domain/MicroBurstIdentity';
import { createMicroBurstExecutionIntent } from '../../strategies/micro-burst/domain/MicroBurstExecutionIntentFactory';
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fixture(side: 'LONG' | 'SHORT' = 'LONG', leverage = 20) {
  const now = Date.now();
  const account = {
    canTrade: true,
    multiAssetsMargin: false,
    positions: [
      {
        symbol: 'ETHUSDT',
        positionAmt: '0',
        positionSide: 'BOTH',
        isolated: true,
        leverage: String(leverage),
      },
    ],
    assets: [{ asset: 'USDT', walletBalance: '25', availableBalance: '25' }],
  };
  const info = {
    symbols: [
      {
        symbol: 'ETHUSDT',
        status: 'TRADING',
        quoteAsset: 'USDT',
        marginAsset: 'USDT',
        liquidationFee: '0.005',
      },
    ],
  };
  const tiers = [
    {
      symbol: 'ETHUSDT',
      brackets: [
        {
          notionalFloor: 0,
          notionalCap: 50_000,
          initialLeverage: 50,
          maintMarginRatio: 0.004,
          cum: 0,
        },
      ],
    },
  ];
  const cli = {
    futuresAccountInfo: vi.fn(async () => account),
    futuresPositionMode: vi.fn(async () => ({ dualSidePosition: false })),
    futuresLeverageBracket: vi.fn(async () => tiers),
  };
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ symbol: 'ETHUSDT', takerCommissionRate: '0.0005' }), {
        status: 200,
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const exchange = Object.create(BinanceExchange.prototype) as BinanceExchange;
  Object.assign(exchange, {
    cli,
    enqueue: async (work: () => unknown) => work(),
    getServerTime: async () => now,
    getExchangeInfoSnapshot: async () => info,
  });
  const identity = createMicroBurstContextualIdentity('a'.repeat(64), 'b'.repeat(40));
  const policy = createMicroBurstTradePolicy(identity, {
    sizingMode: 'MARGIN_FRACTION',
    marginFraction: 0.9,
    mediumLeverage: 20,
    highLeverage: 30,
    maxConsecutiveNetLosses: 3,
    resetMode: 'SIGNED_OPERATOR',
    feeReserveBps: 14,
    stopStressBps: 20,
  });
  const intent = createMicroBurstExecutionIntent({
    identity,
    contextualPolicy: policy,
    symbol: 'ETHUSDT',
    side,
    tradeId: 'trade',
    episodeId: 'episode',
    leverage,
    positionFraction: 0.9,
    requestedAt: now,
    signalSnapshotAtMs: now,
    stopInvalidationPrice: side === 'LONG' ? 99.5 : 100.5,
    targetPrice: side === 'LONG' ? 102 : 98,
  });
  const filters = {
    tickSize: 0.01,
    pricePrecision: 2,
    stepSize: 0.001,
    qtyPrecision: 3,
    minNotional: 5,
  };
  const book = {
    status: 'HEALTHY' as const,
    observedAtMs: now,
    askDepth: [{ price: 100.01, qty: 100 }],
    bidDepth: [{ price: 99.99, qty: 100 }],
  };
  return {
    exchange,
    account,
    info,
    cli,
    tiers,
    fetchMock,
    intent,
    now,
    book,
    size: () =>
      sizeMicroBurstLiveEntry(
        exchange,
        intent,
        filters,
        () => book,
        () => now,
      ),
  };
}

describe('Binance contextual risk evidence and production sizing', () => {
  it.each([
    'complete',
    'missing-trade-time',
    'missing-funding-time',
    'unsafe-funding-id',
    'negative-quantity',
    'full-page',
  ])('validates exit cost coverage: %s', async (fault) => {
    const f = fixture();
    const trade: any = {
      id: 1,
      orderId: 42,
      symbol: 'ETHUSDT',
      side: 'BUY',
      positionSide: 'BOTH',
      commissionAsset: 'USDT',
      commission: '0.05',
      realizedPnl: '0',
      price: '100',
      qty: '1',
      time: f.now - 100,
    };
    const income: any = {
      tranId: '2',
      symbol: 'ETHUSDT',
      incomeType: 'FUNDING_FEE',
      asset: 'USDT',
      income: '-0.01',
      time: f.now - 50,
    };
    if (fault === 'missing-trade-time') delete trade.time;
    if (fault === 'missing-funding-time') delete income.time;
    if (fault === 'unsafe-funding-id') income.tranId = Number.MAX_SAFE_INTEGER + 1;
    if (fault === 'negative-quantity') trade.qty = '-1';
    Object.assign(f.cli, {
      futuresUserTrades: async () => (fault === 'full-page' ? Array(1000).fill(trade) : [trade]),
      futuresIncome: async () => [income],
    });
    const costs = await f.exchange.readMicroBurstExitCosts('ETHUSDT', '42', 1, f.now - 200);
    if (fault === 'complete') expect(costs?.residualCostBps).toBeCloseTo(11);
    else expect(costs).toBeNull();
  });
  it.each([
    ['LONG', 20],
    ['SHORT', 20],
    ['LONG', 30],
    ['SHORT', 30],
  ] as const)(
    'sizes %s %sx from signed fee reads and actual isolated tiers',
    async (side, leverage) => {
      const f = fixture(side, leverage);
      const sized = await f.size();
      expect(sized.valid).toBe(true);
      expect(sized.marginRequired + (sized.notional * 14) / 10_000).toBeLessThanOrEqual(22.5);
      expect(f.fetchMock.mock.calls.length).toBe(1);
      const url = (f.fetchMock.mock.calls as unknown[][])[0][0];
      expect(url).toMatch(/^https:\/\/exchange.invalid\/fapi\/v1\/commissionRate\?/);
    },
  );

  it.each([
    'exposure',
    'cross',
    'hedge',
    'missing-wallet',
    'missing-liquidation-fee',
    'tier-gap',
    'missing-cumulative',
  ])('fails closed on %s', async (fault) => {
    const f = fixture();
    if (fault === 'exposure') f.account.positions[0].positionAmt = '1';
    if (fault === 'cross') f.account.positions[0].isolated = false;
    if (fault === 'hedge') f.cli.futuresPositionMode.mockResolvedValue({ dualSidePosition: true });
    if (fault === 'missing-wallet') f.account.assets[0].availableBalance = '';
    if (fault === 'missing-liquidation-fee') delete (f.info.symbols[0] as any).liquidationFee;
    if (fault === 'tier-gap') f.tiers[0].brackets[0].notionalFloor = 10;
    if (fault === 'missing-cumulative') delete (f.tiers[0].brackets[0] as any).cum;
    expect((await f.size()).valid).toBe(false);
  });

  it('rejects unknown fees and fees above the explicit reserve, rather than assuming zero', async () => {
    const f = fixture();
    for (const rate of [undefined, null, '', '0.002']) {
      f.fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ symbol: 'ETHUSDT', takerCommissionRate: rate })),
      );
      expect((await f.size()).valid).toBe(false);
    }
  });

  it('rejects liquidation inside the stressed structural stop and insufficient depth/min-notional', async () => {
    const f = fixture('LONG', 30);
    f.tiers[0].brackets[0].maintMarginRatio = 0.028;
    expect((await f.size()).valid).toBe(false);
    f.tiers[0].brackets[0].maintMarginRatio = 0.004;
    f.book.askDepth[0].qty = 0.001;
    expect((await f.size()).valid).toBe(false);
  });
});
