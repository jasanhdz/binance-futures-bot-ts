import {
  assessMicroBurstContinuation,
  captureMicroBurstExitBaseline,
  MicroBurstExitBaseline,
  MicroBurstExitEvidenceSource,
} from '../domain/MicroBurstExitIntelligence';
import {
  defaultMicroBurstConfig,
  MicroBurstConfig,
  MicroBurstExitContext,
  MicroBurstExitDecision,
  validMicroBurstContextualConfig,
} from '../domain/MicroBurstTypes';
import {
  advanceMicroBurstExit,
  classifyMicroBurstStopExitReason,
  initialMicroBurstExitEngineState,
  MicroBurstExitEngineState,
} from '../domain/MicroBurstExitPolicy';

/** Research-only variant. It is not a runtime policy marker and has no LIVE adapter. */
export const MICRO_BURST_OFFLINE_EXIT_VARIANT = 'MICRO_OFFLINE_NO_TIME_CLOSE_V1' as const;

export interface MicroBurstOfflineExitState {
  schemaVersion: 2 | 3;
  phase: 'PROBING' | 'CONTINUING' | 'TOLERABLE_PULLBACK' | 'DETERIORATING' | 'CLOSING';
  stateSinceAtMs: number | null;
  strategicReevaluationAtMs: number | null;
  absoluteExposureDeadlineAtMs: number | null;
  riskStartedAtMs: number | null;
  lastObservedAtMs: number | null;
  lastEvidenceAtMs?: number;
  lastEconomicObservedAtMs: number | null;
  consecutiveRiskObservations: number;
  evidenceSources: MicroBurstExitEvidenceSource[];
  baseline?: MicroBurstExitBaseline;
  confirmedDecision?: MicroBurstExitDecision;
  protectionState?: MicroBurstExitEngineState;
}

export interface MicroBurstOfflineExitTransition {
  state: MicroBurstOfflineExitState;
  decision: MicroBurstExitDecision;
}

export function initialMicroBurstOfflineExitState(): MicroBurstOfflineExitState {
  return {
    schemaVersion: 3,
    phase: 'PROBING',
    stateSinceAtMs: null,
    strategicReevaluationAtMs: null,
    absoluteExposureDeadlineAtMs: null,
    riskStartedAtMs: null,
    lastObservedAtMs: null,
    lastEconomicObservedAtMs: null,
    consecutiveRiskObservations: 0,
    evidenceSources: [],
    protectionState: initialMicroBurstExitEngineState(),
  };
}

function validBaseline(value: unknown): value is MicroBurstExitBaseline {
  if (!value || typeof value !== 'object') return false;
  const baseline = value as Partial<MicroBurstExitBaseline>;
  return (
    Number.isFinite(baseline.observedAtMs) &&
    (baseline.sideAwareFlowRatio === null || Number.isFinite(baseline.sideAwareFlowRatio)) &&
    (baseline.sideAwareBookPressure === null || Number.isFinite(baseline.sideAwareBookPressure))
  );
}

export function isMicroBurstOfflineExitState(value: unknown): value is MicroBurstOfflineExitState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<MicroBurstOfflineExitState>;
  return (
    (state.schemaVersion as number) === 3 &&
    ['PROBING', 'CONTINUING', 'TOLERABLE_PULLBACK', 'DETERIORATING', 'CLOSING'].includes(
      state.phase ?? '',
    ) &&
    (state.riskStartedAtMs === null || Number.isFinite(state.riskStartedAtMs)) &&
    (state.lastObservedAtMs === null || Number.isFinite(state.lastObservedAtMs)) &&
    (state.stateSinceAtMs === null || Number.isFinite(state.stateSinceAtMs)) &&
    (state.strategicReevaluationAtMs === null ||
      Number.isFinite(state.strategicReevaluationAtMs)) &&
    (state.absoluteExposureDeadlineAtMs === null ||
      Number.isFinite(state.absoluteExposureDeadlineAtMs)) &&
    (state.lastEconomicObservedAtMs === null || Number.isFinite(state.lastEconomicObservedAtMs)) &&
    (state.lastEvidenceAtMs === undefined || Number.isFinite(state.lastEvidenceAtMs)) &&
    Number.isInteger(state.consecutiveRiskObservations) &&
    (state.consecutiveRiskObservations ?? -1) >= 0 &&
    Array.isArray(state.evidenceSources) &&
    state.evidenceSources.every((source) =>
      ['PRICE', 'FLOW', 'BOOK', 'BTC', 'STRUCTURE_TIME'].includes(source),
    ) &&
    (state.baseline === undefined || validBaseline(state.baseline)) &&
    (state.confirmedDecision === undefined ||
      (state.confirmedDecision.action === 'CLOSE_MARKET' &&
        typeof state.confirmedDecision.reason === 'string')) &&
    (state.protectionState === undefined || typeof state.protectionState === 'object')
  );
}

function observationTime(context: MicroBurstExitContext): number {
  return Number.isFinite(context.observedAtMs)
    ? (context.observedAtMs as number)
    : Math.max(0, context.timeInTradeMs);
}

function invalidPrices(context: MicroBurstExitContext): boolean {
  return [
    context.currentPrice,
    context.entryPrice,
    context.peakPrice,
    context.troughPrice,
    context.structuralInvalidationPrice,
    context.destinationPrice,
  ].some((value) => !Number.isFinite(value) || value <= 0);
}

function hardInvalidated(context: MicroBurstExitContext, side: 'LONG' | 'SHORT'): boolean {
  return side === 'LONG'
    ? context.currentPrice <= context.structuralInvalidationPrice
    : context.currentPrice >= context.structuralInvalidationPrice;
}

function stopCrossed(context: MicroBurstExitContext, side: 'LONG' | 'SHORT'): boolean {
  return (
    context.currentStopPrice !== null &&
    Number.isFinite(context.currentStopPrice) &&
    (side === 'LONG'
      ? context.currentPrice <= context.currentStopPrice
      : context.currentPrice >= context.currentStopPrice)
  );
}

function close(
  state: MicroBurstOfflineExitState,
  reason: MicroBurstExitDecision['reason'],
  observedAtMs: number,
  config: MicroBurstConfig,
  diagnostics: Record<string, unknown> = {},
): MicroBurstOfflineExitTransition {
  const decision: MicroBurstExitDecision = {
    action: 'CLOSE_MARKET',
    reason,
    diagnostics: {
      exitPolicyVersion: MICRO_BURST_OFFLINE_EXIT_VARIANT,
      strategicReevaluationMs: config.exitMaxHoldMs,
      absoluteExposureLimitMs: config.exitMaxHoldMs + config.exitMaxHoldExtensionMs,
      ...diagnostics,
    },
  };
  return {
    state: {
      ...state,
      phase: 'CLOSING',
      stateSinceAtMs: state.stateSinceAtMs ?? observedAtMs,
      lastObservedAtMs: observedAtMs,
      confirmedDecision: decision,
    },
    decision,
  };
}

function neutralState(
  state: MicroBurstOfflineExitState,
  observedAtMs: number,
  baseline: MicroBurstExitBaseline,
  phase: MicroBurstOfflineExitState['phase'] = 'PROBING',
  timing: { strategicReevaluationAtMs: number; absoluteExposureDeadlineAtMs: number },
  economicObservedAtMs: number | null = state.lastEconomicObservedAtMs,
): MicroBurstOfflineExitState {
  return {
    ...state,
    phase,
    stateSinceAtMs: state.phase === phase ? (state.stateSinceAtMs ?? observedAtMs) : observedAtMs,
    strategicReevaluationAtMs: state.strategicReevaluationAtMs ?? timing.strategicReevaluationAtMs,
    absoluteExposureDeadlineAtMs:
      state.absoluteExposureDeadlineAtMs ?? timing.absoluteExposureDeadlineAtMs,
    riskStartedAtMs: null,
    lastObservedAtMs: observedAtMs,
    lastEconomicObservedAtMs: economicObservedAtMs,
    consecutiveRiskObservations: 0,
    evidenceSources: [],
    baseline,
  };
}

function timing(
  context: MicroBurstExitContext,
  now: number,
  config: MicroBurstConfig,
): { strategicReevaluationAtMs: number; absoluteExposureDeadlineAtMs: number } {
  const enteredAtMs = now - context.timeInTradeMs;
  return {
    strategicReevaluationAtMs: enteredAtMs + config.exitMaxHoldMs,
    absoluteExposureDeadlineAtMs:
      enteredAtMs + config.exitMaxHoldMs + config.exitMaxHoldExtensionMs,
  };
}

function freshEconomics(context: MicroBurstExitContext, config: MicroBurstConfig, now: number) {
  const economics = context.executableEconomics;
  return Boolean(
    economics &&
      economics.quantityCovered &&
      [
        economics.observedAtMs,
        economics.exitPrice,
        economics.residualCostBps,
        economics.volatilityBps,
      ].every(Number.isFinite) &&
      economics.exitPrice > 0 &&
      economics.residualCostBps >= config.exitEstimatedRoundTripCostBps &&
      economics.volatilityBps >= 0 &&
      economics.observedAtMs <= now &&
      now - economics.observedAtMs <= config.exitIntelligenceMaxObservationGapMs,
  );
}

/**
 * Offline-only causal reducer. Five minutes is a strategic reevaluation point; the existing
 * six-minute bound remains an independent exposure limit. No time-only proof close is used.
 */
export function advanceMicroBurstOfflineExit(
  previous: MicroBurstOfflineExitState,
  context: MicroBurstExitContext,
  config: MicroBurstConfig = defaultMicroBurstConfig(),
  side: 'LONG' | 'SHORT',
): MicroBurstOfflineExitTransition {
  const now = observationTime(context);
  if (previous.phase === 'CLOSING' && previous.confirmedDecision)
    return { state: previous, decision: previous.confirmedDecision };
  if (!validMicroBurstContextualConfig(config))
    return close(previous, 'ANOMALY', now, config, { invalidPolicyConfig: true });
  if (!Number.isFinite(now) || context.timeInTradeMs < 0)
    return close(previous, 'ANOMALY', now, config, { invalidClock: true });
  if (invalidPrices(context))
    return close(previous, 'ANOMALY', now, config, { invalidPriceContract: true });
  if (hardInvalidated(context, side)) return close(previous, 'HARD_INVALIDATION', now, config);
  if (stopCrossed(context, side))
    return close(
      previous,
      classifyMicroBurstStopExitReason(context.currentStopPrice!, context.entryPrice, side),
      now,
      config,
      { knownStopCrossed: true },
    );

  const absoluteExposureLimitMs = config.exitMaxHoldMs + config.exitMaxHoldExtensionMs;
  if (context.timeInTradeMs >= absoluteExposureLimitMs)
    return close(previous, 'MAX_HOLD', now, config, {
      absoluteExposureLimit: true,
      timeMs: context.timeInTradeMs,
    });

  const trackedBaseline = previous.baseline;
  const baseline = trackedBaseline ?? captureMicroBurstExitBaseline(context, config, side);
  const deadlines = timing(context, now, config);
  const protectionConfig: MicroBurstConfig = { ...config, contextualPolicyVersion: 'MICRO' };
  const protectionTransition = advanceMicroBurstExit(
    previous.protectionState ?? initialMicroBurstExitEngineState(),
    context,
    protectionConfig,
    side,
  );
  if (protectionTransition.decision.action === 'MOVE_STOP') {
    return {
      state: {
        ...previous,
        schemaVersion: 3,
        protectionState: protectionTransition.state,
      },
      decision: {
        ...protectionTransition.decision,
        diagnostics: {
          ...protectionTransition.decision.diagnostics,
          exitPolicyVersion: MICRO_BURST_OFFLINE_EXIT_VARIANT,
          protectionPolicyVersion: 'EXPECTED_CONTINUATION_V2',
        },
      },
    };
  }
  const strategicProtectionReason = [
    'EARLY_FAILURE',
    'INTELLIGENT_EXIT',
    'BTC_REVERSAL',
    'MAX_HOLD',
  ];
  const protectionState = strategicProtectionReason.includes(protectionTransition.decision.reason)
    ? previous.protectionState
    : protectionTransition.state;
  const protectionPrevious = { ...previous, protectionState };
  if (
    protectionTransition.decision.action === 'CLOSE_MARKET' &&
    !strategicProtectionReason.includes(protectionTransition.decision.reason)
  ) {
    return {
      state: { ...protectionPrevious, schemaVersion: 3 },
      decision: {
        ...protectionTransition.decision,
        diagnostics: {
          ...protectionTransition.decision.diagnostics,
          exitPolicyVersion: MICRO_BURST_OFFLINE_EXIT_VARIANT,
          protectionPolicyVersion: 'EXPECTED_CONTINUATION_V2',
        },
      },
    };
  }
  if (
    context.anomalyExitFlag ||
    context.currentBookPressure?.status === 'ANOMALOUS' ||
    context.currentBookPressure?.anomalyFlag
  )
    return close(protectionPrevious, 'ANOMALY', now, config);
  if (!freshEconomics(context, config, now)) {
    return {
      state: {
        ...neutralState(protectionPrevious, now, baseline, 'PROBING', deadlines),
        schemaVersion: 3,
        protectionState: protectionPrevious.protectionState ?? initialMicroBurstExitEngineState(),
      },
      decision: {
        action: 'HOLD',
        reason: 'HOLD',
        diagnostics: {
          exitPolicyVersion: MICRO_BURST_OFFLINE_EXIT_VARIANT,
          executableEconomicsUnavailable: true,
          estimatedNetReturnBps: null,
          holdBasis: 'DATA_DEGRADED',
          strategicReevaluationDue: context.timeInTradeMs >= config.exitMaxHoldMs,
          absoluteExposureLimitMs,
        },
      },
    };
  }

  const economics = context.executableEconomics!;
  if (
    side === 'LONG'
      ? economics.exitPrice <= context.structuralInvalidationPrice
      : economics.exitPrice >= context.structuralInvalidationPrice
  )
    return close(protectionPrevious, 'HARD_INVALIDATION', now, config, {
      executableInvalidation: true,
    });
  const executableContext = {
    ...context,
    currentPrice: economics.exitPrice,
    destinationPrice: context.destinationPrice,
  };
  const assessment = assessMicroBurstContinuation(
    executableContext,
    { ...config, exitEstimatedRoundTripCostBps: economics.residualCostBps },
    side,
    baseline,
  );
  const riskQualified =
    context.timeInTradeMs >= config.exitIntelligenceMinHoldMs &&
    assessment.adverseSources.length >= config.exitIntelligenceMinEvidenceFamilies &&
    assessment.evidenceScore >= config.exitIntelligenceScoreThreshold &&
    assessment.fastAdverseSource &&
    assessment.exitPressure >=
      (assessment.estimatedNetReturnBps > 0
        ? config.exitWinnerExitPressureThreshold
        : config.exitIntelligenceExitPressureThreshold);
  const candidatePrevious = protectionPrevious;
  const evidenceAt = context.marketEvidence?.observedAtMs;
  const advancing =
    (candidatePrevious.lastObservedAtMs === null || now > candidatePrevious.lastObservedAtMs) &&
    Number.isFinite(evidenceAt) &&
    evidenceAt! <= now &&
    now - evidenceAt! <= config.exitIntelligenceMaxObservationGapMs &&
    (candidatePrevious.lastEvidenceAtMs === undefined ||
      evidenceAt! > candidatePrevious.lastEvidenceAtMs);
  if (!advancing) {
    return {
      state: candidatePrevious,
      decision: {
        action: 'HOLD',
        reason: 'HOLD',
        diagnostics: {
          exitPolicyVersion: MICRO_BURST_OFFLINE_EXIT_VARIANT,
          nonAdvancingEvidence: true,
          estimatedNetReturnBps: assessment.estimatedNetReturnBps,
        },
      },
    };
  }
  const sourcesPersist = assessment.adverseSources.some((source) =>
    candidatePrevious.evidenceSources.includes(source),
  );
  const gap =
    candidatePrevious.lastObservedAtMs === null
      ? Infinity
      : now - candidatePrevious.lastObservedAtMs;
  const continues =
    riskQualified &&
    advancing &&
    sourcesPersist &&
    gap > 0 &&
    gap <= config.exitIntelligenceMaxObservationGapMs;
  const nextRiskCount = continues
    ? candidatePrevious.consecutiveRiskObservations + 1
    : riskQualified && advancing
      ? 1
      : 0;
  const riskStartedAtMs = continues
    ? (candidatePrevious.riskStartedAtMs ?? now)
    : riskQualified && advancing
      ? now
      : null;
  const nextPhase: MicroBurstOfflineExitState['phase'] = riskQualified
    ? 'DETERIORATING'
    : assessment.continuationEligible
      ? 'CONTINUING'
      : assessment.estimatedNetReturnBps < 0 &&
          assessment.exitPressure < config.exitIntelligenceExitPressureThreshold
        ? 'TOLERABLE_PULLBACK'
        : 'PROBING';
  const phaseChanged = candidatePrevious.phase !== nextPhase;
  const riskState: MicroBurstOfflineExitState = {
    ...candidatePrevious,
    schemaVersion: 3,
    phase: nextPhase,
    stateSinceAtMs: phaseChanged ? now : (candidatePrevious.stateSinceAtMs ?? now),
    strategicReevaluationAtMs:
      candidatePrevious.strategicReevaluationAtMs ?? deadlines.strategicReevaluationAtMs,
    absoluteExposureDeadlineAtMs:
      candidatePrevious.absoluteExposureDeadlineAtMs ?? deadlines.absoluteExposureDeadlineAtMs,
    riskStartedAtMs,
    lastObservedAtMs: now,
    lastEvidenceAtMs: evidenceAt,
    lastEconomicObservedAtMs: economics.observedAtMs,
    consecutiveRiskObservations: nextRiskCount,
    evidenceSources: riskQualified ? assessment.adverseSources : [],
    baseline,
    protectionState: protectionTransition.state,
  };
  if (
    riskQualified &&
    nextRiskCount >= 2 &&
    now - (riskStartedAtMs ?? now) >= config.exitIntelligenceConfirmationMs
  )
    return close(riskState, 'INTELLIGENT_EXIT', now, config, {
      deteriorationConfirmed: true,
      confirmationElapsedMs: now - (riskStartedAtMs ?? now),
      consecutiveRiskObservations: nextRiskCount,
      persistentCausalSources: assessment.adverseSources,
      estimatedNetReturnBps: assessment.estimatedNetReturnBps,
    });

  return {
    state: riskState,
    decision: {
      action: 'HOLD',
      reason: 'HOLD',
      diagnostics: {
        exitPolicyVersion: MICRO_BURST_OFFLINE_EXIT_VARIANT,
        timeMs: context.timeInTradeMs,
        strategicReevaluationDue: context.timeInTradeMs >= config.exitMaxHoldMs,
        absoluteExposureLimitMs,
        holdBasis: assessment.continuationEligible
          ? 'CONTINUATION_EVIDENCE'
          : 'NEUTRAL_OR_INSUFFICIENT_EVIDENCE',
        continuationEligible: assessment.continuationEligible,
        riskQualified,
        estimatedNetReturnBps: assessment.estimatedNetReturnBps,
        adverseSources: assessment.adverseSources,
        supportiveSources: assessment.supportiveSources,
      },
    },
  };
}

export function evaluateMicroBurstOfflineExit(
  context: MicroBurstExitContext,
  config: MicroBurstConfig = defaultMicroBurstConfig(),
  side: 'LONG' | 'SHORT',
): MicroBurstExitDecision {
  return advanceMicroBurstOfflineExit(initialMicroBurstOfflineExitState(), context, config, side)
    .decision;
}
