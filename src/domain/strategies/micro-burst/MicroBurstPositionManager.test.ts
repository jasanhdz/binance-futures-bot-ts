import { describe, expect, it, vi } from 'vitest';
import { createMicroBurstV1Identity } from './MicroBurstIdentity';
import { MicroBurstPositionManager } from '../../../app/strategy/MicroBurstPositionManager';
import { StrategyPositionLifecycleCore } from '../../../app/position/StrategyPositionLifecycleCore';

function makeMockLifecycle() {
  return {
    manage: vi.fn().mockResolvedValue(undefined),
  } as unknown as StrategyPositionLifecycleCore;
}

describe('MicroBurstPositionManager', () => {
  it('has correct strategyId', () => {
    const manager = new MicroBurstPositionManager(makeMockLifecycle());
    expect(manager.strategyId).toBe('MICRO_BURST_V1');
  });

  it('throws on ownership mismatch', async () => {
    const manager = new MicroBurstPositionManager(makeMockLifecycle());
    const wrongIdentity = {
      strategyId: 'AEGIS_TURBO' as const,
      strategyVersion: '1',
      freezeState: 'DRAFT' as const,
      codeCommitSha: 'abc',
    };
    await expect(
      manager.manage(wrongIdentity, { symbol: 'ETHUSDT', botState: {}, symbolState: {} as any }),
    ).rejects.toThrow('POSITION_MANAGER_OWNERSHIP_MISMATCH');
  });

  it('delegates to lifecycle core with MICRO_BURST policy', async () => {
    const lifecycle = makeMockLifecycle();
    const manager = new MicroBurstPositionManager(lifecycle);
    const identity = createMicroBurstV1Identity();
    const context = { symbol: 'ETHUSDT', botState: { lastTradeId: 'MICRO-BURST-V1-123' }, symbolState: {} as any };

    const result = await manager.manage(identity, context);

    expect(result.tradeId).toBe('MICRO-BURST-V1-123');
    expect(result.decision).toBe('NO_ACTION');
    expect(result.diagnostics.lifecycleOwner).toBe('MICRO_BURST_V1');
  });

  it('generates fallback tradeId when none exists', async () => {
    const lifecycle = makeMockLifecycle();
    const manager = new MicroBurstPositionManager(lifecycle);
    const identity = createMicroBurstV1Identity();
    const context = { symbol: 'ETHUSDT', botState: {}, symbolState: {} as any };

    const result = await manager.manage(identity, context);

    expect(result.tradeId).toBe('MICRO-BURST-LEGACY-ETHUSDT');
  });
});
