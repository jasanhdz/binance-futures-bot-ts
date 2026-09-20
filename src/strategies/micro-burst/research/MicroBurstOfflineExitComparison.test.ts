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
  it('never repairs an unpriced terminal decision with a later quote', () => {
    const missing = observation(360_000);
    missing.context.executableEconomics = undefined;
    const result = compareMicroBurstOfflineExitPolicies([missing, observation(361_000)], 'LONG');
    expect(result.complete).toBe(false);
    expect(result.alternativeOutcome).toBe('NO_EVALUABLE');
    expect(result.current).toBeNull();
    expect(result.variant).toBeNull();
  });

  it.each(['future', 'stale', 'uncovered', 'nonfinite', 'negative-cost'])(
    'does not price an absolute deadline with %s economics',
    (kind) => {
      const row = observation(360_000);
      const e = row.context.executableEconomics!;
      if (kind === 'future') e.observedAtMs++;
      if (kind === 'stale') e.observedAtMs = 0;
      if (kind === 'uncovered') e.quantityCovered = false;
      if (kind === 'nonfinite') e.exitPrice = NaN;
      if (kind === 'negative-cost') e.residualCostBps = -1;
      const result = compareMicroBurstOfflineExitPolicies([row], 'LONG');
      expect(result.complete).toBe(false);
      expect(result.current).toBeNull();
      expect(result.variant).toBeNull();
    },
  );

  it('rejects mismatched clocks rather than sorting into an invented chronology', () => {
    const row = observation(360_000);
    row.context.observedAtMs = 1;
    expect(compareMicroBurstOfflineExitPolicies([row], 'LONG').complete).toBe(false);
  });

  it('rejects changing entry identity and economic age', () => {
    const changed = observation(360_000);
    changed.context.entryPrice = 101;
    changed.context.timeInTradeMs = 100;
    expect(
      compareMicroBurstOfflineExitPolicies([observation(300_000), changed], 'LONG').complete,
    ).toBe(false);
  });

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
    expect(result.alternativeOutcome).toBe('EVALUABLE');
    expect(result.current).toMatchObject({
      counterfactualExitReason: 'MAX_HOLD',
      counterfactualExitAtMs: config.exitMaxHoldMs,
    });
    expect(result.variant).toMatchObject({
      counterfactualExitReason: 'MAX_HOLD',
      counterfactualExitAtMs: config.exitMaxHoldMs + config.exitMaxHoldExtensionMs,
    });
    expect(result.divergences.length).toBeGreaterThan(0);
    expect(result.divergences[0]).toMatchObject({
      observedAtMs: config.exitMaxHoldMs,
      current: { action: 'CLOSE_MARKET' },
      variant: { action: 'HOLD', reason: 'HOLD' },
      evidence: {
        currentTimeInTradeMs: config.exitMaxHoldMs,
        variantTimeInTradeMs: config.exitMaxHoldMs,
      },
    });
  });

  it('does not score an incomplete open horizon', () => {
    const result = compareMicroBurstOfflineExitPolicies([observation(300_000)], 'LONG');
    expect(result.complete).toBe(false);
    expect(result.incompleteReason).toBe('HORIZON_ENDED_OPEN');
    expect(result.current).toMatchObject({ counterfactualExitReason: 'MAX_HOLD' });
    expect(result.variant).toBeNull();
  });

  it('keeps CURRENT economics and protection inputs unchanged', () => {
    const config = defaultMicroBurstConfig();
    const source = observation(config.exitMaxHoldMs);
    const snapshot = {
      stop: source.context.currentStopPrice,
      destination: source.context.destinationPrice,
      proof: config.exitProofWindowMs,
      proofExtension: config.exitProofExtensionMs,
      maxHold: config.exitMaxHoldMs,
      maxHoldExtension: config.exitMaxHoldExtensionMs,
      cost: config.exitEstimatedRoundTripCostBps,
    };
    compareMicroBurstOfflineExitPolicies([source], 'LONG', config);
    expect({
      stop: source.context.currentStopPrice,
      destination: source.context.destinationPrice,
      proof: config.exitProofWindowMs,
      proofExtension: config.exitProofExtensionMs,
      maxHold: config.exitMaxHoldMs,
      maxHoldExtension: config.exitMaxHoldExtensionMs,
      cost: config.exitEstimatedRoundTripCostBps,
    }).toEqual(snapshot);
  });
});
