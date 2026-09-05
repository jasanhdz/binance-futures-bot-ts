import { describe, expect, it, vi } from 'vitest';
import { TradingService } from './TradingService';

describe('TradingService shared safety contracts', () => {
  it.each(['processSymbol', 'openMicroBurstLivePosition', 'lookForEntryWithLock'])(
    'drains %s before flushing state and rejects new work during shutdown',
    async (method) => {
      const service = Object.create(TradingService.prototype) as any;
      let finish!: () => void;
      const pending = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const events: string[] = [];
      const worker = vi.fn(async () => {
        await pending;
        events.push('state-updated');
        return true;
      });
      service[`${method}Task`] = worker;
      service.strategyRuntimeCoordinator = { stop: vi.fn(async () => undefined) };
      service.symbolStateStores = new Map();
      const flush = vi.fn(async () => {
        events.push('flush');
      });
      service.deps = { state: { flush }, logger: { info: vi.fn() } };
      const drain = vi.fn(async () => undefined);
      service.decisionJsonlSink = { drain };
      service.marketSnapshotEvidenceSink = { drain };
      service.telemetryJsonlSink = { drain };
      const argument = method === 'openMicroBurstLivePosition' ? { symbol: 'ETHUSDT' } : 'ETHUSDT';
      const operation = service[method](argument);
      await Promise.resolve();
      const stopping = service.stop();
      expect(service.stop()).toBe(stopping);
      await Promise.resolve();
      expect(flush).not.toHaveBeenCalled();
      await service[method](argument);
      expect(worker).toHaveBeenCalledTimes(1);
      finish();
      await operation;
      await stopping;
      expect(events).toEqual(['state-updated', 'flush']);
      expect(service.activeRuntimeTasks.size).toBe(0);
      expect(drain).toHaveBeenCalledTimes(3);
    },
  );

  it('removes failed runtime tasks while preserving rejection for the caller', async () => {
    const service = Object.create(TradingService.prototype) as any;
    await expect(
      service.trackRuntimeTask(async () => {
        throw new Error('failed');
      }),
    ).rejects.toThrow('failed');
    expect(service.activeRuntimeTasks.size).toBe(0);
  });

  it('propagates unknown portfolio exposure instead of returning zero', async () => {
    const service = Object.create(TradingService.prototype) as any;
    service.getLiveAegisSymbols = () => ['ETHUSDT'];
    service.deps = {
      exchange: { readActivePosition: vi.fn().mockRejectedValue(new Error('timeout')) },
    };
    await expect(service.readAegisPortfolioExposure()).rejects.toThrow('timeout');
  });

  it('does not downgrade an invalid mark price to entry price', async () => {
    const service = Object.create(TradingService.prototype) as any;
    service.getLiveAegisSymbols = () => ['ETHUSDT'];
    service.deps = {
      exchange: {
        readActivePosition: vi.fn().mockResolvedValue({
          sideMode: 'BOTH',
          qtyAbs: 1,
          entryPrice: 100,
          leverage: 10,
        }),
        getMarkPrice: vi.fn().mockResolvedValue(Number.NaN),
      },
    };

    await expect(service.readAegisPortfolioExposure()).rejects.toThrow(
      'EXPOSURE_INVALID_MARK_PRICE:ETHUSDT',
    );
  });

  it('rejects non-finite position quantities before counting exposure', async () => {
    const service = Object.create(TradingService.prototype) as any;
    service.getLiveAegisSymbols = () => ['ETHUSDT'];
    service.deps = {
      exchange: {
        readActivePosition: vi.fn().mockResolvedValue({
          sideMode: 'BOTH',
          qtyAbs: Number.NaN,
          entryPrice: 100,
          leverage: 10,
        }),
      },
    };

    await expect(service.readAegisPortfolioExposure()).rejects.toThrow(
      'EXPOSURE_INVALID_POSITION:ETHUSDT:LONG',
    );
  });

  it('counts a BOTH position once when both side probes return it', async () => {
    const service = Object.create(TradingService.prototype) as any;
    service.getLiveAegisSymbols = () => ['ETHUSDT'];
    service.deps = {
      exchange: {
        readActivePosition: vi.fn().mockResolvedValue({
          sideMode: 'BOTH',
          qtyAbs: 2,
          entryPrice: 100,
          leverage: 10,
        }),
        getMarkPrice: vi.fn().mockResolvedValue(105),
      },
    };

    await expect(service.readAegisPortfolioExposure()).resolves.toEqual({
      openPositions: 1,
      longPositions: 1,
      shortPositions: 0,
      marginUsed: 20,
      notional: 210,
    });
  });

  it('distinguishes absent margin from invalid isolated margin', async () => {
    const service = Object.create(TradingService.prototype) as any;
    service.getLiveAegisSymbols = () => ['ETHUSDT'];
    service.deps = {
      exchange: {
        readActivePosition: vi.fn().mockResolvedValue({
          sideMode: 'BOTH',
          qtyAbs: 2,
          entryPrice: 100,
          leverage: 10,
          isolatedMargin: Number.NaN,
        }),
        getMarkPrice: vi.fn().mockResolvedValue(100),
      },
    };

    await expect(service.readAegisPortfolioExposure()).rejects.toThrow(
      'EXPOSURE_INVALID_ISOLATED_MARGIN:ETHUSDT:LONG',
    );
  });

  it('does not admit Aegis/Momentum while the shared entry reservation is held', async () => {
    const service = Object.create(TradingService.prototype) as any;
    service.entryInFlight = true;
    service.entryInFlightSymbols = new Set();
    service.lookForEntry = vi.fn();
    await service.lookForEntryWithLock('ETHUSDT');
    expect(service.lookForEntry).not.toHaveBeenCalled();
  });

  it('does not admit new entries after shutdown begins', async () => {
    const service = Object.create(TradingService.prototype) as any;
    service.acceptingEntries = false;
    service.lookForEntry = vi.fn();

    await service.lookForEntryWithLock('ETHUSDT');

    expect(service.lookForEntry).not.toHaveBeenCalled();
  });

  it('releases the shared reservation after a failed strategy evaluation', async () => {
    const service = Object.create(TradingService.prototype) as any;
    service.entryInFlight = false;
    service.entryInFlightSymbols = new Set();
    service.lookForEntry = vi.fn().mockRejectedValue(new Error('evaluation failed'));
    await expect(service.lookForEntryWithLock('ETHUSDT')).rejects.toThrow('evaluation failed');
    expect(service.entryInFlight).toBe(false);
    expect(service.entryInFlightSymbols.size).toBe(0);
  });

  it('supervises Micro protection before requesting strategy market context', async () => {
    const service = Object.create(TradingService.prototype) as any;
    const order: string[] = [];
    service.strategyIdentityForState = () => ({ strategyId: 'MICRO_BURST_V1' });
    service.positionProtection = {
      superviseMicroStop: vi.fn(async () => {
        order.push('stop');
        return { status: 'PROTECTED' };
      }),
    };
    service.strategyRuntimeCoordinator = {
      readMicroBurstExitMarket: vi.fn(() => {
        order.push('market');
        return null;
      }),
    };
    service.deps = { logger: { warn: vi.fn() } };
    const state = { mode: 'LONG_RIDE', positionOwner: 'BOT', lastStrategy: 'MICRO_BURST_V1' };
    await service.managePositionByOwner('ETHUSDT', state, { get: () => state, set: vi.fn() });
    expect(order).toEqual(['stop', 'market']);
  });

  it('does not emergency-close when Micro order visibility is temporarily unknown', async () => {
    const service = Object.create(TradingService.prototype) as any;
    service.strategyIdentityForState = () => ({ strategyId: 'MICRO_BURST_V1' });
    service.positionProtection = {
      superviseMicroStop: vi.fn().mockResolvedValue({
        status: 'UNKNOWN',
        reason: 'CLOSE_ORDER_READ_FAILED',
      }),
    };
    service.deps = {
      logger: { warn: vi.fn(), error: vi.fn() },
      exchange: { closeSideMarketSafe: vi.fn() },
    };
    service.notifyError = vi.fn().mockResolvedValue(undefined);
    const state = { mode: 'LONG_RIDE', lastStrategy: 'MICRO_BURST_V1' };
    const store = { set: vi.fn() };

    await service.managePositionByOwner('ETHUSDT', state, store);

    expect(service.deps.exchange.closeSideMarketSafe).not.toHaveBeenCalled();
    expect(store.set).toHaveBeenCalledWith({ marketOpenAmbiguous: true, bracketsAttached: false });
  });

  it('attempts a fresh-quantity emergency close when Micro protection fails', async () => {
    const service = Object.create(TradingService.prototype) as any;
    const position = { sideMode: 'BOTH', qtyAbs: 2 };
    service.strategyIdentityForState = () => ({ strategyId: 'MICRO_BURST_V1' });
    service.positionProtection = {
      superviseMicroStop: vi.fn().mockResolvedValue({
        status: 'RECOVERY_REQUIRED',
        reason: 'stop unavailable',
      }),
    };
    service.strategyRuntimeCoordinator = { readMicroBurstExitMarket: vi.fn() };
    service.deps = {
      logger: { warn: vi.fn(), error: vi.fn() },
      notifier: { sendAlert: vi.fn().mockResolvedValue(undefined) },
      exchange: {
        readActivePosition: vi.fn().mockResolvedValueOnce(position).mockResolvedValueOnce(null),
        closeSideMarketSafe: vi.fn().mockResolvedValue(undefined),
        listCloseOrdersForSide: vi.fn().mockResolvedValue([
          { orderId: 'micro-stop', owner: 'BOT' },
          { orderId: 'foreign-stop', owner: 'UNKNOWN' },
        ]),
        cancelOrderById: vi.fn().mockResolvedValue(undefined),
      },
    };
    service.notifyError = vi.fn().mockResolvedValue(undefined);
    const state = {
      mode: 'LONG_RIDE',
      positionOwner: 'BOT',
      lastStrategy: 'MICRO_BURST_V1',
      lastSide: 'LONG',
      lastTradeId: 'micro-1',
    };
    const store = { get: () => state, set: vi.fn() };

    await service.managePositionByOwner('ETHUSDT', state, store);

    expect(service.deps.exchange.closeSideMarketSafe).toHaveBeenCalledWith(
      'ETHUSDT',
      'LONG',
      2,
      'BOTH',
      'MICRO_STOP_RECOVERY_FAILED',
    );
    expect(service.deps.exchange.cancelOrderById).toHaveBeenCalledWith('ETHUSDT', 'micro-stop');
    expect(service.deps.exchange.cancelOrderById).not.toHaveBeenCalledWith(
      'ETHUSDT',
      'foreign-stop',
    );
    expect(store.set).toHaveBeenCalledWith(
      expect.objectContaining({
        marketOpenAmbiguous: false,
        microBurstPnlUnverified: true,
      }),
    );
  });

  it('keeps Micro quarantined when the emergency close fails', async () => {
    const service = Object.create(TradingService.prototype) as any;
    service.strategyIdentityForState = () => ({ strategyId: 'MICRO_BURST_V1' });
    service.positionProtection = {
      superviseMicroStop: vi.fn().mockResolvedValue({
        status: 'RECOVERY_REQUIRED',
        reason: 'stop unavailable',
      }),
    };
    service.strategyRuntimeCoordinator = { readMicroBurstExitMarket: vi.fn() };
    service.deps = {
      logger: { warn: vi.fn(), error: vi.fn() },
      exchange: {
        readActivePosition: vi.fn().mockResolvedValue({
          sideMode: 'SHORT',
          qtyAbs: 1.5,
        }),
        closeSideMarketSafe: vi.fn().mockRejectedValue(new Error('close unavailable')),
      },
    };
    service.notifyError = vi.fn().mockResolvedValue(undefined);
    const state = {
      mode: 'SHORT_RIDE',
      positionOwner: 'BOT',
      lastStrategy: 'MICRO_BURST_V1',
      lastSide: 'SHORT',
    };
    const store = { get: () => state, set: vi.fn() };

    await service.managePositionByOwner('ETHUSDT', state, store);

    expect(store.set).toHaveBeenCalledWith({ marketOpenAmbiguous: true, bracketsAttached: false });
    expect(store.set).not.toHaveBeenCalledWith(
      expect.objectContaining({ marketOpenAmbiguous: false }),
    );
  });

  it('keeps Micro ambiguous when emergency close leaves exposure open', async () => {
    const service = Object.create(TradingService.prototype) as any;
    service.strategyIdentityForState = () => ({ strategyId: 'MICRO_BURST_V1' });
    service.positionProtection = {
      superviseMicroStop: vi.fn().mockResolvedValue({
        status: 'RECOVERY_REQUIRED',
        reason: 'stop unavailable',
      }),
    };
    service.deps = {
      logger: { warn: vi.fn(), error: vi.fn() },
      exchange: {
        readActivePosition: vi.fn().mockResolvedValue({ sideMode: 'BOTH', qtyAbs: 1 }),
        closeSideMarketSafe: vi.fn().mockResolvedValue(undefined),
      },
    };
    service.notifyError = vi.fn().mockResolvedValue(undefined);
    const state = {
      mode: 'LONG_RIDE',
      lastStrategy: 'MICRO_BURST_V1',
      lastSide: 'LONG',
    };
    const store = { set: vi.fn() };

    await service.managePositionByOwner('ETHUSDT', state, store);

    expect(store.set).toHaveBeenCalledWith({ marketOpenAmbiguous: true, bracketsAttached: false });
    expect(store.set).not.toHaveBeenCalledWith(
      expect.objectContaining({ microBurstPnlUnverified: true }),
    );
  });
});
