import { describe, expect, it, vi } from 'vitest';
import type { AegisMomentumRideRuntimeConfig } from '../../aegis/domain/entry/AegisEntryDecisionTypes';
import {
  MomentumEntryCoordinator,
  type MomentumEntryCoordinatorDeps,
} from './MomentumEntryCoordinator';

describe('MomentumEntryCoordinator', () => {
  it('owns the disabled-strategy boundary without reading market data', async () => {
    const readRuntimeCandles = vi.fn();
    const deps = {
      getConfig: () =>
        ({
          enabled: false,
          standaloneMainReplica: true,
          symbols: {},
        }) as AegisMomentumRideRuntimeConfig,
      readRuntimeCandles,
    } as unknown as MomentumEntryCoordinatorDeps;

    const coordinator = new MomentumEntryCoordinator(deps);

    await expect(coordinator.evaluate('BTCUSDT')).resolves.toBe(false);
    expect(readRuntimeCandles).not.toHaveBeenCalled();
  });

  it('does not read account or exposure state when the pure pattern is blocked', async () => {
    const readRuntimeCandles = vi.fn().mockResolvedValue({
      candles: Array.from({ length: 120 }, (_, index) => ({
        openTime: index * 300_000,
        timestamp: index * 300_000,
        open: 100,
        high: 101,
        low: 99,
        close: 100,
        volume: 100,
        buyVolume: 50,
        closeTime: index * 300_000 + 299_999,
      })),
      status: 'FRESH',
      restFallbackCount: 0,
      usedRestFallback: false,
    });
    const getUSDTBalance = vi.fn();
    const readEntryAccountSnapshot = vi.fn();
    const readPortfolioExposure = vi.fn();
    const deps = {
      getConfig: () =>
        ({
          enabled: true,
          standaloneMainReplica: true,
          symbols: { BTCUSDT: { enabled: true, long: { enabled: true }, short: { enabled: true } } },
        }) as AegisMomentumRideRuntimeConfig,
      readRuntimeCandles,
      getCachedCandles: vi.fn().mockReturnValue([]),
      getRestCandles: vi.fn(),
      isValidCandle: vi.fn().mockReturnValue(true),
      isFiniteNumber: vi.fn().mockImplementation((value: unknown) => typeof value === 'number'),
      getUSDTBalance,
      readEntryAccountSnapshot,
      readPortfolioExposure,
      logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
    } as unknown as MomentumEntryCoordinatorDeps;

    await expect(new MomentumEntryCoordinator(deps).evaluate('BTCUSDT')).resolves.toBe(false);
    expect(getUSDTBalance).not.toHaveBeenCalled();
    expect(readEntryAccountSnapshot).not.toHaveBeenCalled();
    expect(readPortfolioExposure).not.toHaveBeenCalled();
  });
});
