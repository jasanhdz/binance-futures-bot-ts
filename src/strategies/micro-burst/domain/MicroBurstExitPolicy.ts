import { MicroBurstConfig, MicroBurstExitContext, MicroBurstExitDecision } from './MicroBurstTypes';
import { decimalReturnToBps } from './MicroBurstUnits';

export type MicroBurstExitEvidenceFamily =
  | 'MOMENTUM_REVERSAL'
  | 'TAKER_FLOW_REVERSAL'
  | 'BOOK_PRESSURE_REVERSAL'
  | 'ABSORPTION'
  | 'LIQUIDITY_SWEEP'
  | 'STRUCTURAL_EXHAUSTION'
  | 'TIME_DECAY';

export interface MicroBurstExitEvidenceItem {
  family: MicroBurstExitEvidenceFamily;
  score: number;
  diagnostics: Record<string, unknown>;
}

export interface MicroBurstExitEngineState {
  schemaVersion: 1;
  phase: 'OBSERVING' | 'ARMED' | 'EXIT_CONFIRMED';
  riskStartedAtMs: number | null;
  lastObservedAtMs: number | null;
  consecutiveRiskObservations: number;
  evidenceFamilies: MicroBurstExitEvidenceFamily[];
  confirmedDecision?: MicroBurstExitDecision;
}

export interface MicroBurstExitTransition {
  state: MicroBurstExitEngineState;
  decision: MicroBurstExitDecision;
}

export function initialMicroBurstExitEngineState(): MicroBurstExitEngineState {
  return {
    schemaVersion: 1,
    phase: 'OBSERVING',
    riskStartedAtMs: null,
    lastObservedAtMs: null,
    consecutiveRiskObservations: 0,
    evidenceFamilies: [],
  };
}

function favorableExcursionBps(context: MicroBurstExitContext, side: 'LONG' | 'SHORT'): number {
  const priceReturn =
    side === 'LONG'
      ? (context.peakPrice - context.entryPrice) / context.entryPrice
      : (context.entryPrice - context.troughPrice) / context.entryPrice;
  return Math.max(0, decimalReturnToBps(priceReturn));
}

function adverseExcursionBps(context: MicroBurstExitContext, side: 'LONG' | 'SHORT'): number {
  const priceReturn =
    side === 'LONG'
      ? (context.entryPrice - context.troughPrice) / context.entryPrice
      : (context.peakPrice - context.entryPrice) / context.entryPrice;
  return Math.max(0, decimalReturnToBps(priceReturn));
}

function currentFavorableReturnBps(context: MicroBurstExitContext, side: 'LONG' | 'SHORT'): number {
  const signedReturn = (context.currentPrice - context.entryPrice) / context.entryPrice;
  return decimalReturnToBps(side === 'LONG' ? signedReturn : -signedReturn);
}

function invalidPriceContract(context: MicroBurstExitContext): boolean {
  return [
    context.currentPrice,
    context.entryPrice,
    context.peakPrice,
    context.troughPrice,
    context.structuralInvalidationPrice,
    context.destinationPrice,
  ].some((price) => !Number.isFinite(price) || price <= 0);
}

function hardInvalidated(context: MicroBurstExitContext, side: 'LONG' | 'SHORT'): boolean {
  return side === 'LONG'
    ? context.currentPrice <= context.structuralInvalidationPrice
    : context.currentPrice >= context.structuralInvalidationPrice;
}

function targetReached(context: MicroBurstExitContext, side: 'LONG' | 'SHORT'): boolean {
  return side === 'LONG'
    ? context.currentPrice >= context.destinationPrice
    : context.currentPrice <= context.destinationPrice;
}

function breakEvenImprovesProtection(
  context: MicroBurstExitContext,
  side: 'LONG' | 'SHORT',
): boolean {
  if (context.currentStopPrice === null) return true;
  if (!Number.isFinite(context.currentStopPrice)) return false;
  return side === 'LONG'
    ? context.currentStopPrice < context.entryPrice
    : context.currentStopPrice > context.entryPrice;
}

function observationTime(context: MicroBurstExitContext): number {
  return Number.isFinite(context.observedAtMs)
    ? (context.observedAtMs as number)
    : Math.max(0, context.timeInTradeMs);
}

function closeTransition(
  state: MicroBurstExitEngineState,
  decision: MicroBurstExitDecision,
  observedAtMs: number,
): MicroBurstExitTransition {
  return {
    state: {
      ...state,
      phase: 'EXIT_CONFIRMED',
      lastObservedAtMs: observedAtMs,
      confirmedDecision: decision,
    },
    decision,
  };
}

function resetRiskState(observedAtMs: number): MicroBurstExitEngineState {
  return {
    ...initialMicroBurstExitEngineState(),
    lastObservedAtMs: observedAtMs,
  };
}

function sideAware(value: number, side: 'LONG' | 'SHORT'): number {
  return side === 'LONG' ? value : -value;
}

function structuralProgress(context: MicroBurstExitContext, side: 'LONG' | 'SHORT'): number {
  const fullPath = Math.abs(context.destinationPrice - context.entryPrice);
  if (!Number.isFinite(fullPath) || fullPath <= 0) return 0;
  const travelled =
    side === 'LONG'
      ? context.currentPrice - context.entryPrice
      : context.entryPrice - context.currentPrice;
  return Math.max(0, travelled / fullPath);
}

/**
 * Extract independent, causal evidence families. No peak-to-current callback is used: this is
 * deliberately not a trailing stop in disguise.
 */
export function collectMicroBurstExitEvidence(
  context: MicroBurstExitContext,
  config: MicroBurstConfig,
  side: 'LONG' | 'SHORT',
): MicroBurstExitEvidenceItem[] {
  const items: MicroBurstExitEvidenceItem[] = [];
  const rawMarket = context.marketEvidence;
  const marketEvidenceAgeMs = rawMarket ? observationTime(context) - rawMarket.observedAtMs : null;
  const market =
    rawMarket &&
    marketEvidenceAgeMs !== null &&
    Number.isFinite(marketEvidenceAgeMs) &&
    marketEvidenceAgeMs >= 0 &&
    marketEvidenceAgeMs <= config.exitIntelligenceMaxObservationGapMs
      ? rawMarket
      : null;

  const shortReturn = market?.shortHorizonReturnBps;
  const shortReturnAgainstSide =
    typeof shortReturn === 'number' && Number.isFinite(shortReturn)
      ? sideAware(shortReturn, side)
      : null;
  if (
    context.momentumDecayFlag ||
    (shortReturnAgainstSide !== null &&
      market !== null &&
      market !== undefined &&
      market.priceSampleCount >= 2 &&
      market.takerFlowGapFree &&
      shortReturnAgainstSide <= -config.exitMomentumReversalBps)
  ) {
    items.push({
      family: 'MOMENTUM_REVERSAL',
      score: 2,
      diagnostics: {
        explicitMomentumDecay: context.momentumDecayFlag,
        shortHorizonReturnBps: shortReturn,
        mediumHorizonReturnBps: market?.mediumHorizonReturnBps ?? null,
        sideAwareShortReturnBps: shortReturnAgainstSide,
      },
    });
  }

  if (market) {
    const totalTakerVolume = market.buyTakerVolume + market.sellTakerVolume;
    const rawFlowRatio =
      totalTakerVolume > 0
        ? (market.buyTakerVolume - market.sellTakerVolume) / totalTakerVolume
        : 0;
    const sideAwareFlowRatio = sideAware(rawFlowRatio, side);
    if (
      market.takerFlowWindowComplete &&
      market.takerFlowGapFree &&
      market.takerTradeCount >= config.exitFlowMinTrades &&
      sideAwareFlowRatio <= -config.exitFlowReversalRatio
    ) {
      items.push({
        family: 'TAKER_FLOW_REVERSAL',
        score: 2,
        diagnostics: {
          rawFlowRatio,
          sideAwareFlowRatio,
          tradeCount: market.takerTradeCount,
        },
      });
    }
  }

  const book = context.currentBookPressure;
  if (book?.status === 'HEALTHY') {
    const sideAwareBookPressure = sideAware(book.signedTopOfBookImbalance, side);
    const sideAwareBookSlope =
      book.imbalanceSlope === null ? null : sideAware(book.imbalanceSlope, side);
    const pressureReversed = sideAwareBookPressure <= -config.exitBookReversalImbalance;
    const slopeReversed =
      sideAwareBookSlope !== null && sideAwareBookSlope <= -config.exitBookReversalSlope;
    if (pressureReversed || slopeReversed) {
      items.push({
        family: 'BOOK_PRESSURE_REVERSAL',
        score: pressureReversed ? 2 : 1,
        diagnostics: {
          signedTopOfBookImbalance: book.signedTopOfBookImbalance,
          sideAwareBookPressure,
          imbalanceSlope: book.imbalanceSlope,
          sideAwareBookSlope,
        },
      });
    }
    if (book.temporalAbsorptionDetected && sideAwareBookPressure <= 0) {
      items.push({
        family: 'ABSORPTION',
        score: 1,
        diagnostics: { sideAwareBookPressure },
      });
    }
    if (book.temporalSweepDetected && sideAwareBookPressure <= 0) {
      items.push({
        family: 'LIQUIDITY_SWEEP',
        score: 2,
        diagnostics: { sideAwareBookPressure },
      });
    }
  }

  const progress = structuralProgress(context, side);
  if (
    progress >= config.exitStructuralExhaustionProgress &&
    currentFavorableReturnBps(context, side) > 0
  ) {
    items.push({
      family: 'STRUCTURAL_EXHAUSTION',
      score: 1,
      diagnostics: {
        structuralProgress: progress,
        threshold: config.exitStructuralExhaustionProgress,
      },
    });
  }

  if (
    context.timeInTradeMs >= config.exitMaxHoldMs * 0.7 &&
    currentFavorableReturnBps(context, side) <= 0
  ) {
    items.push({
      family: 'TIME_DECAY',
      score: 2,
      diagnostics: { timeInTradeMs: context.timeInTradeMs },
    });
  }

  return items;
}

function evidenceDiagnostics(items: MicroBurstExitEvidenceItem[]): Record<string, unknown> {
  return {
    evidenceScore: items.reduce((sum, item) => sum + item.score, 0),
    evidenceFamilies: items.map((item) => item.family),
    evidence: Object.fromEntries(items.map((item) => [item.family, item.diagnostics])),
  };
}

/** Pure reducer used identically by SHADOW, offline simulation and the fail-closed LIVE adapter. */
export function advanceMicroBurstExit(
  previousState: MicroBurstExitEngineState,
  context: MicroBurstExitContext,
  config: MicroBurstConfig,
  side: 'LONG' | 'SHORT',
): MicroBurstExitTransition {
  const observedAtMs = observationTime(context);
  if (previousState.phase === 'EXIT_CONFIRMED' && previousState.confirmedDecision) {
    return { state: previousState, decision: previousState.confirmedDecision };
  }

  if (!invalidPriceContract(context) && hardInvalidated(context, side)) {
    return closeTransition(
      previousState,
      {
        action: 'CLOSE_MARKET',
        reason: 'HARD_INVALIDATION',
        diagnostics: {
          currentPrice: context.currentPrice,
          structuralInvalidationPrice: context.structuralInvalidationPrice,
        },
      },
      observedAtMs,
    );
  }

  if (
    invalidPriceContract(context) ||
    context.anomalyExitFlag ||
    (context.currentBookPressure !== null && context.currentBookPressure.status !== 'HEALTHY')
  ) {
    return closeTransition(
      previousState,
      {
        action: 'CLOSE_MARKET',
        reason: 'ANOMALY',
        diagnostics: {
          anomalyFlag: context.anomalyExitFlag,
          bookStatus: context.currentBookPressure?.status,
          invalidPriceContract: invalidPriceContract(context),
        },
      },
      observedAtMs,
    );
  }

  if (context.currentBtcContext?.conflictFlag) {
    return closeTransition(
      previousState,
      {
        action: 'CLOSE_MARKET',
        reason: 'BTC_REVERSAL',
        diagnostics: { btcConflict: true },
      },
      observedAtMs,
    );
  }

  const maxFavorableExcursionBps = favorableExcursionBps(context, side);
  const maxAdverseExcursionBps = adverseExcursionBps(context, side);
  const favorableReturnBps = currentFavorableReturnBps(context, side);

  if (
    context.timeInTradeMs < config.exitProofWindowMs &&
    maxAdverseExcursionBps >= config.exitImmediateAdverseBps
  ) {
    return closeTransition(
      previousState,
      {
        action: 'CLOSE_MARKET',
        reason: 'EARLY_FAILURE',
        diagnostics: {
          phase: 'IMMEDIATE_ADVERSE',
          maxAdverseExcursionBps,
          thresholdBps: config.exitImmediateAdverseBps,
        },
      },
      observedAtMs,
    );
  }

  if (targetReached(context, side)) {
    return closeTransition(
      previousState,
      {
        action: 'CLOSE_MARKET',
        reason: 'TARGET',
        diagnostics: {
          currentPrice: context.currentPrice,
          destinationPrice: context.destinationPrice,
        },
      },
      observedAtMs,
    );
  }

  const evidence = collectMicroBurstExitEvidence(context, config, side);
  const evidenceFamilies = [...new Set(evidence.map((item) => item.family))];
  const evidenceScore = evidence.reduce((sum, item) => sum + item.score, 0);
  const riskQualified =
    context.timeInTradeMs >= config.exitIntelligenceMinHoldMs &&
    evidenceFamilies.length >= config.exitIntelligenceMinEvidenceFamilies &&
    evidenceScore >= config.exitIntelligenceScoreThreshold;

  let nextState = resetRiskState(observedAtMs);
  if (riskQualified) {
    const priorFamilies = new Set(previousState.evidenceFamilies);
    const hasPersistentFamily = evidenceFamilies.some((family) => priorFamilies.has(family));
    const observationAdvanced =
      previousState.lastObservedAtMs !== null && observedAtMs > previousState.lastObservedAtMs;
    const observationGapMs =
      previousState.lastObservedAtMs === null
        ? Infinity
        : observedAtMs - previousState.lastObservedAtMs;
    const continuesArmedWindow =
      previousState.phase === 'ARMED' &&
      hasPersistentFamily &&
      observationAdvanced &&
      observationGapMs <= config.exitIntelligenceMaxObservationGapMs;
    const riskStartedAtMs = continuesArmedWindow
      ? (previousState.riskStartedAtMs ?? observedAtMs)
      : observedAtMs;
    const consecutiveRiskObservations = continuesArmedWindow
      ? previousState.consecutiveRiskObservations + 1
      : 1;

    nextState = {
      schemaVersion: 1,
      phase: 'ARMED',
      riskStartedAtMs,
      lastObservedAtMs: observationAdvanced
        ? observedAtMs
        : (previousState.lastObservedAtMs ?? observedAtMs),
      consecutiveRiskObservations,
      evidenceFamilies,
    };
    const confirmationElapsedMs = observedAtMs - riskStartedAtMs;
    if (
      consecutiveRiskObservations >= 2 &&
      confirmationElapsedMs >= config.exitIntelligenceConfirmationMs
    ) {
      const decision: MicroBurstExitDecision = {
        action: 'CLOSE_MARKET',
        reason: 'INTELLIGENT_EXIT',
        diagnostics: {
          ...evidenceDiagnostics(evidence),
          confirmationElapsedMs,
          consecutiveRiskObservations,
          noTrailingCallbackUsed: true,
        },
      };
      return closeTransition(nextState, decision, observedAtMs);
    }
  }

  // Break-even is a one-way protective stop, not the strategic exit algorithm.
  if (
    maxFavorableExcursionBps >= config.exitBreakEvenActivationBps &&
    favorableReturnBps > 0 &&
    breakEvenImprovesProtection(context, side)
  ) {
    return {
      state: nextState,
      decision: {
        action: 'MOVE_STOP',
        reason: 'BREAK_EVEN',
        requestedStopPrice: context.entryPrice,
        diagnostics: {
          maxFavorableExcursionBps,
          currentStopPrice: context.currentStopPrice,
          exitIntelligencePhase: nextState.phase,
        },
      },
    };
  }

  if (
    context.timeInTradeMs >= config.exitProofWindowMs &&
    maxFavorableExcursionBps < config.exitMinProofExcursionBps
  ) {
    return closeTransition(
      nextState,
      {
        action: 'CLOSE_MARKET',
        reason: 'EARLY_FAILURE',
        diagnostics: {
          phase: 'PROOF_WINDOW_EXPIRED',
          maxFavorableExcursionBps,
          thresholdBps: config.exitMinProofExcursionBps,
        },
      },
      observedAtMs,
    );
  }

  if (context.timeInTradeMs >= config.exitMaxHoldMs) {
    return closeTransition(
      nextState,
      {
        action: 'CLOSE_MARKET',
        reason: 'MAX_HOLD',
        diagnostics: { timeMs: context.timeInTradeMs },
      },
      observedAtMs,
    );
  }

  return {
    state: nextState,
    decision: {
      action: 'HOLD',
      reason: 'HOLD',
      diagnostics: {
        timeMs: context.timeInTradeMs,
        favorableReturnBps,
        maxFavorableExcursionBps,
        maxAdverseExcursionBps,
        exitIntelligencePhase: nextState.phase,
        ...evidenceDiagnostics(evidence),
      },
    },
  };
}

/** Single-observation guardrail evaluator retained for direct policy callers. */
export function evaluateMicroBurstExit(
  context: MicroBurstExitContext,
  config: MicroBurstConfig,
  side: 'LONG' | 'SHORT',
): MicroBurstExitDecision {
  return advanceMicroBurstExit(initialMicroBurstExitEngineState(), context, config, side).decision;
}

/** Holds per-trade hysteresis while keeping the reducer independently replayable. */
export class MicroBurstExitEngine {
  private readonly states = new Map<string, MicroBurstExitEngineState>();

  evaluate(
    tradeId: string,
    context: MicroBurstExitContext,
    config: MicroBurstConfig,
    side: 'LONG' | 'SHORT',
  ): MicroBurstExitDecision {
    const transition = advanceMicroBurstExit(
      this.states.get(tradeId) ?? initialMicroBurstExitEngineState(),
      context,
      config,
      side,
    );
    this.states.set(tradeId, transition.state);
    return transition.decision;
  }

  getState(tradeId: string): MicroBurstExitEngineState {
    return this.states.get(tradeId) ?? initialMicroBurstExitEngineState();
  }

  forget(tradeId: string): void {
    this.states.delete(tradeId);
  }
}
