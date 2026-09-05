import { describe, expect, it, vi } from 'vitest';
import { TradingService } from './TradingService';

describe('TradingService shared safety contracts', () => {
  it('propagates unknown portfolio exposure instead of returning zero', async () => {
    const service = Object.create(TradingService.prototype) as any;
    service.getLiveAegisSymbols = () => ['ETHUSDT'];
    service.deps = {
      exchange: { readActivePosition: vi.fn().mockRejectedValue(new Error('timeout')) },
    };
    await expect(service.readAegisPortfolioExposure()).rejects.toThrow('timeout');
  });

  it('does not admit Aegis/Momentum while the shared entry reservation is held', async () => {
    const service = Object.create(TradingService.prototype) as any;
    service.entryInFlight = true;
    service.entryInFlightSymbols = new Set();
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
      ensureMicroStop: vi.fn(async () => {
        order.push('stop');
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
});
