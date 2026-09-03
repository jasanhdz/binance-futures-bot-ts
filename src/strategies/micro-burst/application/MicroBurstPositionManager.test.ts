import { describe, expect, it, vi } from 'vitest';
import { StrategyPositionLifecycleCore } from '../../../app/position/StrategyPositionLifecycleCore';
import {
  MicroBurstPositionManagementContext,
  MicroBurstPositionManager,
} from './MicroBurstPositionManager';
import { BotState } from '../../../core/types';
import { createMicroBurstV1Identity } from '../domain/MicroBurstIdentity';
import { MicroBurstExitContext } from '../domain/MicroBurstTypes';

function botState(overrides: Partial<BotState> = {}): BotState {
  return { mode: 'IDLE', ...overrides };
}

function lifecycle() {
  return {
    manage: vi.fn().mockResolvedValue(undefined),
  } as unknown as StrategyPositionLifecycleCore;
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

function managementContext(
  exitOverrides: Partial<MicroBurstExitContext> = {},
): MicroBurstPositionManagementContext {
  return {
    symbol: 'ETHUSDT',
    botState: botState({ lastTradeId: 'MICRO-BURST-V1-123' }),
    symbolState: {} as MicroBurstPositionManagementContext['symbolState'],
    strategyMode: 'OFF',
    side: 'LONG',
    exitContext: exitContext(exitOverrides),
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

  it('uses the shared intelligent exit engine without granting LIVE mutation authority', async () => {
    const core = lifecycle();
    const manager = new MicroBurstPositionManager(core);
    const contextAt = (observedAtMs: number) =>
      managementContext({
        currentPrice: 100.5,
        peakPrice: 100.7,
        troughPrice: 100,
        structuralInvalidationPrice: 99,
        destinationPrice: 102,
        currentStopPrice: 100.16,
        timeInTradeMs: observedAtMs,
        observedAtMs,
        currentBookPressure: {
          spreadBps: 1,
          signedTopOfBookImbalance: -0.3,
          topOfBookImbalance: 0.3,
          imbalanceSlope: -0.08,
          temporalAbsorptionDetected: false,
          temporalSweepDetected: false,
          staticBidConcentration: false,
          staticAskConcentration: false,
          anomalyFlag: false,
          status: 'HEALTHY',
        },
        marketEvidence: {
          observedAtMs,
          shortHorizonReturnBps: -2,
          mediumHorizonReturnBps: 2,
          priceSampleCount: 30,
          buyTakerVolume: 20,
          sellTakerVolume: 80,
          takerTradeCount: 100,
          takerFlowWindowComplete: true,
          takerFlowGapFree: true,
        },
      });

    expect(await manager.manage(createMicroBurstV1Identity(), contextAt(20_000))).toMatchObject({
      decision: 'HOLD',
      diagnostics: { actionApplied: false },
    });
    expect(await manager.manage(createMicroBurstV1Identity(), contextAt(21_000))).toMatchObject({
      decision: 'HOLD',
      diagnostics: { actionApplied: false },
    });
    expect(await manager.manage(createMicroBurstV1Identity(), contextAt(23_000))).toMatchObject({
      decision: 'CLOSE_MARKET',
      reason: 'INTELLIGENT_EXIT',
      diagnostics: {
        actionApplied: false,
        authorityReason: 'MICRO_BURST_V1_OFF',
      },
    });
    expect(core.manage).not.toHaveBeenCalled();
  });

  it('applies a confirmed LIVE close through the injected execution boundary', async () => {
    const close = vi.fn(async () => true);
    const moveStop = vi.fn(async () => true);
    const manager = new MicroBurstPositionManager(
      lifecycle(),
      undefined,
      { close, moveStop },
      true,
    );
    const context = {
      ...managementContext(),
      strategyMode: 'LIVE' as const,
      symbolState: {
        set: vi.fn(),
      } as unknown as MicroBurstPositionManagementContext['symbolState'],
    };

    const result = await manager.manage(createMicroBurstV1Identity(), context);

    expect(result).toMatchObject({
      decision: 'CLOSE_MARKET',
      reason: 'TARGET',
      diagnostics: {
        actionApplied: true,
        authorityReason: 'MICRO_BURST_V1_LIVE',
      },
    });
    expect(close).toHaveBeenCalledOnce();
    expect(moveStop).not.toHaveBeenCalled();
  });

  it('applies the cost-aware profit lock through the LIVE boundary without trailing', async () => {
    const close = vi.fn(async () => true);
    const moveStop = vi.fn(async () => true);
    const manager = new MicroBurstPositionManager(
      lifecycle(),
      undefined,
      { close, moveStop },
      true,
    );
    const context = {
      ...managementContext({
        currentPrice: 100.9,
        peakPrice: 101,
        troughPrice: 100,
        destinationPrice: 102,
      }),
      strategyMode: 'LIVE' as const,
      symbolState: {
        set: vi.fn(),
      } as unknown as MicroBurstPositionManagementContext['symbolState'],
    };

    const result = await manager.manage(createMicroBurstV1Identity(), context);

    expect(result).toMatchObject({
      decision: 'MOVE_STOP',
      reason: 'PROFIT_LOCK',
      diagnostics: { actionApplied: true, authorityReason: 'MICRO_BURST_V1_LIVE' },
    });
    expect(moveStop).toHaveBeenCalledOnce();
    const moveStopCall = (moveStop as any).mock.calls[0];
    expect(moveStopCall[0]).toBe(context);
    expect(moveStopCall[1].requestedStopPrice).toBeCloseTo(100.16, 10);
    expect(close).not.toHaveBeenCalled();
  });

  it('returns the LIVE decision but does not mutate when candidate authority is disabled', async () => {
    const close = vi.fn(async () => true);
    const moveStop = vi.fn(async () => true);
    const manager = new MicroBurstPositionManager(lifecycle(), undefined, { close, moveStop });
    const context = {
      ...managementContext(),
      strategyMode: 'LIVE' as const,
      symbolState: {
        set: vi.fn(),
      } as unknown as MicroBurstPositionManagementContext['symbolState'],
    };

    expect(await manager.manage(createMicroBurstV1Identity(), context)).toMatchObject({
      decision: 'CLOSE_MARKET',
      reason: 'TARGET',
      diagnostics: {
        actionApplied: false,
        authorityReason: 'LIVE_AUTHORITY_DISABLED_OR_EXECUTION_PORT_MISSING',
      },
    });
    expect(close).not.toHaveBeenCalled();
    expect(moveStop).not.toHaveBeenCalled();
  });

  it('restores valid persisted hysteresis and ignores malformed state', async () => {
    const firstSet = vi.fn();
    const firstManager = new MicroBurstPositionManager(lifecycle());
    const riskContext = managementContext({
      currentPrice: 100.5,
      peakPrice: 100.7,
      troughPrice: 100,
      structuralInvalidationPrice: 99,
      destinationPrice: 102,
      currentStopPrice: 100.16,
      timeInTradeMs: 20_000,
      observedAtMs: 20_000,
      currentBookPressure: {
        spreadBps: 1,
        signedTopOfBookImbalance: -0.3,
        topOfBookImbalance: 0.3,
        imbalanceSlope: -0.08,
        temporalAbsorptionDetected: false,
        temporalSweepDetected: false,
        staticBidConcentration: false,
        staticAskConcentration: false,
        anomalyFlag: false,
        status: 'HEALTHY',
      },
      marketEvidence: {
        observedAtMs: 20_000,
        shortHorizonReturnBps: -2,
        mediumHorizonReturnBps: 2,
        priceSampleCount: 30,
        buyTakerVolume: 20,
        sellTakerVolume: 80,
        takerTradeCount: 100,
        takerFlowWindowComplete: true,
        takerFlowGapFree: true,
      },
    });
    riskContext.symbolState = { set: firstSet } as unknown as typeof riskContext.symbolState;
    await firstManager.manage(createMicroBurstV1Identity(), riskContext);
    const persisted = firstSet.mock.calls[firstSet.mock.calls.length - 1]?.[0]?.microBurstExitState;

    const restoredManager = new MicroBurstPositionManager(lifecycle());
    const restoredContext = managementContext({
      ...riskContext.exitContext,
      timeInTradeMs: 21_000,
      observedAtMs: 21_000,
      marketEvidence: { ...riskContext.exitContext.marketEvidence!, observedAtMs: 21_000 },
    });
    restoredContext.botState.microBurstExitState = persisted;
    restoredContext.symbolState = { set: vi.fn() } as unknown as typeof restoredContext.symbolState;
    await restoredManager.manage(createMicroBurstV1Identity(), restoredContext);
    const restoredCalls = (restoredContext.symbolState.set as any).mock.calls;
    expect(restoredCalls[restoredCalls.length - 1][0].microBurstExitState).toMatchObject({
      consecutiveRiskObservations: 2,
      riskStartedAtMs: 20_000,
    });

    const malformedManager = new MicroBurstPositionManager(lifecycle());
    const malformedContext = managementContext({
      ...riskContext.exitContext,
      timeInTradeMs: 21_000,
      observedAtMs: 21_000,
    });
    malformedContext.botState.microBurstExitState = {
      schemaVersion: 1,
      phase: 'EXIT_CONFIRMED',
      riskStartedAtMs: 20_000,
      lastObservedAtMs: 20_000,
      consecutiveRiskObservations: 2,
      evidenceFamilies: ['TIME_DECAY'],
      confirmedDecision: { action: 'HOLD', reason: 'HOLD', diagnostics: {} },
    };
    malformedContext.symbolState = {
      set: vi.fn(),
    } as unknown as typeof malformedContext.symbolState;
    await malformedManager.manage(createMicroBurstV1Identity(), malformedContext);
    const malformedCalls = (malformedContext.symbolState.set as any).mock.calls;
    expect(malformedCalls[malformedCalls.length - 1][0].microBurstExitState).toMatchObject({
      consecutiveRiskObservations: 1,
      riskStartedAtMs: 21_000,
    });
  });
});
