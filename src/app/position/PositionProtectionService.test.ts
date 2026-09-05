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
    flush: vi.fn(async () => undefined),
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
    getMarkPrice: vi.fn(async () => 100),
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
  const wait = vi.fn(async () => undefined);
  const service = new PositionProtectionService({
    exchange: exchange as any,
    logger,
    getRegimeConfig: () => ({ hardStopRoe: -0.2, tpRoe: 0.3 }) as any,
    getImmediateTriggerBufferPct: () => 0.001,
    logTradeEvent,
    microStopConfirmationDelaysMs: [0],
    wait,
  });
  return { service, exchange, logger, logTradeEvent, orders, wait };
}

const position = {
  sideMode: 'BOTH' as const,
  qtyAbs: 2,
  entryPrice: 100,
  leverage: 10,
};

describe('PositionProtectionService', () => {
  it('never interprets undefined position data as confirmed flat', async () => {
    const { service, exchange } = fixture();
    exchange.readActivePosition.mockResolvedValue(undefined as any);
    const store = stateStore({ lastSide: 'LONG' });
    expect((await service.superviseMicroStop('ETHUSDT', store.get(), store)).status).toBe(
      'UNKNOWN',
    );
    expect(await service.reconcileMissingMicroPosition('ETHUSDT', store)).toBe(false);
    expect(store.get().mode).toBe('LONG_RIDE');
    expect(exchange.cancelOrderById).not.toHaveBeenCalled();
  });
  it('persists replacement intent before submission and does not resubmit on a later tick', async () => {
    const { service, exchange } = fixture();
    const store = stateStore({ lastSide: 'LONG', lastStopPrice: 99, lastTradeId: 'trade-1' });
    const events: string[] = [];
    store.flush = vi.fn(async () => {
      events.push('persist');
    });
    exchange.placeStopClose.mockImplementation(async () => {
      events.push('submit');
      expect(store.get().microStopSubmission?.tradeId).toBe('trade-1');
      throw new Error('response lost');
    });
    const first = await service.superviseMicroStop('ETHUSDT', store.get(), store);
    expect(first.status).toBe('UNKNOWN');
    expect(events).toEqual(['persist', 'submit']);
    expect((await service.superviseMicroStop('ETHUSDT', store.get(), store)).status).toBe(
      'CONFIRMATION_PENDING',
    );
    expect(exchange.placeStopClose).toHaveBeenCalledTimes(1);
  });

  it('does not submit a replacement if persisting its intent fails', async () => {
    const { service, exchange } = fixture();
    const store = stateStore({ lastSide: 'LONG', lastStopPrice: 99 });
    store.flush = vi.fn().mockRejectedValue(new Error('disk full'));
    expect((await service.superviseMicroStop('ETHUSDT', store.get(), store)).status).toBe(
      'UNKNOWN',
    );
    expect(exchange.placeStopClose).not.toHaveBeenCalled();
  });

  it('requests recovery after a persisted stop attempt expires without resubmitting', async () => {
    const { service, exchange } = fixture();
    const store = stateStore({
      lastSide: 'LONG',
      lastStopPrice: 99,
      microStopSubmission: { attemptedAt: Date.now() - 60_000, stopPrice: 99 },
    });
    expect((await service.superviseMicroStop('ETHUSDT', store.get(), store)).status).toBe(
      'RECOVERY_REQUIRED',
    );
    expect(exchange.placeStopClose).not.toHaveBeenCalled();
  });

  it('does not use a stop attempt from another trade to order recovery', async () => {
    const { service, exchange } = fixture();
    const store = stateStore({
      lastSide: 'LONG',
      lastTradeId: 'new',
      microStopSubmission: { attemptedAt: 0, stopPrice: 99, tradeId: 'old' },
    });
    expect((await service.superviseMicroStop('ETHUSDT', store.get(), store)).status).toBe(
      'UNKNOWN',
    );
    expect(exchange.placeStopClose).not.toHaveBeenCalled();
  });

  it('reconciles flat independently and preserves entry ambiguity while quarantining accounting', async () => {
    const { service, exchange } = fixture();
    exchange.readActivePosition.mockResolvedValue(null as any);
    exchange.listCloseOrdersForSide
      .mockResolvedValueOnce([
        { orderId: 'bot', owner: 'BOT' } as any,
        { orderId: 'external', owner: 'UNKNOWN' } as any,
      ])
      .mockResolvedValue([{ orderId: 'external', owner: 'UNKNOWN' } as any]);
    const store = stateStore({ lastSide: 'LONG', marketOpenAmbiguous: true, lastTradeId: 't' });
    expect(await service.reconcileMissingMicroPosition('ETHUSDT', store)).toBe(true);
    expect(exchange.readActivePosition).toHaveBeenCalledTimes(3);
    expect(exchange.cancelOrderById).toHaveBeenCalledExactlyOnceWith('ETHUSDT', 'bot');
    expect(store.get()).toMatchObject({
      mode: 'IDLE',
      marketOpenAmbiguous: true,
      microBurstPnlUnverified: true,
      lastTradeId: 't',
    });
    expect(store.flush).toHaveBeenCalledTimes(1);
  });

  it('does not finalize a close when bot-owned close orders survive cancellation', async () => {
    const { service, exchange } = fixture();
    exchange.readActivePosition.mockResolvedValue(null as any);
    exchange.listCloseOrdersForSide.mockResolvedValue([{ orderId: 'bot', owner: 'BOT' } as any]);
    const store = stateStore({ lastSide: 'LONG' });
    await expect(service.reconcileMissingMicroPosition('ETHUSDT', store)).rejects.toThrow(
      'MICRO_BOT_CLOSE_ORDERS_REMAIN',
    );
    expect(store.get().mode).toBe('LONG_RIDE');
  });

  it('does not finalize a close if the position reappears during reconciliation', async () => {
    const { service, exchange } = fixture();
    exchange.readActivePosition
      .mockResolvedValueOnce(null as any)
      .mockResolvedValueOnce(null as any);
    const store = stateStore({ lastSide: 'LONG' });
    expect(await service.reconcileMissingMicroPosition('ETHUSDT', store)).toBe(false);
    expect(store.get().mode).toBe('LONG_RIDE');
  });

  it('restores and confirms the Micro stop without placing a TP', async () => {
    const { service, exchange } = fixture();
    exchange.listCloseOrdersForSide
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { orderId: 'sl', type: 'STOP_MARKET', stopPrice: 99, closePosition: true } as any,
      ]);
    await service.ensureMicroStop('ETHUSDT', {
      mode: 'LONG_RIDE',
      lastSide: 'LONG',
      lastStopPrice: 99,
      microBurstStructuralStopPrice: 98,
    });
    expect(exchange.placeStopClose).toHaveBeenCalledWith('ETHUSDT', 'LONG', 99);
    expect(exchange.placeTpClose).not.toHaveBeenCalled();
  });

  it('does not confuse an acknowledged Micro stop with a confirmed stop', async () => {
    const { service, exchange } = fixture();
    exchange.listCloseOrdersForSide.mockResolvedValue([]);
    await expect(
      service.ensureMicroStop('ETHUSDT', {
        mode: 'SHORT_RIDE',
        lastSide: 'SHORT',
        lastStopPrice: 101,
      }),
    ).rejects.toThrow('MICRO_STOP_CONFIRMATION_PENDING');
    expect(exchange.placeTpClose).not.toHaveBeenCalled();
  });

  it('classifies exhausted close-order read failures as UNKNOWN without placing a stop', async () => {
    const { service, exchange } = fixture();
    exchange.listCloseOrdersForSide.mockRejectedValue(new Error('temporary timeout'));

    await expect(
      service.superviseMicroStop('ETHUSDT', {
        mode: 'LONG_RIDE',
        lastSide: 'LONG',
        lastStopPrice: 99,
      }),
    ).resolves.toEqual({ status: 'UNKNOWN', reason: 'CLOSE_ORDER_READ_FAILED' });
    expect(exchange.placeStopClose).not.toHaveBeenCalled();
    expect(exchange.listCloseOrdersForSide).toHaveBeenCalledTimes(3);
  });

  it('recovers a transient read failure when a later read confirms protection', async () => {
    const { service, exchange, wait } = fixture();
    exchange.listCloseOrdersForSide
      .mockRejectedValueOnce(new Error('temporary timeout'))
      .mockResolvedValueOnce([
        { orderId: 'sl', type: 'STOP_MARKET', stopPrice: 99, closePosition: true } as any,
      ]);
    await expect(
      service.superviseMicroStop('ETHUSDT', {
        mode: 'LONG_RIDE',
        lastSide: 'LONG',
        lastStopPrice: 99,
      }),
    ).resolves.toEqual({ status: 'PROTECTED' });
    expect(exchange.listCloseOrdersForSide).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledTimes(1);
    expect(exchange.placeStopClose).not.toHaveBeenCalled();
  });

  it('does not treat empty reads after a timeout as proof that placing another stop is safe', async () => {
    const { service, exchange } = fixture();
    exchange.listCloseOrdersForSide
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValue([]);
    await expect(
      service.superviseMicroStop('ETHUSDT', {
        mode: 'LONG_RIDE',
        lastSide: 'LONG',
        lastStopPrice: 99,
      }),
    ).resolves.toEqual({ status: 'UNKNOWN', reason: 'CLOSE_ORDER_READ_FAILED' });
    expect(exchange.listCloseOrdersForSide).toHaveBeenCalledTimes(3);
    expect(exchange.placeStopClose).not.toHaveBeenCalled();
  });

  it('retries bounded confirmation when the exchange lists the stop late', async () => {
    const { service, exchange, wait } = fixture();
    exchange.listCloseOrdersForSide
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { orderId: 'late-sl', type: 'STOP_MARKET', stopPrice: 99, closePosition: true } as any,
      ]);

    await service.ensureMicroStop('ETHUSDT', {
      mode: 'LONG_RIDE',
      lastSide: 'LONG',
      lastStopPrice: 99,
    });

    expect(exchange.placeStopClose).toHaveBeenCalledWith('ETHUSDT', 'LONG', 99);
    expect(exchange.listCloseOrdersForSide).toHaveBeenCalledTimes(5);
    expect(wait).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledWith(0);
  });

  it('does not count an explicitly unknown-owner stop as Micro protection', async () => {
    const { service, exchange } = fixture();
    exchange.listCloseOrdersForSide.mockResolvedValue([
      {
        orderId: 'foreign-sl',
        type: 'STOP_MARKET',
        stopPrice: 99,
        closePosition: true,
        owner: 'UNKNOWN',
      } as any,
    ]);

    await expect(
      service.ensureMicroStop('ETHUSDT', {
        mode: 'LONG_RIDE',
        lastSide: 'LONG',
        lastStopPrice: 99,
      }),
    ).rejects.toThrow('MICRO_STOP_CONFIRMATION_PENDING');
    expect(exchange.placeStopClose).toHaveBeenCalledWith('ETHUSDT', 'LONG', 99);
    expect(exchange.placeTpClose).not.toHaveBeenCalled();
  });

  it('does not place orders if the Micro position read fails', async () => {
    const { service, exchange } = fixture();
    exchange.readActivePosition.mockRejectedValue(new Error('timeout'));
    await expect(
      service.ensureMicroStop('ETHUSDT', {
        mode: 'LONG_RIDE',
        lastSide: 'LONG',
        lastStopPrice: 99,
      }),
    ).rejects.toThrow('timeout');
    expect(exchange.placeStopClose).not.toHaveBeenCalled();
  });

  it('rejects a Micro stop that would trigger immediately for either side', async () => {
    const { service, exchange } = fixture();
    await expect(
      service.ensureMicroStop('ETHUSDT', {
        mode: 'LONG_RIDE',
        lastSide: 'LONG',
        lastStopPrice: 100,
      }),
    ).rejects.toThrow('MICRO_STOP_IMMEDIATE_TRIGGER_RISK');
    expect(exchange.placeStopClose).not.toHaveBeenCalled();

    exchange.getMarkPrice.mockResolvedValue(100);
    await expect(
      service.ensureMicroStop('ETHUSDT', {
        mode: 'SHORT_RIDE',
        lastSide: 'SHORT',
        lastStopPrice: 100,
      }),
    ).rejects.toThrow('MICRO_STOP_IMMEDIATE_TRIGGER_RISK');
    expect(exchange.placeStopClose).not.toHaveBeenCalled();
  });

  it('fails closed when the current mark price is unavailable', async () => {
    const { service, exchange } = fixture();
    exchange.getMarkPrice.mockResolvedValue(Number.NaN);

    await expect(
      service.ensureMicroStop('ETHUSDT', {
        mode: 'LONG_RIDE',
        lastSide: 'LONG',
        lastStopPrice: 99,
      }),
    ).rejects.toThrow('MICRO_STOP_IMMEDIATE_TRIGGER_RISK');
    expect(exchange.placeStopClose).not.toHaveBeenCalled();
  });

  it('rounds the submitted Micro stop to tickSize before final geometry validation', async () => {
    const { service, exchange } = fixture();
    exchange.getSymbolFilters.mockResolvedValue({
      tickSize: 0.05,
      stepSize: 0.001,
      pricePrecision: 2,
      qtyPrecision: 3,
      minNotional: 5,
    });
    exchange.listCloseOrdersForSide
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { orderId: 'sl', type: 'STOP_MARKET', stopPrice: 99.05, closePosition: true } as any,
      ]);

    await service.ensureMicroStop('ETHUSDT', {
      mode: 'LONG_RIDE',
      lastSide: 'LONG',
      lastStopPrice: 99.03,
    });

    expect(exchange.placeStopClose).toHaveBeenCalledWith('ETHUSDT', 'LONG', 99.05);
    expect(service.roundStopPriceForSide('LONG', 99.03, await exchange.getSymbolFilters())).toBe(
      99.05,
    );
  });

  it('rejects a stop that becomes immediately triggerable after tick rounding', async () => {
    const { service, exchange } = fixture();
    exchange.getSymbolFilters.mockResolvedValue({
      tickSize: 0.05,
      stepSize: 0.001,
      pricePrecision: 2,
      qtyPrecision: 3,
      minNotional: 5,
    });

    await expect(
      service.superviseMicroStop('ETHUSDT', {
        mode: 'LONG_RIDE',
        lastSide: 'LONG',
        lastStopPrice: 99.89,
      }),
    ).resolves.toMatchObject({
      status: 'RECOVERY_REQUIRED',
      reason: 'MICRO_STOP_INVALID_AFTER_ROUNDING',
    });
    expect(exchange.placeStopClose).not.toHaveBeenCalled();
  });

  it('keeps an existing full-position Micro stop and ignores unrelated TP', async () => {
    const { service, exchange } = fixture();
    exchange.listCloseOrdersForSide.mockResolvedValue([
      { orderId: 'sl', type: 'STOP_MARKET', stopPrice: 99, closePosition: true } as any,
    ]);
    await service.ensureMicroStop('ETHUSDT', { mode: 'LONG_RIDE', lastSide: 'LONG' });
    expect(exchange.placeStopClose).not.toHaveBeenCalled();
    expect(exchange.placeTpClose).not.toHaveBeenCalled();
  });

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
