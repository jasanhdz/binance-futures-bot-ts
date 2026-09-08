import {
  assessMicroBurstContinuation,
  captureMicroBurstExitBaseline,
  microBurstContinuationDiagnostics,
  MicroBurstExitBaseline,
  MicroBurstExitEvidenceSource,
  MicroBurstExitStage,
} from './MicroBurstExitIntelligence';
import {
  MicroBurstConfig,
  MicroBurstExitContext,
  MicroBurstExitDecision,
  validMicroBurstContextualConfig,
} from './MicroBurstTypes';

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
  /** V1 states remain readable and are normalized on restore. */
  schemaVersion: 1 | 2;
  phase: 'OBSERVING' | 'ARMED' | 'EXIT_CONFIRMED';
  stage?: MicroBurstExitStage;
  riskStartedAtMs: number | null;
  lastObservedAtMs: number | null;
  consecutiveRiskObservations: number;
  evidenceFamilies: MicroBurstExitEvidenceFamily[];
  evidenceSources?: MicroBurstExitEvidenceSource[];
  baseline?: MicroBurstExitBaseline;
  confirmedDecision?: MicroBurstExitDecision;
  contextual?: {
    peakPrice: number;
    troughPrice: number;
    blindSinceMs: number | null;
    extendedDestinationPrice?: number;
    lastEvidenceAtMs?: number;
    lastExecutableAtMs?: number;
  };
}

export interface MicroBurstExitTransition {
  state: MicroBurstExitEngineState;
  decision: MicroBurstExitDecision;
}

const EVIDENCE_FAMILIES = new Set<MicroBurstExitEvidenceFamily>([
  'MOMENTUM_REVERSAL',
  'TAKER_FLOW_REVERSAL',
  'BOOK_PRESSURE_REVERSAL',
  'ABSORPTION',
  'LIQUIDITY_SWEEP',
  'STRUCTURAL_EXHAUSTION',
  'TIME_DECAY',
]);

const EVIDENCE_SOURCES = new Set<MicroBurstExitEvidenceSource>([
  'PRICE',
  'FLOW',
  'BOOK',
  'BTC',
  'STRUCTURE_TIME',
]);

const EXIT_STAGES = new Set<MicroBurstExitStage>(['PROVING', 'RUNNING', 'PROTECTING', 'EXHAUSTED']);

export function initialMicroBurstExitEngineState(): MicroBurstExitEngineState {
  return {
    schemaVersion: 2,
    phase: 'OBSERVING',
    stage: 'PROVING',
    riskStartedAtMs: null,
    lastObservedAtMs: null,
    consecutiveRiskObservations: 0,
    evidenceFamilies: [],
    evidenceSources: [],
  };
}

function validFiniteNullable(value: unknown): boolean {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function validBaseline(value: unknown): value is MicroBurstExitBaseline {
  if (!value || typeof value !== 'object') return false;
  const baseline = value as Partial<MicroBurstExitBaseline>;
  return (
    typeof baseline.observedAtMs === 'number' &&
    Number.isFinite(baseline.observedAtMs) &&
    validFiniteNullable(baseline.sideAwareFlowRatio) &&
    validFiniteNullable(baseline.sideAwareBookPressure)
  );
}

export function isMicroBurstExitEngineState(value: unknown): value is MicroBurstExitEngineState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<MicroBurstExitEngineState>;
  const decision = state.confirmedDecision;
  const validDecision =
    decision === undefined ||
    (decision !== null &&
      typeof decision === 'object' &&
      (decision.action === 'HOLD' ||
        decision.action === 'CLOSE_MARKET' ||
        decision.action === 'MOVE_STOP') &&
      typeof decision.reason === 'string' &&
      decision.diagnostics !== null &&
      typeof decision.diagnostics === 'object' &&
      (decision.requestedStopPrice === undefined ||
        (Number.isFinite(decision.requestedStopPrice) && decision.requestedStopPrice > 0)));
  const evidenceSources = state.evidenceSources;
  return (
    (state.schemaVersion === 1 || state.schemaVersion === 2) &&
    (state.phase === 'OBSERVING' || state.phase === 'ARMED' || state.phase === 'EXIT_CONFIRMED') &&
    (state.stage === undefined || EXIT_STAGES.has(state.stage)) &&
    validFiniteNullable(state.riskStartedAtMs) &&
    validFiniteNullable(state.lastObservedAtMs) &&
    Number.isInteger(state.consecutiveRiskObservations) &&
    Number(state.consecutiveRiskObservations) >= 0 &&
    Array.isArray(state.evidenceFamilies) &&
    state.evidenceFamilies.every((family) => EVIDENCE_FAMILIES.has(family)) &&
    (evidenceSources === undefined ||
      (Array.isArray(evidenceSources) &&
        evidenceSources.every((source) => EVIDENCE_SOURCES.has(source)))) &&
    (state.baseline === undefined || validBaseline(state.baseline)) &&
    (state.contextual === undefined ||
      (state.contextual !== null &&
        typeof state.contextual === 'object' &&
        [state.contextual.peakPrice, state.contextual.troughPrice].every(
          (v) => Number.isFinite(v) && v > 0,
        ) &&
        state.contextual.peakPrice >= state.contextual.troughPrice &&
        validFiniteNullable(state.contextual.blindSinceMs) &&
        (state.contextual.blindSinceMs === null || state.contextual.blindSinceMs >= 0) &&
        [state.contextual.lastEvidenceAtMs, state.contextual.lastExecutableAtMs].every(
          (v) => v === undefined || (Number.isFinite(v) && v >= 0),
        ) &&
        (state.contextual.extendedDestinationPrice === undefined ||
          (Number.isFinite(state.contextual.extendedDestinationPrice) &&
            state.contextual.extendedDestinationPrice > 0)))) &&
    (state.riskStartedAtMs === null ||
      state.lastObservedAtMs === null ||
      (typeof state.riskStartedAtMs === 'number' &&
        typeof state.lastObservedAtMs === 'number' &&
        state.riskStartedAtMs <= state.lastObservedAtMs)) &&
    (state.phase === 'EXIT_CONFIRMED'
      ? decision?.action === 'CLOSE_MARKET'
      : decision === undefined) &&
    validDecision
  );
}

function normalizeState(state: MicroBurstExitEngineState): MicroBurstExitEngineState {
  return {
    ...state,
    schemaVersion: 2,
    stage: state.stage ?? 'PROVING',
    evidenceSources: state.evidenceSources ?? [],
  };
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
      schemaVersion: 2,
      phase: 'EXIT_CONFIRMED',
      lastObservedAtMs: observedAtMs,
      confirmedDecision: decision,
    },
    decision,
  };
}

function resetRiskState(
  observedAtMs: number,
  stage: MicroBurstExitStage,
  baseline: MicroBurstExitBaseline,
): MicroBurstExitEngineState {
  return {
    schemaVersion: 2,
    phase: 'OBSERVING',
    stage,
    riskStartedAtMs: null,
    lastObservedAtMs: observedAtMs,
    consecutiveRiskObservations: 0,
    evidenceFamilies: [],
    evidenceSources: [],
    baseline,
  };
}

function enrichBaseline(
  existing: MicroBurstExitBaseline | undefined,
  captured: MicroBurstExitBaseline,
): MicroBurstExitBaseline {
  if (!existing) return captured;
  return {
    observedAtMs: existing.observedAtMs,
    sideAwareFlowRatio: existing.sideAwareFlowRatio ?? captured.sideAwareFlowRatio,
    sideAwareBookPressure: existing.sideAwareBookPressure ?? captured.sideAwareBookPressure,
  };
}

function sourceToFamily(source: MicroBurstExitEvidenceSource): MicroBurstExitEvidenceFamily {
  switch (source) {
    case 'PRICE':
      return 'MOMENTUM_REVERSAL';
    case 'FLOW':
      return 'TAKER_FLOW_REVERSAL';
    case 'BOOK':
      return 'BOOK_PRESSURE_REVERSAL';
    case 'BTC':
      return 'MOMENTUM_REVERSAL';
    case 'STRUCTURE_TIME':
      return 'TIME_DECAY';
  }
}

/**
 * Compatibility evidence view. The intelligent reducer counts causal sources; correlated book
 * sub-signals remain visible here for research diagnostics but never become independent votes.
 */
export function collectMicroBurstExitEvidence(
  context: MicroBurstExitContext,
  config: MicroBurstConfig,
  side: 'LONG' | 'SHORT',
): MicroBurstExitEvidenceItem[] {
  const assessment = assessMicroBurstContinuation(context, config, side);
  const items: MicroBurstExitEvidenceItem[] = assessment.sources
    .filter((source) => source.disposition === 'ADVERSE')
    .map((source) => ({
      family:
        source.source === 'STRUCTURE_TIME' &&
        assessment.structuralProgress >= config.exitStructuralExhaustionProgress
          ? 'STRUCTURAL_EXHAUSTION'
          : sourceToFamily(source.source),
      score: source.evidenceScore,
      diagnostics: {
        causalSource: source.source,
        reversalFromBaseline: source.reversalFromBaseline,
        ...source.diagnostics,
      },
    }));
  const book = context.currentBookPressure;
  if (book?.status === 'HEALTHY' && book.temporalAbsorptionDetected)
    items.push({
      family: 'ABSORPTION',
      score: 0,
      diagnostics: { causalSource: 'BOOK', correlatedDiagnosticOnly: true },
    });
  if (book?.status === 'HEALTHY' && book.temporalSweepDetected)
    items.push({
      family: 'LIQUIDITY_SWEEP',
      score: 0,
      diagnostics: { causalSource: 'BOOK', correlatedDiagnosticOnly: true },
    });
  if (
    assessment.structuralProgress >= config.exitStructuralExhaustionProgress &&
    assessment.grossReturnBps > 0 &&
    !items.some((item) => item.family === 'STRUCTURAL_EXHAUSTION')
  )
    items.push({
      family: 'STRUCTURAL_EXHAUSTION',
      score: 1,
      diagnostics: {
        causalSource: 'STRUCTURE_TIME',
        structuralProgress: assessment.structuralProgress,
        standaloneExitAllowed: false,
      },
    });
  return items;
}

export function classifyMicroBurstStopExitReason(
  stopPrice: number,
  entryPrice: number,
  side: 'LONG' | 'SHORT',
): 'HARD_INVALIDATION' | 'BREAK_EVEN' | 'PROFIT_LOCK' {
  if (stopPrice === entryPrice) return 'BREAK_EVEN';
  const protectsProfit = side === 'LONG' ? stopPrice > entryPrice : stopPrice < entryPrice;
  return protectsProfit ? 'PROFIT_LOCK' : 'HARD_INVALIDATION';
}

function stopImproves(
  requestedStop: number,
  currentStop: number | null,
  side: 'LONG' | 'SHORT',
  minImprovementBps: number,
): boolean {
  if (currentStop === null) return true;
  if (!Number.isFinite(currentStop) || currentStop <= 0) return false;
  const tolerance = Math.max(Math.abs(currentStop) * 1e-10, Number.EPSILON);
  const improvesDirection =
    side === 'LONG'
      ? requestedStop - currentStop > tolerance
      : currentStop - requestedStop > tolerance;
  const improvementBps = (Math.abs(requestedStop - currentStop) / currentStop) * 10_000;
  return improvesDirection && improvementBps >= minImprovementBps;
}

function profitLockStop(
  context: MicroBurstExitContext,
  config: MicroBurstConfig,
  side: 'LONG' | 'SHORT',
  grossReturnBps: number,
  progress: number,
  assessment?: ReturnType<typeof assessMicroBurstContinuation>,
): { stop: number; protectedBps: number; milestone: 'COST_COVER' | 'STRUCTURAL_PROGRESS' } | null {
  if (
    config.contextualPolicyVersion &&
    (context.currentStopPrice === null ||
      !Number.isFinite(context.currentStopPrice) ||
      context.currentStopPrice <= 0)
  )
    return null;
  const costFloorBps = config.exitEstimatedRoundTripCostBps + config.exitCostCoverBufferBps;
  const targetPathBps =
    (Math.abs(context.destinationPrice - context.entryPrice) / context.entryPrice) * 10_000;
  let protectedBps = 0;
  let milestone: 'COST_COVER' | 'STRUCTURAL_PROGRESS' = 'COST_COVER';
  if (grossReturnBps >= config.exitBreakEvenActivationBps) protectedBps = costFloorBps;
  if (progress >= config.exitStructuralExhaustionProgress) {
    const structuralLockBps = targetPathBps * config.exitStructuralLockProgress;
    if (structuralLockBps > protectedBps) {
      protectedBps = structuralLockBps;
      milestone = 'STRUCTURAL_PROGRESS';
    }
  }
  if (config.contextualPolicyVersion && assessment && context.executableEconomics) {
    const mfe = assessment.maxFavorableExcursionBps;
    const noise = Math.max(
      config.exitProtectionMinDistanceBps,
      context.executableEconomics.volatilityBps,
    );
    // Strong independent continuation gets more room; neither path widens an existing stop.
    const tolerance = Math.min(
      assessment.entryRiskBps,
      Math.max(
        noise,
        mfe *
          (assessment.continuationEligible
            ? 1 - config.exitStructuralLockProgress
            : config.exitStructuralLockProgress),
      ),
    );
    protectedBps =
      mfe >= config.exitBreakEvenActivationBps ? Math.max(costFloorBps, mfe - tolerance) : 0;
    if (grossReturnBps - protectedBps < noise) return null;
  }
  if (protectedBps <= 0) return null;
  if (grossReturnBps - protectedBps < config.exitProtectionMinDistanceBps) return null;
  const direction = side === 'LONG' ? 1 : -1;
  const stop = context.entryPrice * (1 + (direction * protectedBps) / 10_000);
  if (
    !Number.isFinite(stop) ||
    stop <= 0 ||
    !stopImproves(stop, context.currentStopPrice, side, config.exitProtectionMinDistanceBps)
  )
    return null;
  return { stop, protectedBps, milestone };
}

function policyDiagnostics(
  assessment: ReturnType<typeof assessMicroBurstContinuation>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { ...microBurstContinuationDiagnostics(assessment), ...extra };
}

/** Pure reducer shared by SHADOW, offline simulation and the fail-closed LIVE adapter. */
function advanceMicroBurstExitPolicy(
  rawPreviousState: MicroBurstExitEngineState,
  context: MicroBurstExitContext,
  config: MicroBurstConfig,
  side: 'LONG' | 'SHORT',
): MicroBurstExitTransition {
  const previousState = normalizeState(rawPreviousState);
  const observedAtMs = observationTime(context);
  if (previousState.phase === 'EXIT_CONFIRMED' && previousState.confirmedDecision)
    return { state: previousState, decision: previousState.confirmedDecision };

  const invalidPrices = invalidPriceContract(context);
  if (!invalidPrices && hardInvalidated(context, side)) {
    return closeTransition(
      previousState,
      {
        action: 'CLOSE_MARKET',
        reason: 'HARD_INVALIDATION',
        diagnostics: {
          exitPolicyVersion: 'EXPECTED_CONTINUATION_V2',
          currentPrice: context.currentPrice,
          structuralInvalidationPrice: context.structuralInvalidationPrice,
        },
      },
      observedAtMs,
    );
  }

  const realBookAnomaly =
    context.currentBookPressure?.status === 'ANOMALOUS' ||
    context.currentBookPressure?.anomalyFlag === true;
  if (invalidPrices || context.anomalyExitFlag || realBookAnomaly) {
    return closeTransition(
      previousState,
      {
        action: 'CLOSE_MARKET',
        reason: 'ANOMALY',
        diagnostics: {
          exitPolicyVersion: 'EXPECTED_CONTINUATION_V2',
          anomalyFlag: context.anomalyExitFlag,
          bookStatus: context.currentBookPressure?.status ?? null,
          bookAnomalyFlag: context.currentBookPressure?.anomalyFlag ?? null,
          invalidPriceContract: invalidPrices,
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
          exitPolicyVersion: 'EXPECTED_CONTINUATION_V2',
          currentPrice: context.currentPrice,
          destinationPrice: context.destinationPrice,
        },
      },
      observedAtMs,
    );
  }

  const capturedBaseline = captureMicroBurstExitBaseline(context, config, side);
  const baseline = enrichBaseline(previousState.baseline, capturedBaseline);
  const assessment = assessMicroBurstContinuation(context, config, side, baseline);
  const legacyEvidence = collectMicroBurstExitEvidence(context, config, side);
  const evidenceFamilies = [...new Set(legacyEvidence.map((item) => item.family))];
  const adverseSources = assessment.adverseSources;
  const adaptiveAdverseThresholdBps = Math.max(
    config.exitImmediateAdverseBps,
    Math.min(
      config.exitImmediateAdverseMaxBps,
      assessment.entryRiskBps * config.exitImmediateAdverseRiskFraction,
    ),
  );

  if (
    context.timeInTradeMs < config.exitProofWindowMs &&
    assessment.grossReturnBps <= -adaptiveAdverseThresholdBps &&
    adverseSources.length >= config.exitIntelligenceMinEvidenceFamilies &&
    adverseSources.includes('PRICE') &&
    assessment.fastAdverseSource &&
    assessment.exitPressure >= config.exitIntelligenceExitPressureThreshold
  ) {
    return closeTransition(
      { ...previousState, baseline, stage: assessment.stage },
      {
        action: 'CLOSE_MARKET',
        reason: 'EARLY_FAILURE',
        diagnostics: policyDiagnostics(assessment, {
          phase: 'CORROBORATED_IMMEDIATE_ADVERSE',
          adaptiveAdverseThresholdBps,
        }),
      },
      observedAtMs,
    );
  }

  const pressureThreshold =
    assessment.estimatedNetReturnBps > 0
      ? config.exitWinnerExitPressureThreshold
      : config.exitIntelligenceExitPressureThreshold;
  const riskQualified =
    context.timeInTradeMs >= config.exitIntelligenceMinHoldMs &&
    adverseSources.length >= config.exitIntelligenceMinEvidenceFamilies &&
    assessment.evidenceScore >= config.exitIntelligenceScoreThreshold &&
    assessment.fastAdverseSource &&
    assessment.exitPressure >= pressureThreshold;
  const nonAdvancingObservation =
    previousState.lastObservedAtMs !== null && observedAtMs <= previousState.lastObservedAtMs;
  let nextState = nonAdvancingObservation
    ? previousState
    : resetRiskState(observedAtMs, assessment.stage, baseline);

  if (riskQualified && !nonAdvancingObservation) {
    const priorSources = new Set(previousState.evidenceSources ?? []);
    const hasPersistentSource = adverseSources.some((source) => priorSources.has(source));
    const observationGapMs =
      previousState.lastObservedAtMs === null
        ? Infinity
        : observedAtMs - previousState.lastObservedAtMs;
    const continuesArmedWindow =
      previousState.phase === 'ARMED' &&
      hasPersistentSource &&
      observationGapMs > 0 &&
      observationGapMs <= config.exitIntelligenceMaxObservationGapMs;
    const riskStartedAtMs = continuesArmedWindow
      ? (previousState.riskStartedAtMs ?? observedAtMs)
      : observedAtMs;
    const consecutiveRiskObservations = continuesArmedWindow
      ? previousState.consecutiveRiskObservations + 1
      : 1;
    nextState = {
      schemaVersion: 2,
      phase: 'ARMED',
      stage: assessment.stage,
      riskStartedAtMs,
      lastObservedAtMs: observedAtMs,
      consecutiveRiskObservations,
      evidenceFamilies,
      evidenceSources: adverseSources,
      baseline,
    };
    const confirmationElapsedMs = observedAtMs - riskStartedAtMs;
    if (
      consecutiveRiskObservations >= 2 &&
      confirmationElapsedMs >= config.exitIntelligenceConfirmationMs
    ) {
      const confirmedBtcReversal =
        adverseSources.includes('BTC') && context.currentBtcContext?.conflictFlag === true;
      const decision: MicroBurstExitDecision = {
        action: 'CLOSE_MARKET',
        reason: confirmedBtcReversal ? 'BTC_REVERSAL' : 'INTELLIGENT_EXIT',
        diagnostics: policyDiagnostics(assessment, {
          confirmationElapsedMs,
          consecutiveRiskObservations,
          pressureThreshold,
          persistentCausalSources: adverseSources,
        }),
      };
      return closeTransition(nextState, decision, observedAtMs);
    }
  }

  const profitLock = profitLockStop(
    context,
    config,
    side,
    assessment.grossReturnBps,
    assessment.structuralProgress,
    assessment,
  );
  if (profitLock) {
    return {
      state: nextState,
      decision: {
        action: 'MOVE_STOP',
        reason: 'PROFIT_LOCK',
        requestedStopPrice: profitLock.stop,
        diagnostics: policyDiagnostics(assessment, {
          protectionMilestone: profitLock.milestone,
          protectedGrossBps: profitLock.protectedBps,
          estimatedProtectedNetBps: profitLock.protectedBps - config.exitEstimatedRoundTripCostBps,
          currentStopPrice: context.currentStopPrice,
          exitIntelligencePhase: nextState.phase,
        }),
      },
    };
  }

  const proofExpired = context.timeInTradeMs >= config.exitProofWindowMs;
  const proofExtensionExpired =
    context.timeInTradeMs >= config.exitProofWindowMs + config.exitProofExtensionMs;
  if (
    proofExpired &&
    assessment.maxFavorableExcursionBps < config.exitMinProofExcursionBps &&
    (proofExtensionExpired || !assessment.continuationEligible)
  ) {
    return closeTransition(
      nextState,
      {
        action: 'CLOSE_MARKET',
        reason: 'EARLY_FAILURE',
        diagnostics: policyDiagnostics(assessment, {
          phase: proofExtensionExpired
            ? 'PROOF_EXTENSION_EXPIRED'
            : 'PROOF_WINDOW_EXPIRED_WITHOUT_CONTINUATION',
          proofThresholdBps: config.exitMinProofExcursionBps,
          proofExtensionMs: config.exitProofExtensionMs,
        }),
      },
      observedAtMs,
    );
  }

  if (context.timeInTradeMs >= config.exitMaxHoldMs) {
    const canExtendMaxHold =
      context.timeInTradeMs < config.exitMaxHoldMs + config.exitMaxHoldExtensionMs &&
      assessment.estimatedNetReturnBps > 0 &&
      assessment.continuationEligible;
    if (!canExtendMaxHold) {
      return closeTransition(
        nextState,
        {
          action: 'CLOSE_MARKET',
          reason: 'MAX_HOLD',
          diagnostics: policyDiagnostics(assessment, {
            timeMs: context.timeInTradeMs,
            maxHoldExtensionMs: config.exitMaxHoldExtensionMs,
          }),
        },
        observedAtMs,
      );
    }
  }

  return {
    state: nextState,
    decision: {
      action: 'HOLD',
      reason: 'HOLD',
      diagnostics: policyDiagnostics(assessment, {
        timeMs: context.timeInTradeMs,
        exitIntelligencePhase: nextState.phase,
        riskQualified,
        pressureThreshold,
        proofExtensionActive:
          proofExpired &&
          assessment.maxFavorableExcursionBps < config.exitMinProofExcursionBps &&
          !proofExtensionExpired,
        maxHoldExtensionActive:
          context.timeInTradeMs >= config.exitMaxHoldMs &&
          context.timeInTradeMs < config.exitMaxHoldMs + config.exitMaxHoldExtensionMs,
      }),
    },
  };
}

/** Wall-clock bound also usable when no market context can be constructed. */
export function microBurstExitDeadline(
  enteredAtMs: number | undefined,
  now: number,
  config: MicroBurstConfig,
): MicroBurstExitDecision | null {
  if (
    !Number.isFinite(enteredAtMs) ||
    !Number.isFinite(now) ||
    enteredAtMs! > now ||
    enteredAtMs! < 0
  )
    return null;
  const elapsed = now - enteredAtMs!;
  if (elapsed < config.exitMaxHoldMs + config.exitMaxHoldExtensionMs) return null;
  return {
    action: 'CLOSE_MARKET',
    reason: 'MAX_HOLD',
    diagnostics: {
      exitPolicyVersion: 'CONTEXTUAL_V3',
      timeMs: elapsed,
      deadlineIndependentOfMarket: true,
      estimatedNetReturnBps: null,
    },
  };
}

/** Versioned opt-in wrapper. Legacy callers and persisted V1/V2 states remain readable. */
export function advanceMicroBurstExit(
  previous: MicroBurstExitEngineState,
  context: MicroBurstExitContext,
  config: MicroBurstConfig,
  side: 'LONG' | 'SHORT',
): MicroBurstExitTransition {
  if (!config.contextualPolicyVersion)
    return advanceMicroBurstExitPolicy(previous, context, config, side);
  if (previous.phase === 'EXIT_CONFIRMED' && previous.confirmedDecision)
    return { state: previous, decision: previous.confirmedDecision };
  const now = context.observedAtMs ?? NaN;
  const trace = (transition: MicroBurstExitTransition): MicroBurstExitTransition => {
    const decision: MicroBurstExitDecision = {
      ...transition.decision,
      diagnostics: {
        ...transition.decision.diagnostics,
        exitPolicyVersion: 'CONTEXTUAL_V3',
        scoreIsProbability: false,
        observedAtMs: Number.isFinite(now) ? now : null,
        evidenceObservedAtMs: context.marketEvidence?.observedAtMs ?? null,
        executableObservedAtMs: context.executableEconomics?.observedAtMs ?? null,
        flowGapFree: context.marketEvidence?.takerFlowGapFree ?? null,
        inputs: structuredClone(context),
      },
    };
    return {
      state: {
        ...transition.state,
        ...(transition.state.phase === 'EXIT_CONFIRMED' ? { confirmedDecision: decision } : {}),
      },
      decision,
    };
  };
  const close = (
    reason: MicroBurstExitDecision['reason'],
    diagnostics: Record<string, unknown> = {},
  ) =>
    trace(
      closeTransition(
        previous,
        { action: 'CLOSE_MARKET', reason, diagnostics },
        Number.isFinite(now) ? now : (previous.lastObservedAtMs ?? 0),
      ),
    );
  if (!validMicroBurstContextualConfig(config))
    return close('ANOMALY', { invalidPolicyConfig: true });
  if (!Number.isFinite(now) || !Number.isFinite(context.timeInTradeMs) || context.timeInTradeMs < 0)
    return close('ANOMALY', { invalidClock: true });
  // Emergency facts and the absolute clock take precedence over protection or extensions.
  if (
    Number.isFinite(context.currentPrice) &&
    context.currentPrice > 0 &&
    Number.isFinite(context.structuralInvalidationPrice) &&
    context.structuralInvalidationPrice > 0 &&
    hardInvalidated(context, side)
  )
    return close('HARD_INVALIDATION');
  if (
    context.anomalyExitFlag ||
    context.currentBookPressure?.status === 'ANOMALOUS' ||
    context.currentBookPressure?.anomalyFlag
  )
    return close('ANOMALY');
  const deadline = microBurstExitDeadline(now - context.timeInTradeMs, now, config);
  if (deadline) return trace(closeTransition(previous, deadline, now));
  const direction = side === 'LONG' ? 1 : -1;
  if (
    ![context.entryPrice, context.structuralInvalidationPrice, context.destinationPrice].every(
      (v) => Number.isFinite(v) && v > 0,
    ) ||
    direction * (context.entryPrice - context.structuralInvalidationPrice) <= 0 ||
    direction * (context.destinationPrice - context.entryPrice) <= 0
  )
    return close('ANOMALY', { invalidStructuralGeometry: true });
  const economics = context.executableEconomics;
  const fresh =
    economics &&
    economics.quantityCovered &&
    [
      economics.exitPrice,
      economics.observedAtMs,
      economics.residualCostBps,
      economics.volatilityBps,
    ].every(Number.isFinite) &&
    economics.exitPrice > 0 &&
    economics.residualCostBps >= config.exitEstimatedRoundTripCostBps &&
    economics.volatilityBps >= 0 &&
    economics.observedAtMs <= now &&
    now - economics.observedAtMs <= config.exitIntelligenceMaxObservationGapMs;
  const tracked = previous.contextual ?? {
    peakPrice: context.entryPrice,
    troughPrice: context.entryPrice,
    blindSinceMs: null,
  };
  if (!fresh) {
    const blindSinceMs = tracked.blindSinceMs ?? now;
    if (now - blindSinceMs >= config.exitIntelligenceMaxObservationGapMs)
      return close('ANOMALY', { executableEconomicsUnavailable: true, blindSinceMs });
    return trace({
      state: {
        ...previous,
        phase: 'OBSERVING',
        riskStartedAtMs: null,
        consecutiveRiskObservations: 0,
        evidenceFamilies: [],
        evidenceSources: [],
        contextual: { ...tracked, blindSinceMs },
      },
      decision: {
        action: 'HOLD',
        reason: 'HOLD',
        diagnostics: {
          executableEconomicsUnavailable: true,
          blindSinceMs,
          estimatedNetReturnBps: null,
        },
      },
    });
  }
  if (
    side === 'LONG'
      ? economics.exitPrice <= context.structuralInvalidationPrice
      : economics.exitPrice >= context.structuralInvalidationPrice
  )
    return close('HARD_INVALIDATION', { executableInvalidation: true });
  if (
    context.currentStopPrice !== null &&
    Number.isFinite(context.currentStopPrice) &&
    context.currentStopPrice > 0 &&
    (side === 'LONG'
      ? economics.exitPrice <= context.currentStopPrice
      : economics.exitPrice >= context.currentStopPrice)
  )
    return close(
      classifyMicroBurstStopExitReason(context.currentStopPrice, context.entryPrice, side),
      { knownStopCrossed: true },
    );
  if (previous.lastObservedAtMs !== null && now <= previous.lastObservedAtMs)
    return trace({
      state: previous,
      decision: { action: 'HOLD', reason: 'HOLD', diagnostics: { nonAdvancingObservation: true } },
    });
  if (
    tracked.lastExecutableAtMs !== undefined &&
    economics.observedAtMs <= tracked.lastExecutableAtMs &&
    (context.marketEvidence?.observedAtMs ?? 0) <= (tracked.lastEvidenceAtMs ?? 0)
  )
    return trace({
      state: previous,
      decision: { action: 'HOLD', reason: 'HOLD', diagnostics: { nonAdvancingEvidence: true } },
    });
  const trackedNext = {
    ...tracked,
    blindSinceMs: null,
    lastExecutableAtMs: economics.observedAtMs,
    lastEvidenceAtMs: context.marketEvidence?.observedAtMs ?? tracked.lastEvidenceAtMs,
    peakPrice: Math.max(tracked.peakPrice, economics.exitPrice),
    troughPrice: Math.min(tracked.troughPrice, economics.exitPrice),
  };
  let executable = {
    ...context,
    currentPrice: economics.exitPrice,
    peakPrice: trackedNext.peakPrice,
    troughPrice: trackedNext.troughPrice,
    destinationPrice: tracked.extendedDestinationPrice ?? context.destinationPrice,
  };
  const effectiveConfig = { ...config, exitEstimatedRoundTripCostBps: economics.residualCostBps };
  const assessment = assessMicroBurstContinuation(
    executable,
    effectiveConfig,
    side,
    previous.baseline,
  );
  if (
    context.timeInTradeMs >= config.exitMaxHoldMs &&
    !(assessment.estimatedNetReturnBps > 0 && assessment.continuationEligible)
  )
    return close('MAX_HOLD');
  if (
    context.timeInTradeMs >= config.exitProofWindowMs + config.exitProofExtensionMs &&
    assessment.maxFavorableExcursionBps < config.exitMinProofExcursionBps
  )
    return close('EARLY_FAILURE', { proofExtensionExpired: true });
  const obstacle = context.nextConfirmedObstacle;
  const sign = side === 'LONG' ? 1 : -1;
  if (
    targetReached(executable, side) &&
    !tracked.extendedDestinationPrice &&
    assessment.continuationEligible &&
    assessment.estimatedNetReturnBps > 0 &&
    obstacle &&
    Number.isFinite(obstacle.availableAtMs) &&
    obstacle.availableAtMs >= 0 &&
    obstacle.availableAtMs < now &&
    Number.isFinite(obstacle.price) &&
    obstacle.price > 0
  ) {
    const bounded = obstacle.price * (1 - (sign * config.exitCostCoverBufferBps) / 10_000);
    const room = ((sign * (bounded - economics.exitPrice)) / economics.exitPrice) * 10_000;
    if (
      room >= config.minRoomBps + economics.residualCostBps &&
      sign * (bounded - context.destinationPrice) > 0
    ) {
      trackedNext.extendedDestinationPrice = bounded;
      executable = { ...executable, destinationPrice: bounded };
    }
  }
  const marketAt = context.marketEvidence?.observedAtMs ?? -Infinity;
  const repeatedMarket =
    tracked.lastEvidenceAtMs !== undefined && marketAt <= tracked.lastEvidenceAtMs;
  const marketGap =
    tracked.lastEvidenceAtMs !== undefined &&
    marketAt - tracked.lastEvidenceAtMs > config.exitIntelligenceMaxObservationGapMs;
  // Fresh quotes alone cannot turn the same price/flow window into independent confirmations.
  const evidencePrevious = marketGap
    ? {
        ...previous,
        phase: 'OBSERVING' as const,
        riskStartedAtMs: null,
        consecutiveRiskObservations: 0,
        evidenceFamilies: [],
        evidenceSources: [],
      }
    : repeatedMarket
      ? { ...previous, lastObservedAtMs: now }
      : previous;
  const transition = advanceMicroBurstExitPolicy(
    evidencePrevious,
    executable,
    effectiveConfig,
    side,
  );
  return trace({ ...transition, state: { ...transition.state, contextual: trackedNext } });
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

  restore(tradeId: string, state: MicroBurstExitEngineState): void {
    this.states.set(tradeId, normalizeState(state));
  }

  forget(tradeId: string): void {
    this.states.delete(tradeId);
  }
}
