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
    getUSDTAccountSnapshot: vi.fn().mockResolvedValue({ walletBalance: 100, availableBalance: 100 }),
    getMarkPrice: vi.fn().mockResolvedValue(100),
    getSymbolFilters: vi.fn().mockResolvedValue({
      tickSize: 0.01,
      stepSize: 0.001,
      pricePrecision: 2,
      qtyPrecision: 3,
      minNotional: 5,
    }),
    marketOpen: vi.fn().mockResolvedValue({ avgPrice: 100, orderId: 'order-1' }),
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
    service = new SharedStrategyExecutionService(exchange, {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }, {
      feeBufferPct: 0,
      confirmationAttempts: 1,
      confirmationDelaysMs: [0],
      maxMarketOpenAttempts: 2,
    });
  });

  it('opens without validating or placing protection that the intent does not use', async () => {
    const result = await service.execute(intent());

    expect(result.status).toBe('OPENED');
    expect(exchange.placeStopClose).not.toHaveBeenCalled();
    expect(exchange.placeTpClose).not.toHaveBeenCalled();
    expect(exchange.listCloseOrdersForSide).not.toHaveBeenCalled();
  });

  it('requires only the protection selected by the intent', async () => {
    const result = await service.execute(intent({
      stopRoe: -0.2,
      protection: {
        requireStop: true,
        requireTakeProfit: false,
        closeIfProtectionFails: true,
      },
    }));

    expect(result.status).toBe('OPENED');
    expect(exchange.placeStopClose).toHaveBeenCalledWith('ETHUSDT', 'LONG', 99);
    expect(exchange.placeTpClose).not.toHaveBeenCalled();
  });

  it('rejects a missing required field before mutating the exchange', async () => {
    const result = await service.execute(intent({
      protection: {
        requireStop: true,
        requireTakeProfit: false,
        closeIfProtectionFails: true,
      },
    }));

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
    const result = await service.execute(intent({
      stopRoe: -0.2,
      protection: {
        requireStop: true,
        requireTakeProfit: false,
        closeIfProtectionFails: true,
      },
    }));

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
    const result = await service.execute(intent({
      stopRoe: -0.2,
      protection: {
        requireStop: true,
        requireTakeProfit: false,
        closeIfProtectionFails: false,
      },
    }));

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
    const result = await service.execute(intent({
      stopRoe: -0.2,
      protection: {
        requireStop: true,
        requireTakeProfit: false,
        closeIfProtectionFails: true,
      },
    }));

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
    vi.mocked(exchange.readActivePosition)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        sideMode: 'LONG',
        qtyAbs: 2,
        entryPrice: 100,
        leverage: 20,
        isolatedMargin: 10,
      });
    vi.mocked(exchange.closeSideMarketSafe).mockRejectedValue(new Error('confirmation close failed'));

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
});
