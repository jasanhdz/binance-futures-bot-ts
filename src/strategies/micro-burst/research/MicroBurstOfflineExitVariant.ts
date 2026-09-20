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
import { classifyMicroBurstStopExitReason } from '../domain/MicroBurstExitPolicy';

/** Research-only variant. It is not a runtime policy marker and has no LIVE adapter. */
export const MICRO_BURST_OFFLINE_EXIT_VARIANT = 'MICRO_OFFLINE_NO_TIME_CLOSE_V1' as const;

export interface MicroBurstOfflineExitState {
  schemaVersion: 1;
  phase: 'OBSERVING' | 'ARMED' | 'EXIT_CONFIRMED';
  riskStartedAtMs: number | null;
  lastObservedAtMs: number | null;
  lastEvidenceAtMs?: number;
  consecutiveRiskObservations: number;
  evidenceSources: MicroBurstExitEvidenceSource[];
  baseline?: MicroBurstExitBaseline;
  confirmedDecision?: MicroBurstExitDecision;
}

export interface MicroBurstOfflineExitTransition {
  state: MicroBurstOfflineExitState;
  decision: MicroBurstExitDecision;
}

export function initialMicroBurstOfflineExitState(): MicroBurstOfflineExitState {
  return {
    schemaVersion: 1,
    phase: 'OBSERVING',
    riskStartedAtMs: null,
    lastObservedAtMs: null,
    consecutiveRiskObservations: 0,
    evidenceSources: [],
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
    state.schemaVersion === 1 &&
    ['OBSERVING', 'ARMED', 'EXIT_CONFIRMED'].includes(state.phase ?? '') &&
    (state.riskStartedAtMs === null || Number.isFinite(state.riskStartedAtMs)) &&
    (state.lastObservedAtMs === null || Number.isFinite(state.lastObservedAtMs)) &&
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
        typeof state.confirmedDecision.reason === 'string'))
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

function targetReached(price: number, context: MicroBurstExitContext, side: 'LONG' | 'SHORT') {
  return side === 'LONG' ? price >= context.destinationPrice : price <= context.destinationPrice;
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
      phase: 'EXIT_CONFIRMED',
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
): MicroBurstOfflineExitState {
  return {
    ...state,
    phase: 'OBSERVING',
    riskStartedAtMs: null,
    lastObservedAtMs: observedAtMs,
    consecutiveRiskObservations: 0,
    evidenceSources: [],
    baseline,
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
  if (previous.phase === 'EXIT_CONFIRMED' && previous.confirmedDecision)
    return { state: previous, decision: previous.confirmedDecision };
  if (!validMicroBurstContextualConfig(config))
    return close(previous, 'ANOMALY', now, config, { invalidPolicyConfig: true });
  if (!Number.isFinite(now) || context.timeInTradeMs < 0)
    return close(previous, 'ANOMALY', now, config, { invalidClock: true });
  if (invalidPrices(context))
    return close(previous, 'ANOMALY', now, config, { invalidPriceContract: true });
  if (hardInvalidated(context, side)) return close(previous, 'HARD_INVALIDATION', now, config);
  if (
    context.anomalyExitFlag ||
    context.currentBookPressure?.status === 'ANOMALOUS' ||
    context.currentBookPressure?.anomalyFlag
  )
    return close(previous, 'ANOMALY', now, config);
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
  if (!freshEconomics(context, config, now)) {
    return {
      state: neutralState(previous, now, baseline),
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
    return close(previous, 'HARD_INVALIDATION', now, config, { executableInvalidation: true });
  if (targetReached(economics.exitPrice, context, side)) {
    const netBps =
      (side === 'LONG'
        ? (economics.exitPrice - context.entryPrice) / context.entryPrice
        : (context.entryPrice - economics.exitPrice) / context.entryPrice) *
        10_000 -
      economics.residualCostBps;
    if (netBps > 0)
      return close(previous, 'TARGET', now, config, { estimatedNetReturnBps: netBps });
  }

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
  const evidenceAt = context.marketEvidence?.observedAtMs;
  const advancing = (previous.lastObservedAtMs === null || now > previous.lastObservedAtMs) &&
    Number.isFinite(evidenceAt) && evidenceAt! <= now &&
    now - evidenceAt! <= config.exitIntelligenceMaxObservationGapMs &&
    (previous.lastEvidenceAtMs === undefined || evidenceAt! > previous.lastEvidenceAtMs);
  if (!advancing) {
    return {
      state: previous,
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
    previous.evidenceSources.includes(source),
  );
  const gap = previous.lastObservedAtMs === null ? Infinity : now - previous.lastObservedAtMs;
  const continues =
    riskQualified &&
    advancing &&
    sourcesPersist &&
    gap > 0 &&
    gap <= config.exitIntelligenceMaxObservationGapMs;
  const nextRiskCount = continues
    ? previous.consecutiveRiskObservations + 1
    : riskQualified && advancing
      ? 1
      : 0;
  const riskStartedAtMs = continues
    ? (previous.riskStartedAtMs ?? now)
    : riskQualified && advancing
      ? now
      : null;
  const riskState: MicroBurstOfflineExitState = {
    ...previous,
    phase: riskQualified ? 'ARMED' : 'OBSERVING',
    riskStartedAtMs,
    lastObservedAtMs: now,
    lastEvidenceAtMs: evidenceAt,
    consecutiveRiskObservations: nextRiskCount,
    evidenceSources: riskQualified ? assessment.adverseSources : [],
    baseline,
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
