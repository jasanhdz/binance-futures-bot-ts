import { describe, expect, it } from 'vitest';
import {
  assessMicroBurstContinuation,
  captureMicroBurstExitBaseline,
} from './MicroBurstExitIntelligence';
import {
  advanceMicroBurstExit,
  initialMicroBurstExitEngineState,
  isMicroBurstExitEngineState,
  MicroBurstExitEngine,
} from './MicroBurstExitPolicy';
import {
  BookPressureSignal,
  defaultMicroBurstConfig,
  MicroBurstExitContext,
  MicroBurstExitMarketEvidence,
} from './MicroBurstTypes';

const config = defaultMicroBurstConfig();

function book(overrides: Partial<BookPressureSignal> = {}): BookPressureSignal {
  return {
    spreadBps: 1,
    signedTopOfBookImbalance: 0,
    topOfBookImbalance: 0,
    imbalanceSlope: 0,
    temporalAbsorptionDetected: false,
    temporalSweepDetected: false,
    staticBidConcentration: false,
    staticAskConcentration: false,
    anomalyFlag: false,
    status: 'HEALTHY',
    ...overrides,
  };
}

function evidence(
  observedAtMs: number,
  overrides: Partial<MicroBurstExitMarketEvidence> = {},
): MicroBurstExitMarketEvidence {
  return {
    observedAtMs,
    shortHorizonReturnBps: 2,
    mediumHorizonReturnBps: 3,
    priceSampleCount: 40,
    buyTakerVolume: 80,
    sellTakerVolume: 20,
    takerTradeCount: 100,
    takerFlowWindowComplete: true,
    takerFlowGapFree: true,
    ...overrides,
  };
}

function context(
  observedAtMs: number,
  overrides: Partial<MicroBurstExitContext> = {},
): MicroBurstExitContext {
  return {
    unrealizedRoe: 0,
    priceReturn: 0,
    currentPrice: 100,
    entryPrice: 100,
    peakPrice: 100,
    troughPrice: 100,
    structuralInvalidationPrice: 99.8,
    destinationPrice: 102,
    currentStopPrice: 99.8,
    timeInTradeMs: observedAtMs,
    observedAtMs,
    momentumDecayFlag: false,
    anomalyExitFlag: false,
    currentBookPressure: book(),
    currentBtcContext: null,
    marketEvidence: evidence(observedAtMs),
    leverage: 20,
    ...overrides,
  };
}

function longReversal(observedAtMs: number): MicroBurstExitContext {
  return context(observedAtMs, {
    currentPrice: 100.1,
    peakPrice: 100.3,
    currentStopPrice: 100,
    currentBookPressure: book({
      signedTopOfBookImbalance: -0.3,
      topOfBookImbalance: 0.3,
      imbalanceSlope: -0.08,
    }),
    marketEvidence: evidence(observedAtMs, {
      shortHorizonReturnBps: -2,
      mediumHorizonReturnBps: -3,
      buyTakerVolume: 20,
      sellTakerVolume: 80,
    }),
  });
}

describe('MicroBurst Expected Continuation Exit v2', () => {
  it('counts correlated book features as one causal source', () => {
    const candidate = context(20_000, {
      currentPrice: 100.05,
      peakPrice: 100.05,
      currentBookPressure: book({
        signedTopOfBookImbalance: -0.3,
        topOfBookImbalance: 0.3,
        imbalanceSlope: -0.08,
        temporalAbsorptionDetected: true,
        temporalSweepDetected: true,
      }),
      marketEvidence: evidence(20_000, {
        shortHorizonReturnBps: 0,
        mediumHorizonReturnBps: 0,
        buyTakerVolume: 50,
        sellTakerVolume: 50,
      }),
    });
    const assessment = assessMicroBurstContinuation(candidate, config, 'LONG');
    expect(assessment.adverseSources).toEqual(['BOOK']);
    expect(
      new MicroBurstExitEngine().evaluate('one-book-source', candidate, config, 'LONG'),
    ).toMatchObject({
      action: 'HOLD',
      diagnostics: { adverseSources: ['BOOK'], riskQualified: false },
    });
  });

  it('keeps a profitable near-target trade while independent continuation remains strong', () => {
    const winner = (observedAtMs: number) =>
      context(observedAtMs, {
        currentPrice: 101.6,
        peakPrice: 101.6,
        currentStopPrice: 100.7,
        currentBookPressure: book({
          signedTopOfBookImbalance: 0.3,
          topOfBookImbalance: 0.3,
          imbalanceSlope: 0.06,
        }),
      });
    const engine = new MicroBurstExitEngine();
    for (const at of [20_000, 24_000, 30_000]) {
      expect(engine.evaluate('continuing-winner', winner(at), config, 'LONG')).toMatchObject({
        action: 'HOLD',
        diagnostics: { continuationEligible: true, noTrailingCallbackUsed: true },
      });
    }
  });

  it('confirms a persistent price-flow-book reversal before closing', () => {
    const engine = new MicroBurstExitEngine();
    expect(engine.evaluate('reversal', longReversal(20_000), config, 'LONG')).toMatchObject({
      action: 'HOLD',
      diagnostics: { exitIntelligencePhase: 'ARMED' },
    });
    expect(engine.evaluate('reversal', longReversal(21_000), config, 'LONG').action).toBe('HOLD');
    expect(engine.evaluate('reversal', longReversal(23_000), config, 'LONG')).toMatchObject({
      action: 'CLOSE_MARKET',
      reason: 'INTELLIGENT_EXIT',
      diagnostics: {
        confirmationElapsedMs: 3_000,
        persistentCausalSources: ['PRICE', 'FLOW', 'BOOK'],
      },
    });
  });

  it('requires stronger exit pressure after costs are covered', () => {
    const mixedWinner = context(20_000, {
      currentPrice: 100.5,
      peakPrice: 100.7,
      currentStopPrice: 100.16,
      currentBookPressure: book({
        signedTopOfBookImbalance: 0.3,
        topOfBookImbalance: 0.3,
        imbalanceSlope: 0.06,
      }),
      currentBtcContext: {
        ret1m: 0.002,
        ret3m: 0.002,
        ret5m: 0.002,
        acceleration: 0,
        conflictFlag: false,
        direction: 'LONG',
        observedAtMs: 20_000,
        receivedAtMs: 20_000,
      },
      marketEvidence: evidence(20_000, {
        shortHorizonReturnBps: -2,
        mediumHorizonReturnBps: -2,
        buyTakerVolume: 20,
        sellTakerVolume: 80,
      }),
    });
    const decision = new MicroBurstExitEngine().evaluate(
      'mixed-winner',
      mixedWinner,
      config,
      'LONG',
    );
    expect(decision).toMatchObject({
      action: 'HOLD',
      diagnostics: {
        pressureThreshold: config.exitWinnerExitPressureThreshold,
        riskQualified: false,
      },
    });
  });

  it.each([
    ['LONG' as const, 100.3, 99.8, 102, 100.16],
    ['SHORT' as const, 99.7, 100.2, 98, 99.84],
  ])(
    'locks estimated costs plus buffer for %s without using MFE callback',
    (side, price, stop, target, expectedStop) => {
      const decision = new MicroBurstExitEngine().evaluate(
        `cost-lock-${side}`,
        context(20_000, {
          currentPrice: price,
          peakPrice: side === 'LONG' ? price : 100,
          troughPrice: side === 'SHORT' ? price : 100,
          structuralInvalidationPrice: stop,
          destinationPrice: target,
          currentStopPrice: stop,
          marketEvidence: null,
          currentBookPressure: null,
        }),
        config,
        side,
      );
      expect(decision).toMatchObject({
        action: 'MOVE_STOP',
        reason: 'PROFIT_LOCK',
        diagnostics: {
          protectionMilestone: 'COST_COVER',
          protectedGrossBps: 16,
          estimatedProtectedNetBps: 2,
          noTrailingCallbackUsed: true,
        },
      });
      expect(decision.requestedStopPrice).toBeCloseTo(expectedStop, 10);
      expect(decision.diagnostics).not.toHaveProperty('callbackBps');
    },
  );

  it('locks a target-anchored fraction at the structural milestone', () => {
    const decision = new MicroBurstExitEngine().evaluate(
      'structural-lock',
      context(30_000, {
        currentPrice: 101.6,
        peakPrice: 101.6,
        currentStopPrice: 100.16,
        marketEvidence: null,
        currentBookPressure: null,
      }),
      config,
      'LONG',
    );
    expect(decision).toMatchObject({
      action: 'MOVE_STOP',
      reason: 'PROFIT_LOCK',
      diagnostics: { protectionMilestone: 'STRUCTURAL_PROGRESS', protectedGrossBps: 70 },
    });
    expect(decision.requestedStopPrice).toBeCloseTo(100.7, 10);
  });

  it('grants exactly one bounded proof extension only with strong continuation', () => {
    const proving = (observedAtMs: number) =>
      context(observedAtMs, {
        currentPrice: 100.02,
        peakPrice: 100.02,
        currentBookPressure: book({
          signedTopOfBookImbalance: 0.3,
          topOfBookImbalance: 0.3,
          imbalanceSlope: 0.06,
        }),
      });
    expect(
      new MicroBurstExitEngine().evaluate('proof', proving(60_000), config, 'LONG'),
    ).toMatchObject({
      action: 'HOLD',
      diagnostics: { proofExtensionActive: true, continuationEligible: true },
    });
    expect(
      new MicroBurstExitEngine().evaluate('proof-expired', proving(90_000), config, 'LONG'),
    ).toMatchObject({
      action: 'CLOSE_MARKET',
      reason: 'EARLY_FAILURE',
      diagnostics: { phase: 'PROOF_EXTENSION_EXPIRED' },
    });
  });

  it('extends max hold only while the trade is net-profitable and continuation is strong', () => {
    const continuing = (observedAtMs: number) =>
      context(observedAtMs, {
        currentPrice: 100.3,
        peakPrice: 100.3,
        currentStopPrice: 100.16,
        currentBookPressure: book({
          signedTopOfBookImbalance: 0.3,
          topOfBookImbalance: 0.3,
          imbalanceSlope: 0.06,
        }),
      });
    expect(
      new MicroBurstExitEngine().evaluate('max-hold', continuing(300_000), config, 'LONG'),
    ).toMatchObject({
      action: 'HOLD',
      diagnostics: { maxHoldExtensionActive: true },
    });
    expect(
      new MicroBurstExitEngine().evaluate('max-hold-expired', continuing(360_000), config, 'LONG'),
    ).toMatchObject({
      action: 'CLOSE_MARKET',
      reason: 'MAX_HOLD',
    });
  });

  it('treats stale book data as unavailable rather than forcing a market close', () => {
    const stale = context(20_000, {
      currentBookPressure: book({ status: 'STALE' }),
      marketEvidence: null,
    });
    expect(new MicroBurstExitEngine().evaluate('stale-book', stale, config, 'LONG')).toMatchObject({
      action: 'HOLD',
      diagnostics: { availableSources: ['STRUCTURE_TIME'] },
    });
  });

  it('derives BTC adversity from causal returns even when the provider flag is false', () => {
    const candidate = context(20_000, {
      currentBtcContext: {
        ret1m: -0.004,
        ret3m: -0.004,
        ret5m: -0.004,
        acceleration: 0,
        conflictFlag: false,
        direction: 'SHORT',
        observedAtMs: 20_000,
        receivedAtMs: 20_000,
      },
    });
    expect(assessMicroBurstContinuation(candidate, config, 'LONG').adverseSources).toContain('BTC');
  });

  it('captures entry-relative flow/book baselines and migrates a valid v1 state', () => {
    const initial = context(1_000, {
      currentBookPressure: book({ signedTopOfBookImbalance: 0.3, topOfBookImbalance: 0.3 }),
    });
    const baseline = captureMicroBurstExitBaseline(initial, config, 'LONG');
    expect(baseline.sideAwareFlowRatio).toBeCloseTo(0.6);
    expect(baseline.sideAwareBookPressure).toBe(0.3);

    const v1State = {
      schemaVersion: 1 as const,
      phase: 'OBSERVING' as const,
      riskStartedAtMs: null,
      lastObservedAtMs: 1_000,
      consecutiveRiskObservations: 0,
      evidenceFamilies: [],
    };
    expect(isMicroBurstExitEngineState(v1State)).toBe(true);
    const transition = advanceMicroBurstExit(v1State, context(2_000), config, 'LONG');
    expect(transition.state).toMatchObject({ schemaVersion: 2, stage: 'PROVING' });
  });

  it('enriches a missing entry-flow baseline at the first complete causal window', () => {
    const engine = new MicroBurstExitEngine();
    engine.evaluate(
      'baseline-enrichment',
      context(1_000, {
        marketEvidence: evidence(1_000, {
          takerFlowWindowComplete: false,
          takerTradeCount: 5,
        }),
      }),
      config,
      'LONG',
    );
    expect(engine.getState('baseline-enrichment').baseline?.sideAwareFlowRatio).toBeNull();

    engine.evaluate('baseline-enrichment', context(6_000), config, 'LONG');
    expect(engine.getState('baseline-enrichment').baseline?.sideAwareFlowRatio).toBeCloseTo(0.6);
    expect(engine.getState('baseline-enrichment').baseline?.observedAtMs).toBe(1_000);
  });

  it('remains deterministic for identical state, context and config', () => {
    const state = initialMicroBurstExitEngineState();
    const candidate = longReversal(20_000);
    expect(advanceMicroBurstExit(state, candidate, config, 'LONG')).toEqual(
      advanceMicroBurstExit(state, candidate, config, 'LONG'),
    );
  });
});
