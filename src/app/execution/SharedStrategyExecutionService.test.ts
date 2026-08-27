import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Exchange } from '../ports/Exchange';
import { StrategyExecutionIntent } from '../../domain/strategy/StrategyExecution';
import { SharedStrategyExecutionService } from './SharedStrategyExecutionService';

const identity = {
  strategyId: 'AEGIS_TURBO' as const,
  strategyVersion: 'migration-v1',
  freezeState: 'DRAFT' as const,
  codeCommitSha: 'abc123',
};

function intent(overrides: Partial<StrategyExecutionIntent> = {}): StrategyExecutionIntent {
  return {
    identity,
    tradeId: 'AEGIS-ETHUSDT-1',
    symbol: 'ETHUSDT',
    side: 'LONG',
    requestedAt: 1000,
    leverage: 20,
    positionFraction: 0.1,
    metadata: {},
    protection: {
      requireStop: false,
      requireTakeProfit: false,
      closeIfProtectionFails: false,
    },
    ...overrides,
  };
}

function exchangeMock(): Exchange {
  return {
    setLeverage: vi.fn(),
    ensureMarginType: vi.fn(),
    getUSDTBalance: vi.fn().mockResolvedValue(100),
    getUSDTAccountSnapshot: vi
      .fn()
      .mockResolvedValue({ walletBalance: 100, availableBalance: 100 }),
    getMarkPrice: vi.fn().mockResolvedValue(100),
    getSymbolFilters: vi.fn().mockResolvedValue({
      tickSize: 0.01,
      stepSize: 0.001,
      pricePrecision: 2,
      qtyPrecision: 3,
      minNotional: 5,
    }),
    marketOpen: vi.fn().mockResolvedValue({ avgPrice: 100, orderId: 'order-1' }),
    readMarketOpenByClientOrderId: vi.fn().mockResolvedValue(null),
    readActivePosition: vi.fn().mockResolvedValue({
      sideMode: 'LONG',
      qtyAbs: 2,
      entryPrice: 100,
      leverage: 20,
      isolatedMargin: 10,
    }),
    placeStopClose: vi.fn().mockResolvedValue(true),
    placeTpClose: vi.fn().mockResolvedValue(true),
    listCloseOrdersForSide: vi.fn().mockResolvedValue([
      { orderId: 'sl', type: 'STOP_MARKET', stopPrice: 99 },
      { orderId: 'tp', type: 'TAKE_PROFIT_MARKET', stopPrice: 102 },
    ]),
    closeSideMarketSafe: vi.fn(),
    getServerTime: vi.fn().mockResolvedValue(2000),
  } as unknown as Exchange;
}

describe('SharedStrategyExecutionService protection policy', () => {
  let exchange: Exchange;
  let service: SharedStrategyExecutionService;

  beforeEach(() => {
    exchange = exchangeMock();
    service = new SharedStrategyExecutionService(
      exchange,
      {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
      {
        feeBufferPct: 0,
        confirmationAttempts: 1,
        confirmationDelaysMs: [0],
        maxMarketOpenAttempts: 2,
      },
    );
  });

  it('opens without validating or placing protection that the intent does not use', async () => {
    const result = await service.execute(intent());

    expect(result.status).toBe('OPENED');
    expect(exchange.placeStopClose).not.toHaveBeenCalled();
    expect(exchange.placeTpClose).not.toHaveBeenCalled();
    expect(exchange.listCloseOrdersForSide).not.toHaveBeenCalled();
  });

  it('uses a reconciled market fill after a lost open response without resubmitting', async () => {
    vi.mocked(exchange.marketOpen).mockRejectedValueOnce(new Error('request timed out'));
    vi.mocked(exchange.readMarketOpenByClientOrderId).mockResolvedValueOnce({
      avgPrice: 101,
      orderId: 'reconciled-order',
    });

    const result = await service.execute(intent());

    expect(result).toMatchObject({ status: 'OPENED', orderId: 'reconciled-order', entryPrice: 100 });
    expect(exchange.marketOpen).toHaveBeenCalledTimes(1);
    expect(exchange.readMarketOpenByClientOrderId).toHaveBeenCalledWith(
      'ETHUSDT',
      expect.stringMatching(/^se_[a-f0-9]{33}$/),
    );
  });

  it('does not retry an ambiguous open error when reconciliation finds no order', async () => {
    vi.mocked(exchange.marketOpen).mockRejectedValueOnce(new Error('request timed out'));

    const result = await service.execute(intent());

    expect(result).toMatchObject({ status: 'FAILED', reason: 'EXCHANGE_REJECTED' });
    expect(exchange.readMarketOpenByClientOrderId).toHaveBeenCalledTimes(1);
    expect(exchange.marketOpen).toHaveBeenCalledTimes(1);
  });

  it('reduces and safely retries only a definite size rejection after absent reconciliation', async () => {
    vi.mocked(exchange.marketOpen)
      .mockRejectedValueOnce({ code: -2019, message: 'Margin is insufficient' })
      .mockResolvedValueOnce({ avgPrice: 100, orderId: 'order-2' });

    const result = await service.execute(intent());

    expect(result).toMatchObject({ status: 'OPENED', orderId: 'order-2' });
    expect(exchange.readMarketOpenByClientOrderId).toHaveBeenCalledTimes(1);
    expect(exchange.marketOpen).toHaveBeenNthCalledWith(
      1,
      'ETHUSDT',
      'LONG',
      2,
      expect.stringMatching(/^se_[a-f0-9]{33}$/),
    );
    expect(exchange.marketOpen).toHaveBeenNthCalledWith(
      2,
      'ETHUSDT',
      'LONG',
      1.8,
      expect.stringMatching(/^se_[a-f0-9]{33}$/),
    );
    expect(vi.mocked(exchange.marketOpen).mock.calls[0]?.[3]).toBe(
      vi.mocked(exchange.marketOpen).mock.calls[1]?.[3],
    );
  });

  it('preserves the existing ROE stop calculation and placement path', async () => {
    const result = await service.execute(
      intent({
        stopRoe: -0.2,
        protection: {
          requireStop: true,
          requireTakeProfit: false,
          closeIfProtectionFails: true,
        },
      }),
    );

    expect(result.status).toBe('OPENED');
    expect(exchange.placeStopClose).toHaveBeenCalledWith('ETHUSDT', 'LONG', 99);
    expect(exchange.placeTpClose).not.toHaveBeenCalled();
    expect(result.metadata).toMatchObject({
      stopSource: 'ROE',
      stopPrice: 99,
      effectiveStopPrice: 99,
    });
  });

  it('rejects a missing required field before mutating the exchange', async () => {
    const result = await service.execute(
      intent({
        protection: {
          requireStop: true,
          requireTakeProfit: false,
          closeIfProtectionFails: true,
        },
      }),
    );

    expect(result).toMatchObject({ status: 'DENIED', reason: 'INVALID_SIZE' });
    expect(exchange.setLeverage).not.toHaveBeenCalled();
    expect(exchange.marketOpen).not.toHaveBeenCalled();
  });

  it('validates optional protection when a strategy supplies it', async () => {
    const result = await service.execute(intent({ takeProfitRoe: -0.1 }));

    expect(result).toMatchObject({ status: 'DENIED', reason: 'INVALID_SIZE' });
    expect(exchange.marketOpen).not.toHaveBeenCalled();
  });

  it('closes an opened position when mandatory protection cannot be verified', async () => {
    vi.mocked(exchange.listCloseOrdersForSide).mockResolvedValue([]);
    const result = await service.execute(
      intent({
        stopRoe: -0.2,
        protection: {
          requireStop: true,
          requireTakeProfit: false,
          closeIfProtectionFails: true,
        },
      }),
    );

    expect(result).toMatchObject({
      status: 'FAILED',
      reason: 'BRACKETS_FAILED',
      metadata: {
        failureStage: 'PROTECTION',
        positionStillOpen: false,
        quantity: 2,
        sideMode: 'LONG',
        orderId: 'order-1',
        entryPrice: 100,
      },
    });
    expect(exchange.closeSideMarketSafe).toHaveBeenCalledWith(
      'ETHUSDT',
      'LONG',
      2,
      'LONG',
      'SHARED_EXECUTION_PROTECTION_VERIFY_FAILED',
    );
  });

  it('reports recovery data without closing when fail-close is intentionally disabled', async () => {
    vi.mocked(exchange.listCloseOrdersForSide).mockResolvedValue([]);
    const result = await service.execute(
      intent({
        stopRoe: -0.2,
        protection: {
          requireStop: true,
          requireTakeProfit: false,
          closeIfProtectionFails: false,
        },
      }),
    );

    expect(result).toMatchObject({
      status: 'FAILED',
      reason: 'BRACKETS_FAILED',
      metadata: {
        failureStage: 'PROTECTION',
        positionStillOpen: true,
        quantity: 2,
        sideMode: 'LONG',
        orderId: 'order-1',
        entryPrice: 100,
      },
    });
    expect(exchange.closeSideMarketSafe).not.toHaveBeenCalled();
  });

  it('attempts protection emergency close only once when that close fails', async () => {
    vi.mocked(exchange.listCloseOrdersForSide).mockResolvedValue([]);
    vi.mocked(exchange.closeSideMarketSafe).mockRejectedValue(new Error('protection close failed'));
    const result = await service.execute(
      intent({
        stopRoe: -0.2,
        protection: {
          requireStop: true,
          requireTakeProfit: false,
          closeIfProtectionFails: true,
        },
      }),
    );

    expect(result).toMatchObject({
      status: 'FAILED',
      reason: 'BRACKETS_FAILED',
      metadata: {
        failureStage: 'PROTECTION',
        emergencyCloseError: 'Error: protection close failed',
        positionStillOpen: true,
      },
    });
    expect(exchange.closeSideMarketSafe).toHaveBeenCalledTimes(1);
  });

  it('attempts confirmation emergency close only once when that close fails', async () => {
    vi.mocked(exchange.readActivePosition).mockResolvedValueOnce(null).mockResolvedValueOnce({
      sideMode: 'LONG',
      qtyAbs: 2,
      entryPrice: 100,
      leverage: 20,
      isolatedMargin: 10,
    });
    vi.mocked(exchange.closeSideMarketSafe).mockRejectedValue(
      new Error('confirmation close failed'),
    );

    const result = await service.execute(intent());

    expect(result).toMatchObject({
      status: 'FAILED',
      reason: 'POSITION_CONFIRMATION_FAILED',
      metadata: {
        failureStage: 'POSITION_CONFIRMATION',
        emergencyCloseError: 'Error: confirmation close failed',
        positionStillOpen: true,
        quantity: 2,
        sideMode: 'LONG',
        orderId: 'order-1',
        entryPrice: 100,
      },
    });
    expect(exchange.closeSideMarketSafe).toHaveBeenCalledTimes(1);
  });

  it('places an exact rounded structural stop for LONG', async () => {
    vi.mocked(exchange.listCloseOrdersForSide).mockResolvedValue([
      { orderId: 'sl', type: 'STOP_MARKET', stopPrice: 99.8 },
    ]);
    const result = await service.execute(
      intent({
        structuralStopPrice: 99.804,
        protection: { requireStop: true, requireTakeProfit: false, closeIfProtectionFails: true },
      }),
    );

    expect(result.status).toBe('OPENED');
    expect(exchange.placeStopClose).toHaveBeenCalledWith('ETHUSDT', 'LONG', 99.8);
    expect(result.metadata).toMatchObject({
      stopSource: 'STRUCTURAL_PRICE',
      requestedStructuralStopPrice: 99.804,
      stopPrice: 99.8,
      effectiveStopPrice: 99.8,
      hasStop: true,
    });
  });

  it('places an exact rounded structural stop for SHORT', async () => {
    vi.mocked(exchange.readActivePosition).mockResolvedValue({
      sideMode: 'SHORT',
      qtyAbs: 2,
      entryPrice: 100,
      leverage: 20,
      isolatedMargin: 10,
    });
    vi.mocked(exchange.listCloseOrdersForSide).mockResolvedValue([
      { orderId: 'sl', type: 'STOP_MARKET', stopPrice: 100.2 },
    ]);
    const result = await service.execute(
      intent({
        side: 'SHORT',
        structuralStopPrice: 100.204,
        protection: { requireStop: true, requireTakeProfit: false, closeIfProtectionFails: true },
      }),
    );

    expect(result.status).toBe('OPENED');
    expect(exchange.placeStopClose).toHaveBeenCalledWith('ETHUSDT', 'SHORT', 100.2);
  });

  it.each([
    ['LONG', 100],
    ['LONG', 100.2],
    ['SHORT', 100],
    ['SHORT', 99.8],
  ] as const)(
    'fails closed when %s structural stop geometry is invalid at %s',
    async (side, stop) => {
      vi.mocked(exchange.readActivePosition).mockResolvedValue({
        sideMode: side,
        qtyAbs: 2,
        entryPrice: 100,
        leverage: 20,
        isolatedMargin: 10,
      });
      const result = await service.execute(
        intent({
          side,
          structuralStopPrice: stop,
          protection: { requireStop: true, requireTakeProfit: false, closeIfProtectionFails: true },
        }),
      );

      expect(result).toMatchObject({
        status: 'FAILED',
        reason: 'BRACKETS_FAILED',
        metadata: {
          failureStage: 'PROTECTION',
          reasonDetail: 'invalid_structural_stop_geometry',
          error: 'Error: INVALID_STRUCTURAL_STOP_GEOMETRY',
          positionStillOpen: false,
        },
      });
      expect(exchange.placeStopClose).not.toHaveBeenCalled();
      expect(exchange.closeSideMarketSafe).toHaveBeenCalledTimes(1);
    },
  );

  it.each([NaN, Number.POSITIVE_INFINITY, 0, -1])(
    'denies invalid structural stop %s before opening the market position',
    async (structuralStopPrice) => {
      const result = await service.execute(
        intent({
          structuralStopPrice,
          protection: { requireStop: true, requireTakeProfit: false, closeIfProtectionFails: true },
        }),
      );

      expect(result).toMatchObject({
        status: 'DENIED',
        reason: 'INVALID_SIZE',
        metadata: { reasonDetail: 'invalid_structural_stop_price' },
      });
      expect(exchange.setLeverage).not.toHaveBeenCalled();
      expect(exchange.marketOpen).not.toHaveBeenCalled();
    },
  );

  it('denies an ambiguous stop specification before exchange mutation', async () => {
    const result = await service.execute(
      intent({
        stopRoe: -0.2,
        structuralStopPrice: 99.8,
        protection: { requireStop: true, requireTakeProfit: false, closeIfProtectionFails: true },
      }),
    );

    expect(result).toMatchObject({
      status: 'DENIED',
      reason: 'INVALID_SIZE',
      metadata: { reasonDetail: 'ambiguous_stop_specification' },
    });
    expect(exchange.setLeverage).not.toHaveBeenCalled();
  });

  it('reports a missing stop specification distinctly', async () => {
    const result = await service.execute(
      intent({
        protection: { requireStop: true, requireTakeProfit: false, closeIfProtectionFails: true },
      }),
    );

    expect(result).toMatchObject({
      status: 'DENIED',
      reason: 'INVALID_SIZE',
      metadata: { reasonDetail: 'missing_stop_specification' },
    });
  });

  it('fails closed when tick rounding moves a structural stop onto the fill', async () => {
    vi.mocked(exchange.getSymbolFilters).mockResolvedValue({
      tickSize: 1,
      stepSize: 0.001,
      pricePrecision: 0,
      qtyPrecision: 3,
      minNotional: 5,
    });
    const result = await service.execute(
      intent({
        structuralStopPrice: 99.6,
        protection: { requireStop: true, requireTakeProfit: false, closeIfProtectionFails: true },
      }),
    );

    expect(result).toMatchObject({
      status: 'FAILED',
      reason: 'BRACKETS_FAILED',
      metadata: {
        requestedStructuralStopPrice: 99.6,
        effectiveStopPrice: 100,
        reasonDetail: 'invalid_structural_stop_geometry',
        positionStillOpen: false,
      },
    });
    expect(exchange.placeStopClose).not.toHaveBeenCalled();
  });

  it.each(['returns false', 'throws'] as const)(
    'emergency-closes when structural stop placement %s',
    async (failureMode) => {
      if (failureMode === 'throws') {
        vi.mocked(exchange.placeStopClose).mockRejectedValue(new Error('stop placement failed'));
      } else {
        vi.mocked(exchange.placeStopClose).mockResolvedValue(false);
      }
      const result = await service.execute(
        intent({
          structuralStopPrice: 99.8,
          protection: { requireStop: true, requireTakeProfit: false, closeIfProtectionFails: true },
        }),
      );

      expect(result).toMatchObject({
        status: 'FAILED',
        reason: 'BRACKETS_FAILED',
        metadata: {
          stopSource: 'STRUCTURAL_PRICE',
          effectiveStopPrice: 99.8,
          positionStillOpen: false,
        },
      });
      expect(exchange.closeSideMarketSafe).toHaveBeenCalledTimes(1);
    },
  );

  it('emergency-closes when structural stop verification has no exact STOP', async () => {
    vi.mocked(exchange.listCloseOrdersForSide).mockResolvedValue([
      { orderId: 'wrong-sl', type: 'STOP_MARKET', stopPrice: 99.79 },
    ]);
    const result = await service.execute(
      intent({
        structuralStopPrice: 99.8,
        protection: { requireStop: true, requireTakeProfit: false, closeIfProtectionFails: true },
      }),
    );

    expect(result).toMatchObject({
      status: 'FAILED',
      reason: 'BRACKETS_FAILED',
      metadata: {
        hasStop: false,
        stopOk: true,
        reasonDetail: 'structural_stop_verification_failed',
        positionStillOpen: false,
      },
    });
    expect(exchange.closeSideMarketSafe).toHaveBeenCalledTimes(1);
  });
});
