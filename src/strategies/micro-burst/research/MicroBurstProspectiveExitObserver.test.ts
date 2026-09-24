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
      requiredQuantity: 2,
      availableQuantity: 2,
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

  it.each(['LONG', 'SHORT'] as const)('keeps protective stop invariants aligned: %s', (side) => {
    const observer = new MicroBurstProspectiveExitObserver({ config });
    observer.registerEntry(identity(`protection-${side}`, side));
    const value = observation(60_000, side, side === 'LONG' ? 103 : 97);
    expect(observer.observe(`protection-${side}`, value)).toBe(true);
    const snapshot = observer.getEntry(`protection-${side}`)!;
    expect(snapshot.simulations.CURRENT.decisions[0].decision?.action).toBe('MOVE_STOP');
    expect(snapshot.simulations.CANDIDATE.decisions[0].decision?.action).toBe('MOVE_STOP');
    expect(snapshot.simulations.CURRENT.decisions[0].decision?.requestedStopPrice).toBe(
      snapshot.simulations.CANDIDATE.decisions[0].decision?.requestedStopPrice,
    );
  });

  it('does not invent execution when depth is incomplete or a gap is declared', () => {
    const observer = new MicroBurstProspectiveExitObserver({ config });
    observer.registerEntry(identity('degraded', 'LONG'));
    const degraded = observation(300_000, 'LONG', 100.1);
    degraded.depth!.quantityCovered = false;
    degraded.gap = { kind: 'DEPTH', fromMs: 299_000, toMs: 300_000, reason: 'BOOK_GAP' };
    expect(observer.observe('degraded', degraded)).toBe(true);
    const snapshot = observer.getEntry('degraded')!;
    expect(snapshot.simulations.CURRENT.status).toBe('ACTIVE');
    expect(snapshot.simulations.CANDIDATE.status).toBe('ACTIVE');
    expect(snapshot.simulations.CURRENT.noEvaluableReason).toBe('BOOK_GAP');
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
    expect(simulation.status).toBe('ACTIVE');
    expect(simulation.noEvaluableAtMs).toBe(2_002);
    expect(simulation.noEvaluableReason).toBe('STOP_CROSS_BETWEEN_OBSERVATIONS');
    expect(simulation.decisions[1]).toMatchObject({
      decision: null,
      evaluable: false,
      gap: { reason: 'STOP_CROSS_BETWEEN_OBSERVATIONS', fromMs: 1_000, toMs: 2_000 },
    });
  });

  it('keeps an observed target arrival evaluable and applies candidate target semantics to executable price', () => {
    const observer = new MicroBurstProspectiveExitObserver({ config });
    observer.registerEntry(identity('target', 'LONG'));
    const first = observation(1_000, 'LONG', 100.1);
    first.context.destinationPrice = 101;
    expect(observer.observe('target', first)).toBe(true);
    const arrival = observation(2_000, 'LONG', 101);
    arrival.context.destinationPrice = 101;
    arrival.context.executableEconomics!.exitPrice = 100.9;
    expect(observer.observe('target', arrival)).toBe(true);
    const snapshot = observer.getEntry('target')!;
    expect(snapshot.simulations.CURRENT.decisions[1].decision).not.toBeNull();
    expect(snapshot.simulations.CURRENT.noEvaluableReason).toBeNull();
    expect(snapshot.simulations.CANDIDATE.noEvaluableReason).toBeNull();
  });

  it('rejects insufficient depth as non-evaluable evidence instead of accepting it as covered', () => {
    const observer = new MicroBurstProspectiveExitObserver({ config });
    observer.registerEntry(identity('quantity', 'LONG'));
    const value = observation(1_000, 'LONG', 100.1);
    value.depth!.requiredQuantity = 2;
    value.depth!.availableQuantity = 1;
    expect(observer.observe('quantity', value)).toBe(true);
    const snapshot = observer.getEntry('quantity')!;
    expect(snapshot.simulations.CURRENT.decisions[0]).toMatchObject({
      evaluable: false,
      economicEvaluable: false,
      gap: { reason: 'DEPTH_QUANTITY_INSUFFICIENT' },
    });
    expect(snapshot.simulations.CURRENT.resultEvaluable).toBe(false);
  });

  it('rejects incompatible identity/fill duplicates and protects returned state from mutation', () => {
    const observer = new MicroBurstProspectiveExitObserver({ config });
    const entry = identity('identity', 'LONG');
    expect(observer.registerEntry(entry)).toBe(true);
    expect(observer.registerEntry({ ...entry, entryPrice: 101 })).toBe(false);
    const fill = {
      fillId: 'fill-identity',
      orderId: 'order-identity',
      eventAtMs: 1,
      receivedAtMs: 2,
      price: 100,
      quantity: 2,
      feeBps: 1,
      fundingBps: 0,
    };
    expect(observer.recordRealFill('identity', fill)).toBe(true);
    expect(observer.recordRealFill('identity', { ...fill })).toBe(true);
    expect(observer.recordRealFill('identity', { ...fill, quantity: 1 })).toBe(false);
    const returned = observer.getEntry('identity')!;
    returned.identity.entryPrice = 999;
    returned.realFills[0].price = 999;
    expect(observer.getEntry('identity')!.identity.entryPrice).toBe(100);
    expect(observer.getEntry('identity')!.realFills[0].price).toBe(100);

    const restoredObserver = new MicroBurstProspectiveExitObserver({ config });
    const restored = observer.getEntry('identity')!;
    expect(restoredObserver.restoreEntry(restored)).toBe(true);
    (restored.simulations.CANDIDATE.state as { phase: string }).phase = 'CLOSING';
    expect(restoredObserver.getEntry('identity')!.simulations.CANDIDATE.state).not.toMatchObject({
      phase: 'CLOSING',
    });
  });

  it('keeps result unevaluable after a pre-close gap but not after a resolved close', () => {
    const observer = new MicroBurstProspectiveExitObserver({ config });
    observer.registerEntry(identity('gap-result', 'LONG'));
    const gap = observation(1_000, 'LONG', 100.1);
    gap.gap = { kind: 'DEPTH', fromMs: 900, toMs: 1_000, reason: 'BOOK_GAP' };
    expect(observer.observe('gap-result', gap)).toBe(true);
    expect(observer.observe('gap-result', observation(360_000, 'LONG', 100.1))).toBe(true);
    const unresolved = observer.getEntry('gap-result')!;
    expect(unresolved.simulations.CURRENT.resultEvaluable).toBe(false);
    expect(observer.getMetrics().noEvaluableEntries).toBe(1);

    observer.registerEntry(identity('closed-gap', 'LONG'));
    const target = observation(1_000, 'LONG', 104);
    expect(observer.observe('closed-gap', target)).toBe(true);
    const afterClose = observation(2_000, 'LONG', 104);
    afterClose.gap = { kind: 'DEPTH', fromMs: 1_500, toMs: 2_000, reason: 'LATE_GAP' };
    expect(observer.observe('closed-gap', afterClose)).toBe(true);
    expect(observer.getEntry('closed-gap')!.simulations.CURRENT.resultEvaluable).toBe(true);
  });

  it('makes observations idempotent, rejects reverse time, and completes once', () => {
    const observer = new MicroBurstProspectiveExitObserver({ config });
    observer.registerEntry(identity('lifecycle', 'LONG'));
    const first = observation(1_000, 'LONG', 100.1);
    expect(observer.observe('lifecycle', first)).toBe(true);
    expect(observer.observe('lifecycle', structuredClone(first))).toBe(true);
    expect(observer.getEntry('lifecycle')!.observations).toHaveLength(1);
    expect(observer.observe('lifecycle', observation(900, 'LONG', 100.1))).toBe(false);
    const horizon = observer.getEntry('lifecycle')!.horizonAtMs;
    expect(observer.observe('lifecycle', observation(horizon, 'LONG', 100.1))).toBe(true);
    expect(observer.getMetrics()).toMatchObject({ completedEntries: 1, activeEntries: 0 });
    expect(observer.observe('lifecycle', observation(horizon + 1_000, 'LONG', 100.1))).toBe(false);
    expect(observer.getMetrics()).toMatchObject({ completedEntries: 1 });
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
