import { describe, expect, it, vi } from 'vitest';
import { StrategyPositionLifecycleCore } from '../../../app/position/StrategyPositionLifecycleCore';
import {
  MicroBurstPositionManagementContext,
  MicroBurstPositionManager,
} from '../../../app/strategy/MicroBurstPositionManager';
import { BotState } from '../../../domain/types';
import { createMicroBurstV1Identity } from './MicroBurstIdentity';
import { MicroBurstExitContext } from './MicroBurstTypes';

function botState(overrides: Partial<BotState> = {}): BotState {
  return { mode: 'IDLE', ...overrides };
}

function lifecycle() {
  return { manage: vi.fn().mockResolvedValue(undefined) } as unknown as StrategyPositionLifecycleCore;
}

function exitContext(overrides: Partial<MicroBurstExitContext> = {}): MicroBurstExitContext {
  return {
    unrealizedRoe: 0,
    priceReturn: 0.02,
    currentPrice: 102,
    entryPrice: 100,
    peakPrice: 102,
    troughPrice: 100,
    structuralInvalidationPrice: 99.8,
    destinationPrice: 102,
    currentStopPrice: null,
    timeInTradeMs: 10_000,
    momentumDecayFlag: false,
    anomalyExitFlag: false,
    currentBookPressure: null,
    currentBtcContext: null,
    leverage: 20,
    ...overrides,
  };
}

function managementContext(): MicroBurstPositionManagementContext {
  return {
    symbol: 'ETHUSDT',
    botState: botState({ lastTradeId: 'MICRO-BURST-V1-123' }),
    symbolState: {} as MicroBurstPositionManagementContext['symbolState'],
    strategyMode: 'OFF',
    side: 'LONG',
    exitContext: exitContext(),
  };
}

describe('MicroBurstPositionManager correctness boundary', () => {
  it('rejects ownership mismatch before lifecycle work', async () => {
    const core = lifecycle();
    const manager = new MicroBurstPositionManager(core);
    await expect(
      manager.manage(
        {
          strategyId: 'AEGIS_TURBO',
          strategyVersion: '1',
          freezeState: 'DRAFT',
          codeCommitSha: 'abc',
        },
        managementContext(),
      ),
    ).rejects.toThrow('POSITION_MANAGER_OWNERSHIP_MISMATCH');
    expect(core.manage).not.toHaveBeenCalled();
  });

  it('evaluates and translates target exit while OFF without applying a mutation', async () => {
    const core = lifecycle();
    const manager = new MicroBurstPositionManager(core);
    const result = await manager.manage(createMicroBurstV1Identity(), managementContext());
    expect(result).toMatchObject({
      tradeId: 'MICRO-BURST-V1-123',
      decision: 'CLOSE_MARKET',
      reason: 'TARGET',
      diagnostics: {
        lifecycleOwner: 'MICRO_BURST_V1',
        strategyMode: 'OFF',
        actionApplied: false,
        authorityReason: 'MICRO_BURST_V1_OFF',
      },
    });
    expect(core.manage).not.toHaveBeenCalled();
  });

  it('fails closed to NO_ACTION when exit context is unavailable', async () => {
    const manager = new MicroBurstPositionManager(lifecycle());
    const result = await manager.manage(createMicroBurstV1Identity(), {
      symbol: 'ETHUSDT',
      botState: botState(),
      symbolState: {} as MicroBurstPositionManagementContext['symbolState'],
    });
    expect(result).toMatchObject({
      decision: 'NO_ACTION',
      diagnostics: { actionApplied: false, authorityReason: 'EXIT_CONTEXT_UNAVAILABLE' },
    });
  });
});
