import { describe, expect, it } from 'vitest';
import {
  advanceMicroBurstOfflineExit,
  evaluateMicroBurstOfflineExit,
  initialMicroBurstOfflineExitState,
  isMicroBurstOfflineExitState,
  MICRO_BURST_OFFLINE_EXIT_VARIANT,
} from './MicroBurstOfflineExitVariant';
import { defaultMicroBurstConfig, type MicroBurstExitContext } from '../domain/MicroBurstTypes';

const config = defaultMicroBurstConfig();

function context(now: number, side: 'LONG' | 'SHORT', exitPrice: number): MicroBurstExitContext {
  const entryPrice = 100;
  const structuralInvalidationPrice = side === 'LONG' ? 98 : 102;
  const destinationPrice = side === 'LONG' ? 104 : 96;
  return {
    observedAtMs: now,
    timeInTradeMs: now,
    currentPrice: exitPrice,
    entryPrice,
    peakPrice: side === 'LONG' ? Math.max(entryPrice, exitPrice) : entryPrice,
    troughPrice: side === 'SHORT' ? Math.min(entryPrice, exitPrice) : entryPrice,
    structuralInvalidationPrice,
    destinationPrice,
    currentStopPrice: structuralInvalidationPrice,
    unrealizedRoe: 0,
    priceReturn: (exitPrice - entryPrice) / entryPrice,
    leverage: 20,
    momentumDecayFlag: false,
    anomalyExitFlag: false,
    currentBookPressure: {
      spreadBps: 1,
      signedTopOfBookImbalance: side === 'LONG' ? 0.3 : -0.3,
      topOfBookImbalance: 0.3,
      imbalanceSlope: 0,
      temporalAbsorptionDetected: false,
      temporalSweepDetected: false,
      staticBidConcentration: false,
      staticAskConcentration: false,
      anomalyFlag: false,
      status: 'HEALTHY',
    },
    currentBookObservedAtMs: now,
    currentBtcContext: {
      ret1m: side === 'LONG' ? 0.001 : -0.001,
      ret3m: side === 'LONG' ? 0.001 : -0.001,
      ret5m: side === 'LONG' ? 0.001 : -0.001,
      acceleration: 0,
      conflictFlag: false,
      direction: side,
      observedAtMs: now,
      receivedAtMs: now,
    },
    marketEvidence: {
      observedAtMs: now,
      shortHorizonReturnBps: side === 'LONG' ? 3 : -3,
      mediumHorizonReturnBps: side === 'LONG' ? 4 : -4,
      priceSampleCount: 30,
      buyTakerVolume: side === 'LONG' ? 80 : 20,
      sellTakerVolume: side === 'LONG' ? 20 : 80,
      takerTradeCount: 30,
      takerFlowWindowComplete: true,
      takerFlowGapFree: true,
    },
    executableEconomics: {
      observedAtMs: now,
      exitPrice,
      quantityCovered: true,
      residualCostBps: 14,
      volatilityBps: 4,
    },
  };
}

describe('MicroBurst offline no-time-close variant', () => {
  it.each(['LONG', 'SHORT'] as const)(
    'reevaluates at five minutes without time-only close for %s',
    (side) => {
      const first = advanceMicroBurstOfflineExit(
        initialMicroBurstOfflineExitState(),
        context(config.exitMaxHoldMs, side, side === 'LONG' ? 100.2 : 99.8),
        config,
        side,
      );
      expect(first.decision).toMatchObject({
        action: 'HOLD',
        reason: 'HOLD',
        diagnostics: {
          exitPolicyVersion: MICRO_BURST_OFFLINE_EXIT_VARIANT,
          strategicReevaluationDue: true,
        },
      });
      expect(first.decision.diagnostics).not.toMatchObject({ absoluteExposureLimit: true });
    },
  );

  it.each(['LONG', 'SHORT'] as const)(
    'keeps a small net loser eligible for observation: %s',
    (side) => {
      const decision = evaluateMicroBurstOfflineExit(
        context(config.exitMaxHoldMs, side, side === 'LONG' ? 99.9 : 100.1),
        config,
        side,
      );
      expect(decision.action).toBe('HOLD');
      expect(decision.diagnostics).toMatchObject({
        holdBasis: expect.stringMatching(/CONTINUATION_EVIDENCE|NEUTRAL_OR_INSUFFICIENT_EVIDENCE/),
      });
    },
  );

  it.each(['LONG', 'SHORT'] as const)(
    'closes after persistent confirmed deterioration: %s',
    (side) => {
      const first = context(20_000, side, side === 'LONG' ? 99.9 : 100.1);
      first.marketEvidence!.shortHorizonReturnBps = side === 'LONG' ? -3 : 3;
      first.marketEvidence!.buyTakerVolume = side === 'LONG' ? 20 : 80;
      first.marketEvidence!.sellTakerVolume = side === 'LONG' ? 80 : 20;
      first.currentBookPressure!.signedTopOfBookImbalance = side === 'LONG' ? -0.3 : 0.3;
      const one = advanceMicroBurstOfflineExit(
        initialMicroBurstOfflineExitState(),
        first,
        config,
        side,
      );
      expect(one.decision.action).toBe('HOLD');
      const second = structuredClone(first);
      second.observedAtMs = second.timeInTradeMs = 23_000;
      const two = advanceMicroBurstOfflineExit(one.state, second, config, side);
      expect(two.decision).toMatchObject({ action: 'CLOSE_MARKET', reason: 'INTELLIGENT_EXIT' });
      expect(two.decision.diagnostics).toMatchObject({ deteriorationConfirmed: true });
    },
  );

  it('does not close merely because proof progress is absent', () => {
    const decision = evaluateMicroBurstOfflineExit(
      context(config.exitProofWindowMs + config.exitProofExtensionMs, 'LONG', 100),
      config,
      'LONG',
    );
    expect(decision.reason).toBe('HOLD');
  });

  it.each(['LONG', 'SHORT'] as const)(
    'keeps safety invalidation ahead of the variant: %s',
    (side) => {
      const invalid = context(20_000, side, side === 'LONG' ? 98 : 102);
      expect(evaluateMicroBurstOfflineExit(invalid, config, side).reason).toBe('HARD_INVALIDATION');
    },
  );

  it('does not invent continuation or economics when data is absent', () => {
    const degraded = context(config.exitMaxHoldMs, 'LONG', 100.2);
    delete degraded.executableEconomics;
    delete degraded.marketEvidence;
    const decision = evaluateMicroBurstOfflineExit(degraded, config, 'LONG');
    expect(decision).toMatchObject({ action: 'HOLD', diagnostics: { holdBasis: 'DATA_DEGRADED' } });
    expect(decision.diagnostics).toMatchObject({ estimatedNetReturnBps: null });
  });

  it('retains the independent absolute exposure limit', () => {
    const atLimit = context(config.exitMaxHoldMs + config.exitMaxHoldExtensionMs, 'LONG', 100.2);
    expect(evaluateMicroBurstOfflineExit(atLimit, config, 'LONG')).toMatchObject({
      action: 'CLOSE_MARKET',
      reason: 'MAX_HOLD',
      diagnostics: { absoluteExposureLimit: true },
    });
  });

  it('restores deterministically and does not duplicate confirmation', () => {
    const adverse = context(20_000, 'LONG', 99.9);
    adverse.marketEvidence!.shortHorizonReturnBps = -3;
    adverse.marketEvidence!.buyTakerVolume = 20;
    adverse.marketEvidence!.sellTakerVolume = 80;
    adverse.currentBookPressure!.signedTopOfBookImbalance = -0.3;
    const first = advanceMicroBurstOfflineExit(
      initialMicroBurstOfflineExitState(),
      adverse,
      config,
      'LONG',
    );
    const restored = JSON.parse(JSON.stringify(first.state));
    expect(isMicroBurstOfflineExitState(restored)).toBe(true);
    const repeated = advanceMicroBurstOfflineExit(restored, adverse, config, 'LONG');
    expect(repeated.decision.action).toBe('HOLD');
    expect(repeated.state.consecutiveRiskObservations).toBe(
      first.state.consecutiveRiskObservations,
    );
  });
});
