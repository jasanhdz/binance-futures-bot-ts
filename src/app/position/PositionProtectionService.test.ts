import { describe, expect, it, vi } from 'vitest';
import { BotState } from '../../core/types';
import { StateStore } from '../ports/StateStore';
import { PositionProtectionService } from './PositionProtectionService';

function stateStore(initial: Partial<BotState> = {}): StateStore {
  let state = { mode: 'LONG_RIDE', ...initial } as BotState;
  return {
    get: () => state,
    set: (patch) => {
      state = { ...state, ...patch };
      return state;
    },
    reset: () => {
      state = { mode: 'IDLE' } as BotState;
    },
  };
}

function fixture() {
  const orders: Array<{ orderId: string; type: string; stopPrice: number }> = [];
  const exchange = {
    listCloseOrdersForSide: vi.fn(async () => [...orders]),
    getSymbolFilters: vi.fn(async () => ({
      tickSize: 0.01,
      stepSize: 0.001,
      pricePrecision: 2,
      qtyPrecision: 3,
      minNotional: 5,
    })),
    placeStopClose: vi.fn(async (_symbol, _side, stopPrice) => {
      orders.push({ orderId: `sl-${orders.length}`, type: 'STOP_MARKET', stopPrice });
      return true;
    }),
    placeTpClose: vi.fn(async (_symbol, _side, stopPrice) => {
      orders.push({
        orderId: `tp-${orders.length}`,
        type: 'TAKE_PROFIT_MARKET',
        stopPrice,
      });
      return true;
    }),
    cancelOrderById: vi.fn(async (_symbol, orderId) => {
      const index = orders.findIndex((order) => order.orderId === orderId);
      if (index >= 0) orders.splice(index, 1);
    }),
    readActivePosition: vi.fn(async () => ({
      sideMode: 'BOTH',
      qtyAbs: 2,
      entryPrice: 100,
      leverage: 10,
    })),
  };
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const logTradeEvent = vi.fn(async () => undefined);
  const service = new PositionProtectionService({
    exchange: exchange as any,
    logger,
    getRegimeConfig: () => ({ hardStopRoe: -0.2, tpRoe: 0.3 }) as any,
    getImmediateTriggerBufferPct: () => 0.001,
    logTradeEvent,
  });
  return { service, exchange, logger, logTradeEvent, orders };
}

const position = {
  sideMode: 'BOTH' as const,
  qtyAbs: 2,
  entryPrice: 100,
  leverage: 10,
};

describe('PositionProtectionService', () => {
  it('owns deterministic quantity, price, bracket and stop calculations', () => {
    const { service } = fixture();
    const filters = {
      tickSize: 0.01,
      stepSize: 0.001,
      pricePrecision: 2,
      qtyPrecision: 3,
      minNotional: 5,
    };
    expect(service.roundQuantity(1.2349, filters)).toBe(1.234);
    expect(service.roundPrice(100.126, filters)).toBe(100.13);
    expect(service.bracketPrice('LONG', 100, -0.2, 10, 'STOP')).toBe(98);
    expect(service.bracketPrice('SHORT', 100, 0.3, 10, 'TP')).toBe(97);
    expect(service.isBetterStop('LONG', 99, 98)).toBe(true);
    expect(service.isBetterStop('SHORT', 101, 102)).toBe(true);
  });

  it('recreates only missing brackets and preserves the best remembered stop', async () => {
    const { service, exchange, logTradeEvent, orders } = fixture();
    orders.push({ orderId: 'tp-existing', type: 'TAKE_PROFIT_MARKET', stopPrice: 103 });
    const botState = {
      mode: 'LONG_RIDE',
      lastTradeId: 'trade-1',
      lastStopPrice: 98.5,
      highestRatchetStop: 99,
    } as BotState;

    await expect(
      service.ensureBrackets('BTCUSDT', 'LONG', 100, 10, position, botState),
    ).resolves.toEqual({ stopPrice: 99, takeProfitPrice: 103 });
    expect(exchange.placeStopClose).toHaveBeenCalledWith('BTCUSDT', 'LONG', 99);
    expect(exchange.placeTpClose).not.toHaveBeenCalled();
    expect(logTradeEvent).toHaveBeenCalledWith(
      'BTCUSDT',
      'BRACKET_MISSING',
      expect.objectContaining({ reason: 'SL_MISSING' }),
    );
  });

  it('places the replacement stop before cancelling the previous quantity-bound stop', async () => {
    const { service, exchange, orders } = fixture();
    orders.push(
      { orderId: 'old-sl', type: 'STOP_MARKET', stopPrice: 98 },
      { orderId: 'tp', type: 'TAKE_PROFIT_MARKET', stopPrice: 105 },
    );

    const result = await service.moveCloseStop({
      symbol: 'BTCUSDT',
      side: 'LONG',
      tradeId: 'trade-1',
      entryPrice: 100,
      markPrice: 105,
      leverage: 10,
      quantity: 2,
      position,
      newStopPrice: 101,
      currentRoe: 0.5,
      peakRoe: 0.6,
      reason: 'MOVE_SL_BE',
    });

    expect(result).toMatchObject({ moved: true, oldStopPrice: 98, newStopPrice: 101 });
    expect(exchange.placeStopClose).toHaveBeenCalledWith('BTCUSDT', 'LONG', 101, 2);
    expect(exchange.placeStopClose.mock.invocationCallOrder[0]).toBeLessThan(
      exchange.cancelOrderById.mock.invocationCallOrder[0],
    );
  });

  it('restores a close-position stop when its replacement cannot be placed', async () => {
    const { service, exchange, orders } = fixture();
    orders.push(
      { orderId: 'old-sl', type: 'STOP_MARKET', stopPrice: 98 },
      { orderId: 'tp', type: 'TAKE_PROFIT_MARKET', stopPrice: 105 },
    );
    exchange.placeStopClose
      .mockRejectedValueOnce(new Error('replacement failed'))
      .mockImplementationOnce(async (_symbol, _side, stopPrice) => {
        orders.push({ orderId: 'restored-sl', type: 'STOP_MARKET', stopPrice });
        return true;
      });

    const result = await service.moveCloseStop({
      symbol: 'BTCUSDT',
      side: 'LONG',
      entryPrice: 100,
      markPrice: 105,
      leverage: 10,
      quantity: 2,
      position,
      newStopPrice: 101,
      currentRoe: 0.5,
      peakRoe: 0.6,
      reason: 'PROTECT_PROFIT',
      useClosePosition: true,
    });

    expect(result).toMatchObject({ moved: false, reason: 'exchange_error' });
    expect(exchange.placeStopClose).toHaveBeenNthCalledWith(2, 'BTCUSDT', 'LONG', 98);
  });

  it('taints a managed position when its exchange quantity changes externally', async () => {
    const { service } = fixture();
    const symbolState = stateStore({ lastEntryQty: 1 });

    await expect(
      service.reconcilePositionSize({
        symbol: 'BTCUSDT',
        side: 'LONG',
        leverage: 10,
        position: { ...position, qtyAbs: 1.5 },
        botState: symbolState.get(),
        symbolState,
      }),
    ).resolves.toEqual({ changed: true });
    expect(symbolState.get()).toMatchObject({
      ownershipStatus: 'TAINTED',
      eligibleForBotMetrics: false,
      metricsExclusionReason: 'EXTERNAL_QUANTITY_INCREASE',
      lastEntryQty: 1.5,
    });
  });
});
