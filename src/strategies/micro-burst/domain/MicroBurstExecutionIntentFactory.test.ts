import { describe, expect, it, vi } from 'vitest';
import { SharedStrategyExecutionService } from '../../../app/execution/SharedStrategyExecutionService';
import { Exchange } from '../../../app/ports/Exchange';
import { createMicroBurstExecutionIntent } from './MicroBurstExecutionIntentFactory';
import { createMicroBurstIdentity } from './MicroBurstIdentity';
import { MicroBurstApprovedEntry } from './MicroBurstTypes';

describe('MicroBurstExecutionIntentFactory determinism', () => {
  it('produces the same intent for the same approved entry without reading a clock', () => {
    const approved: MicroBurstApprovedEntry = {
      identity: createMicroBurstIdentity('deadbeef'),
      symbol: 'ETHUSDT',
      side: 'LONG',
      leverage: 20,
      positionFraction: 0.05,
      stopInvalidationPrice: 99.8,
      targetPrice: 102,
      requestedAt: 1_700_000_000_000,
      tradeId: 'MICRO-BURST-ETHUSDT-1700000000000',
      signalId: 'signal-1',
    };
    const first = createMicroBurstExecutionIntent(approved);
    const second = createMicroBurstExecutionIntent(approved);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      requestedAt: approved.requestedAt,
      tradeId: approved.tradeId,
      structuralStopPrice: approved.stopInvalidationPrice,
      destinationPrice: approved.targetPrice,
      leverage: approved.leverage,
      positionFraction: approved.positionFraction,
      protection: {
        requireStop: true,
        requireTakeProfit: false,
        closeIfProtectionFails: true,
      },
    });
    expect(first.stopRoe).toBeUndefined();
    expect(first.takeProfitRoe).toBeUndefined();
    expect(first.metadata.leverageTier).toBe('MEDIUM');
    expect(
      createMicroBurstExecutionIntent({ ...approved, leverage: 30 }).metadata.leverageTier,
    ).toBe('HIGH');
  });

  it('rejects a current Micro intent without its bound policy before any protection mutation', async () => {
    const placeStopClose = vi.fn().mockResolvedValue(true);
    const exchange = {
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
      marketOpen: vi.fn().mockResolvedValue({ avgPrice: 100.1, orderId: 'order-1' }),
      readActivePosition: vi.fn().mockResolvedValue({
        sideMode: 'LONG',
        qtyAbs: 1,
        entryPrice: 100.1,
        leverage: 20,
        isolatedMargin: 5,
      }),
      placeStopClose,
      placeTpClose: vi.fn(),
      listCloseOrdersForSide: vi.fn().mockResolvedValue([
        {
          orderId: 'sl',
          type: 'STOP_MARKET',
          stopPrice: 99.8,
          side: 'SELL',
          positionSide: 'LONG',
          workingType: 'MARK_PRICE',
          closePosition: true,
          owner: 'BOT',
        },
      ]),
      closeSideMarketSafe: vi.fn(),
      getServerTime: vi.fn().mockResolvedValue(2_000),
    } as unknown as Exchange;
    const service = new SharedStrategyExecutionService(
      exchange,
      { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      {
        feeBufferPct: 0,
        confirmationAttempts: 1,
        confirmationDelaysMs: [0],
        maxMarketOpenAttempts: 1,
      },
    );
    const executionIntent = createMicroBurstExecutionIntent({
      identity: createMicroBurstIdentity('deadbeef'),
      symbol: 'ETHUSDT',
      side: 'LONG',
      leverage: 20,
      positionFraction: 0.05,
      stopInvalidationPrice: 99.804,
      targetPrice: 102,
      requestedAt: 1_700_000_000_000,
      tradeId: 'MICRO-BURST-ETHUSDT-1700000000000',
      signalId: 'signal-1',
    });

    const result = await service.execute(executionIntent);

    expect(result.status).toBe('DENIED');
    expect(exchange.marketOpen).not.toHaveBeenCalled();
    expect(placeStopClose).not.toHaveBeenCalled();
    expect(exchange.placeTpClose).not.toHaveBeenCalled();
    expect(executionIntent.structuralStopPrice).toBe(99.804);
  });
});
