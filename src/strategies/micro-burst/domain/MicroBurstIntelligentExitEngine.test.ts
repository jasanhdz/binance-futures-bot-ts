import { describe, expect, it } from 'vitest';
import { collectMicroBurstExitEvidence, MicroBurstExitEngine } from './MicroBurstExitPolicy';
import {
  BookPressureSignal,
  defaultMicroBurstConfig,
  MicroBurstExitContext,
  MicroBurstExitMarketEvidence,
} from './MicroBurstTypes';

const config = defaultMicroBurstConfig();

function healthyBook(overrides: Partial<BookPressureSignal> = {}): BookPressureSignal {
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

function marketEvidence(
  observedAtMs: number,
  overrides: Partial<MicroBurstExitMarketEvidence> = {},
): MicroBurstExitMarketEvidence {
  return {
    observedAtMs,
    shortHorizonReturnBps: -2,
    mediumHorizonReturnBps: 2,
    priceSampleCount: 30,
    buyTakerVolume: 20,
    sellTakerVolume: 80,
    takerTradeCount: 100,
    takerFlowWindowComplete: true,
    takerFlowGapFree: true,
    ...overrides,
  };
}

function longRiskContext(
  observedAtMs: number,
  overrides: Partial<MicroBurstExitContext> = {},
): MicroBurstExitContext {
  return {
    unrealizedRoe: 0.1,
    priceReturn: 0.005,
    currentPrice: 100.5,
    entryPrice: 100,
    peakPrice: 100.7,
    troughPrice: 100,
    structuralInvalidationPrice: 99,
    destinationPrice: 102,
    currentStopPrice: 100.16,
    timeInTradeMs: observedAtMs,
    observedAtMs,
    momentumDecayFlag: false,
    anomalyExitFlag: false,
    currentBookPressure: healthyBook({
      signedTopOfBookImbalance: -0.3,
      topOfBookImbalance: 0.3,
      imbalanceSlope: -0.08,
    }),
    currentBtcContext: null,
    marketEvidence: marketEvidence(observedAtMs),
    leverage: 20,
    ...overrides,
  };
}

function shortRiskContext(observedAtMs: number): MicroBurstExitContext {
  return {
    ...longRiskContext(observedAtMs),
    priceReturn: 0.005,
    currentPrice: 99.5,
    peakPrice: 100,
    troughPrice: 99.3,
    structuralInvalidationPrice: 101,
    destinationPrice: 98,
    currentStopPrice: 99.84,
    currentBookPressure: healthyBook({
      signedTopOfBookImbalance: 0.3,
      topOfBookImbalance: 0.3,
      imbalanceSlope: 0.08,
    }),
    marketEvidence: marketEvidence(observedAtMs, {
      shortHorizonReturnBps: 2,
      buyTakerVolume: 80,
      sellTakerVolume: 20,
    }),
  };
}

describe('MicroBurst intelligent exit evidence', () => {
  it.each([
    ['LONG', longRiskContext(20_000)],
    ['SHORT', shortRiskContext(20_000)],
  ] as const)('is symmetric for %s reversals', (side, context) => {
    expect(collectMicroBurstExitEvidence(context, config, side).map((item) => item.family)).toEqual(
      expect.arrayContaining([
        'MOMENTUM_REVERSAL',
        'TAKER_FLOW_REVERSAL',
        'BOOK_PRESSURE_REVERSAL',
      ]),
    );
  });

  it('ignores incomplete or discontinuous taker flow', () => {
    const context = longRiskContext(20_000, {
      currentBookPressure: healthyBook(),
      marketEvidence: marketEvidence(20_000, {
        shortHorizonReturnBps: 2,
        takerFlowWindowComplete: false,
        takerFlowGapFree: false,
      }),
    });
    expect(collectMicroBurstExitEvidence(context, config, 'LONG')).toEqual([]);
  });

  it('ignores future or stale market evidence', () => {
    for (const evidenceObservedAtMs of [40_000, 1_000]) {
      const context = longRiskContext(20_000, {
        currentBookPressure: healthyBook(),
        marketEvidence: marketEvidence(evidenceObservedAtMs),
      });
      expect(collectMicroBurstExitEvidence(context, config, 'LONG')).toEqual([]);
    }
  });

  it('treats proximity to the structural destination as evidence, never as a standalone exit', () => {
    const context = longRiskContext(20_000, {
      currentPrice: 101.6,
      peakPrice: 101.6,
      currentStopPrice: 100.7,
      currentBookPressure: healthyBook(),
      marketEvidence: marketEvidence(20_000, {
        shortHorizonReturnBps: 2,
        buyTakerVolume: 50,
        sellTakerVolume: 50,
      }),
    });
    expect(
      collectMicroBurstExitEvidence(context, config, 'LONG').map((item) => item.family),
    ).toEqual(['STRUCTURAL_EXHAUSTION']);
    expect(new MicroBurstExitEngine().evaluate('trade', context, config, 'LONG').action).toBe(
      'HOLD',
    );
  });
});

describe('MicroBurst intelligent exit hysteresis', () => {
  it('arms, confirms sustained independent evidence, then closes without trailing', () => {
    const engine = new MicroBurstExitEngine();
    expect(engine.evaluate('trade', longRiskContext(20_000), config, 'LONG')).toMatchObject({
      action: 'HOLD',
      diagnostics: { exitIntelligencePhase: 'ARMED' },
    });
    expect(engine.evaluate('trade', longRiskContext(21_000), config, 'LONG').action).toBe('HOLD');
    const decision = engine.evaluate('trade', longRiskContext(23_000), config, 'LONG');
    expect(decision).toMatchObject({
      action: 'CLOSE_MARKET',
      reason: 'INTELLIGENT_EXIT',
      diagnostics: {
        noTrailingCallbackUsed: true,
        confirmationElapsedMs: 3_000,
      },
    });
    expect(decision.diagnostics).not.toHaveProperty('callbackBps');
  });

  it('does not close from a single evidence family, even when repeated', () => {
    const engine = new MicroBurstExitEngine();
    for (const observedAtMs of [20_000, 24_000, 28_000]) {
      const decision = engine.evaluate(
        'trade',
        longRiskContext(observedAtMs, {
          currentBookPressure: healthyBook(),
          marketEvidence: marketEvidence(observedAtMs, {
            shortHorizonReturnBps: -2,
            buyTakerVolume: 50,
            sellTakerVolume: 50,
          }),
        }),
        config,
        'LONG',
      );
      expect(decision.action).toBe('HOLD');
    }
  });

  it('does not count duplicate timestamps as confirmation', () => {
    const engine = new MicroBurstExitEngine();
    for (let i = 0; i < 10; i++) {
      expect(engine.evaluate('trade', longRiskContext(20_000), config, 'LONG').action).toBe('HOLD');
    }
    expect(engine.getState('trade')).toMatchObject({
      phase: 'ARMED',
      consecutiveRiskObservations: 1,
    });
  });

  it('does not move the confirmation window backwards on regressing timestamps', () => {
    const engine = new MicroBurstExitEngine();
    expect(engine.evaluate('trade', longRiskContext(20_000), config, 'LONG').action).toBe('HOLD');
    expect(engine.evaluate('trade', longRiskContext(19_000), config, 'LONG').action).toBe('HOLD');
    expect(engine.evaluate('trade', longRiskContext(22_000), config, 'LONG').action).toBe('HOLD');
    expect(engine.getState('trade')).toMatchObject({
      riskStartedAtMs: 20_000,
      lastObservedAtMs: 22_000,
      consecutiveRiskObservations: 2,
    });
  });

  it('resets the confirmation window when risk disappears', () => {
    const engine = new MicroBurstExitEngine();
    engine.evaluate('trade', longRiskContext(20_000), config, 'LONG');
    const neutral = longRiskContext(21_000, {
      currentBookPressure: healthyBook(),
      marketEvidence: marketEvidence(21_000, {
        shortHorizonReturnBps: 2,
        buyTakerVolume: 50,
        sellTakerVolume: 50,
      }),
    });
    expect(engine.evaluate('trade', neutral, config, 'LONG').action).toBe('HOLD');
    expect(engine.getState('trade').phase).toBe('OBSERVING');
    expect(engine.evaluate('trade', longRiskContext(24_000), config, 'LONG').action).toBe('HOLD');
  });

  it('holds before the minimum age even with strong evidence', () => {
    const engine = new MicroBurstExitEngine();
    for (const observedAtMs of [5_000, 9_000, 13_000]) {
      expect(engine.evaluate('trade', longRiskContext(observedAtMs), config, 'LONG').action).toBe(
        'HOLD',
      );
    }
    expect(engine.getState('trade').phase).toBe('OBSERVING');
  });

  it('persists a confirmed close decision until the position lifecycle completes', () => {
    const engine = new MicroBurstExitEngine();
    engine.evaluate('trade', longRiskContext(20_000), config, 'LONG');
    const confirmed = engine.evaluate('trade', longRiskContext(23_000), config, 'LONG');
    const laterNeutral = longRiskContext(25_000, {
      currentBookPressure: healthyBook(),
      marketEvidence: marketEvidence(25_000, {
        shortHorizonReturnBps: 2,
        buyTakerVolume: 50,
        sellTakerVolume: 50,
      }),
    });
    expect(engine.evaluate('trade', laterNeutral, config, 'LONG')).toEqual(confirmed);
  });

  it('never lets hysteresis delay a hard invalidation', () => {
    const decision = new MicroBurstExitEngine().evaluate(
      'trade',
      longRiskContext(1_000, { currentPrice: 98.9, troughPrice: 98.9 }),
      config,
      'LONG',
    );
    expect(decision).toMatchObject({ action: 'CLOSE_MARKET', reason: 'HARD_INVALIDATION' });
  });
});
