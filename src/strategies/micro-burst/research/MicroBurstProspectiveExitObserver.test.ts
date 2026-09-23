import { describe, expect, it } from 'vitest';
import { defaultMicroBurstConfig, type MicroBurstExitContext } from '../domain/MicroBurstTypes';
import {
  MicroBurstProspectiveExitObserver,
  ProspectiveExitObservation,
} from './MicroBurstProspectiveExitObserver';

const config = defaultMicroBurstConfig();

function context(now: number, side: 'LONG' | 'SHORT', price: number): MicroBurstExitContext {
  const entryPrice = 100;
  const stop = side === 'LONG' ? 98 : 102;
  const destination = side === 'LONG' ? 104 : 96;
  return {
    observedAtMs: now,
    timeInTradeMs: now,
    currentPrice: price,
    entryPrice,
    peakPrice: side === 'LONG' ? Math.max(entryPrice, price) : entryPrice,
    troughPrice: side === 'SHORT' ? Math.min(entryPrice, price) : entryPrice,
    structuralInvalidationPrice: stop,
    destinationPrice: destination,
    currentStopPrice: stop,
    unrealizedRoe: 0,
    priceReturn: (price - entryPrice) / entryPrice,
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
      exitPrice: price,
      quantityCovered: true,
      residualCostBps: 14,
      volatilityBps: 4,
    },
  };
}

function observation(
  now: number,
  side: 'LONG' | 'SHORT',
  price: number,
): ProspectiveExitObservation {
  return {
    eventAtMs: now,
    receivedAtMs: now + 1,
    evaluatedAtMs: now + 2,
    context: context(now, side, price),
    executionAssumptions: {
      roundTripCostBps: 14,
      feeBps: 10,
      slippageBps: 4,
      source: 'TEST_FIXED_QUOTE',
    },
    depth: {
      status: 'HEALTHY',
      observedAtMs: now,
      requiredQuantity: 1,
      availableQuantity: 1,
      levelsUsed: 2,
      quantityCovered: true,
    },
    inputProvenance: {
      btcAvailable: true,
      flowAvailable: true,
      structureAvailable: true,
      quality: { closedCandlesOnly: true },
    },
  };
}

function identity(entryId: string, side: 'LONG' | 'SHORT') {
  return {
    entryId,
    symbol: 'BTCUSDT',
    side,
    enteredAtMs: 0,
    quantity: 2,
    entryPrice: 100,
    strategyVersion: 'test',
    codeCommitSha: 'test-sha',
    configHash: 'test-config',
    currentPolicyVersion: 'EXPECTED_CONTINUATION_V2',
    candidatePolicyVersion: 'MICRO_OFFLINE_NO_TIME_CLOSE_V1' as const,
  };
}

describe('MicroBurst prospective dual exit observer', () => {
  it.each(['LONG', 'SHORT'] as const)(
    'keeps independent simulations after real close: %s',
    (side) => {
      const observer = new MicroBurstProspectiveExitObserver({ config });
      expect(observer.registerEntry(identity(`entry-${side}`, side))).toBe(true);
      expect(observer.markRealPositionClosed(`entry-${side}`, 10_000)).toBe(true);
      expect(
        observer.observe(
          `entry-${side}`,
          observation(300_000, side, side === 'LONG' ? 100.2 : 99.8),
        ),
      ).toBe(true);
      expect(
        observer.observe(
          `entry-${side}`,
          observation(360_000, side, side === 'LONG' ? 100.2 : 99.8),
        ),
      ).toBe(true);
      const snapshot = observer.getEntry(`entry-${side}`)!;
      expect(snapshot.realPositionClosedAtMs).toBe(10_000);
      expect(snapshot.simulations.CURRENT.decisions).toHaveLength(2);
      expect(snapshot.simulations.CANDIDATE.decisions).toHaveLength(2);
      expect(snapshot.simulations.CURRENT.decisions.every((record) => record.hypothetical)).toBe(
        true,
      );
      expect(snapshot.simulations.CANDIDATE.decisions.every((record) => record.hypothetical)).toBe(
        true,
      );
    },
  );

  it('does not invent execution when depth is incomplete or a gap is declared', () => {
    const observer = new MicroBurstProspectiveExitObserver({ config });
    observer.registerEntry(identity('degraded', 'LONG'));
    const degraded = observation(300_000, 'LONG', 100.1);
    degraded.depth!.quantityCovered = false;
    degraded.gap = { kind: 'DEPTH', fromMs: 299_000, toMs: 300_000, reason: 'BOOK_GAP' };
    expect(observer.observe('degraded', degraded)).toBe(true);
    const snapshot = observer.getEntry('degraded')!;
    expect(snapshot.simulations.CURRENT.status).toBe('NO_EVALUABLE');
    expect(snapshot.simulations.CANDIDATE.status).toBe('NO_EVALUABLE');
    expect(snapshot.simulations.CURRENT.decisions[0]).toMatchObject({
      hypothetical: true,
      decision: null,
      evaluable: false,
      gap: { kind: 'DEPTH' },
    });
    expect(observer.getMetrics()).toMatchObject({ gapObservations: 1, noEvaluableEntries: 0 });
  });

  it('marks unresolved stop crossings between observations as NO_EVALUABLE', () => {
    const observer = new MicroBurstProspectiveExitObserver({ config });
    observer.registerEntry(identity('crossing', 'LONG'));
    expect(observer.observe('crossing', observation(1_000, 'LONG', 100.1))).toBe(true);
    expect(observer.observe('crossing', observation(2_000, 'LONG', 97.5))).toBe(true);
    const simulation = observer.getEntry('crossing')!.simulations.CURRENT;
    expect(simulation.status).toBe('NO_EVALUABLE');
    expect(simulation.decisions[1]).toMatchObject({
      decision: null,
      evaluable: false,
      gap: { reason: 'STOP_CROSS_BETWEEN_OBSERVATIONS' },
    });
  });

  it('bounds entries and observations without an I/O or REST queue', () => {
    const observer = new MicroBurstProspectiveExitObserver({
      config,
      maxEntries: 1,
      maxObservationsPerEntry: 1,
    });
    expect(observer.registerEntry(identity('one', 'LONG'))).toBe(true);
    expect(observer.registerEntry(identity('two', 'LONG'))).toBe(false);
    expect(observer.observe('one', observation(1_000, 'LONG', 100.1))).toBe(true);
    expect(observer.observe('one', observation(2_000, 'LONG', 100.1))).toBe(false);
    expect(observer.getMetrics()).toMatchObject({ capacityDrops: 2, queueDepth: 0, ioErrors: 0 });
  });
});
