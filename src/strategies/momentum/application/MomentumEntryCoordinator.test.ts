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
});
