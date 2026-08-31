import { describe, expect, it, vi } from 'vitest';
import type { StrategyExecutionPort } from '../../../core/strategy/StrategyExecution';
import type { StrategyIdentity } from '../../../core/strategy/StrategyIdentity';
import { AegisExecutionCoordinator } from './AegisExecutionCoordinator';

const identity = {
  strategyId: 'aegis-turbo',
  strategyVersion: 'v1',
  strategyHash: 'strategy-hash',
  configHash: 'config-hash',
  codeCommitSha: 'commit-sha',
  freezeState: 'FROZEN',
} as unknown as StrategyIdentity;

describe('AegisExecutionCoordinator', () => {
  it('creates an Aegis intent and delegates it to shared execution', async () => {
    const result = { status: 'OPENED', entryPrice: 100, quantity: 1 } as any;
    const execute = vi.fn().mockResolvedValue(result);
    const coordinator = new AegisExecutionCoordinator({ execute } as StrategyExecutionPort);

    await expect(
      coordinator.execute({
        identity,
        tradeId: 'trade-1',
        symbol: 'BTCUSDT',
        side: 'LONG',
        requestedAt: 123,
        risk: { leverage: 10, positionFraction: 0.1 },
        protection: {
          stopRoe: -0.02,
          takeProfitRoe: 0.04,
          requireStop: true,
          requireTakeProfit: true,
          closeIfProtectionFails: false,
        },
        provenance: { source: 'aegis_approved_entry' },
      }),
    ).resolves.toBe(result);

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        identity,
        tradeId: 'trade-1',
        symbol: 'BTCUSDT',
        side: 'LONG',
        leverage: 10,
        positionFraction: 0.1,
        stopRoe: -0.02,
        takeProfitRoe: 0.04,
        protection: {
          requireStop: true,
          requireTakeProfit: true,
          closeIfProtectionFails: true,
        },
      }),
    );
  });
});
