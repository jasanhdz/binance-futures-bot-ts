import { describe, expect, it } from 'vitest';
import { defaultMicroBurstConfig, type MicroBurstExitContext } from '../domain/MicroBurstTypes';
import { compareMicroBurstOfflineExitPolicies } from './MicroBurstOfflineExitComparison';

function observation(now: number): { observedAtMs: number; context: MicroBurstExitContext } {
  return {
    observedAtMs: now,
    context: {
      observedAtMs: now,
      timeInTradeMs: now,
      currentPrice: 100.1,
      entryPrice: 100,
      peakPrice: 100.1,
      troughPrice: 100,
      structuralInvalidationPrice: 98,
      destinationPrice: 104,
      currentStopPrice: 98,
      unrealizedRoe: 0,
      priceReturn: 0.001,
      leverage: 20,
      momentumDecayFlag: false,
      anomalyExitFlag: false,
      currentBookPressure: null,
      currentBtcContext: null,
      marketEvidence: null,
      executableEconomics: {
        observedAtMs: now,
        exitPrice: 100.1,
        quantityCovered: true,
        residualCostBps: 14,
        volatilityBps: 4,
      },
    },
  };
}

describe('causal CURRENT versus offline variant comparison', () => {
  it('uses identical observations and leaves the six-minute bound explicit', () => {
    const config = defaultMicroBurstConfig();
    const result = compareMicroBurstOfflineExitPolicies(
      [
        observation(config.exitMaxHoldMs),
        observation(config.exitMaxHoldMs + config.exitMaxHoldExtensionMs),
      ],
      'LONG',
      config,
    );
    expect(result.complete).toBe(true);
    expect(result.current).toMatchObject({
      counterfactualExitReason: 'MAX_HOLD',
      counterfactualExitAtMs: config.exitMaxHoldMs,
    });
    expect(result.variant).toMatchObject({
      counterfactualExitReason: 'MAX_HOLD',
      counterfactualExitAtMs: config.exitMaxHoldMs + config.exitMaxHoldExtensionMs,
    });
  });

  it('does not score an incomplete open horizon', () => {
    const result = compareMicroBurstOfflineExitPolicies([observation(300_000)], 'LONG');
    expect(result.complete).toBe(false);
    expect(result.incompleteReason).toBe('HORIZON_ENDED_OPEN');
    expect(result.current).toMatchObject({ counterfactualExitReason: 'MAX_HOLD' });
    expect(result.variant).toBeNull();
  });
});
