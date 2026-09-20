import {
  advanceMicroBurstExit,
  initialMicroBurstExitEngineState,
} from '../domain/MicroBurstExitPolicy';
import {
  defaultMicroBurstConfig,
  MicroBurstConfig,
  MicroBurstExitContext,
} from '../domain/MicroBurstTypes';
import {
  advanceMicroBurstOfflineExit,
  initialMicroBurstOfflineExitState,
  MICRO_BURST_OFFLINE_EXIT_VARIANT,
} from './MicroBurstOfflineExitVariant';
import { DynamicExitOutcome, CounterfactualExitReason } from './MicroBurstOutcomeTypes';

export interface MicroBurstOfflineExitObservation {
  observedAtMs: number;
  context: MicroBurstExitContext;
}

export interface MicroBurstOfflineExitComparison {
  /** Completeness of quote-marked outcomes, never evidence of executed profitability. */
  complete: boolean;
  incompleteReason?: 'NO_OBSERVATIONS' | 'MISSING_EXECUTABLE_ECONOMICS' | 'HORIZON_ENDED_OPEN'
    | 'INVALID_CHRONOLOGY_OR_IDENTITY' | 'UNMODELED_MANAGEMENT';
  economicEvidenceEligible: false;
  executionModel: 'DECISION_QUOTE_MARK_ONLY';
  comparisonScope: 'LEGACY_MULTI_FACTOR_VARIANT_NOT_TIME_ABLATION';
  current: DynamicExitOutcome | null;
  variant: DynamicExitOutcome | null;
  variantVersion: typeof MICRO_BURST_OFFLINE_EXIT_VARIANT;
}

function outcome(
  context: MicroBurstExitContext,
  side: 'LONG' | 'SHORT',
  reason: CounterfactualExitReason,
  config: MicroBurstConfig,
): DynamicExitOutcome | null {
  const economics = context.executableEconomics;
  const now = context.observedAtMs;
  if (!economics || !economics.quantityCovered || !Number.isFinite(now) ||
    ![context.entryPrice, economics.exitPrice, economics.observedAtMs,
      economics.residualCostBps, economics.volatilityBps].every(Number.isFinite) ||
    context.entryPrice <= 0 || economics.exitPrice <= 0 || economics.volatilityBps < 0 ||
    economics.residualCostBps < config.exitEstimatedRoundTripCostBps ||
    economics.observedAtMs > now! || now! - economics.observedAtMs > config.exitIntelligenceMaxObservationGapMs
  ) return null;
  const grossBps =
    (side === 'LONG'
      ? (economics.exitPrice - context.entryPrice) / context.entryPrice
      : (context.entryPrice - economics.exitPrice) / context.entryPrice) * 10_000;
  return {
    counterfactualExitReason: reason,
    counterfactualExitAtMs: context.observedAtMs ?? context.timeInTradeMs,
    counterfactualExitPrice: economics.exitPrice,
    counterfactualGrossBps: grossBps,
    counterfactualNetBps: grossBps - economics.residualCostBps,
  };
}

function closeReason(reason: string): CounterfactualExitReason | null {
  return [
    'HARD_INVALIDATION',
    'ANOMALY',
    'BTC_REVERSAL',
    'TARGET',
    'INTELLIGENT_EXIT',
    'PROFIT_LOCK',
    'BREAK_EVEN',
    'EARLY_FAILURE',
    'MAX_HOLD',
  ].includes(reason)
    ? (reason as CounterfactualExitReason)
    : null;
}

/**
 * Replays identical, timestamped observations through CURRENT and the research variant.
 * Incomplete histories remain incomplete; open positions are never scored as zero or winners.
 */
export function compareMicroBurstOfflineExitPolicies(
  observations: readonly MicroBurstOfflineExitObservation[],
  side: 'LONG' | 'SHORT',
  config: MicroBurstConfig = defaultMicroBurstConfig(),
): MicroBurstOfflineExitComparison {
  if (!observations.length)
    return {
      complete: false,
      incompleteReason: 'NO_OBSERVATIONS',
      current: null,
      variant: null,
      variantVersion: MICRO_BURST_OFFLINE_EXIT_VARIANT,
      economicEvidenceEligible: false,
      executionModel: 'DECISION_QUOTE_MARK_ONLY',
      comparisonScope: 'LEGACY_MULTI_FACTOR_VARIANT_NOT_TIME_ABLATION',
    };
  const first = observations[0];
  const enteredAtMs = first.observedAtMs - first.context.timeInTradeMs;
  const invalid = observations.some((row, index) => {
    const context = row.context;
    return !Number.isFinite(row.observedAtMs) || context.observedAtMs !== row.observedAtMs ||
      !Number.isFinite(context.timeInTradeMs) || context.timeInTradeMs < 0 ||
      row.observedAtMs - context.timeInTradeMs !== enteredAtMs ||
      context.entryPrice !== first.context.entryPrice || context.leverage !== first.context.leverage ||
      (index > 0 && row.observedAtMs < observations[index - 1].observedAtMs) ||
      (context.marketEvidence != null && context.marketEvidence.observedAtMs > row.observedAtMs);
  });
  if (invalid) return {
    complete: false, incompleteReason: 'INVALID_CHRONOLOGY_OR_IDENTITY', current: null, variant: null,
    variantVersion: MICRO_BURST_OFFLINE_EXIT_VARIANT, economicEvidenceEligible: false,
    executionModel: 'DECISION_QUOTE_MARK_ONLY', comparisonScope: 'LEGACY_MULTI_FACTOR_VARIANT_NOT_TIME_ABLATION',
  };
  const ordered = observations;
  const currentConfig = { ...config, contextualPolicyVersion: 'MICRO' as const };
  let currentState = initialMicroBurstExitEngineState();
  let variantState = initialMicroBurstOfflineExitState();
  let currentStopPrice: number | null = null;
  let current: DynamicExitOutcome | null = null;
  let variant: DynamicExitOutcome | null = null;
  let currentClosed = false;
  let variantClosed = false;
  let unpriced = false;
  let unmodeled = false;
  let lastAt = -Infinity;
  for (const observation of ordered) {
    if (observation.observedAtMs === lastAt) {
      // Conflicting same-time records are not a causal sequence.
      unmodeled = true;
      continue;
    }
    lastAt = observation.observedAtMs;
    currentStopPrice ??= observation.context.currentStopPrice;
    const currentContext = {
      ...observation.context,
      currentStopPrice,
    };
    const currentTransition = advanceMicroBurstExit(
      currentState,
      currentContext,
      currentConfig,
      side,
    );
    currentState = currentTransition.state;
    if (
      !currentClosed &&
      currentTransition.decision.action === 'MOVE_STOP' &&
      currentTransition.decision.requestedStopPrice !== undefined
    ) {
      // No stop ACK/trigger simulator exists here. Never claim these paths are comparable.
      unmodeled = true;
      currentStopPrice =
        side === 'LONG'
          ? Math.max(
              currentStopPrice ?? currentTransition.decision.requestedStopPrice,
              currentTransition.decision.requestedStopPrice,
            )
          : Math.min(
              currentStopPrice ?? currentTransition.decision.requestedStopPrice,
              currentTransition.decision.requestedStopPrice,
            );
    }
    const currentReason =
      currentTransition.decision.action === 'CLOSE_MARKET'
        ? closeReason(currentTransition.decision.reason)
        : null;
    if (!currentClosed && currentReason) {
      currentClosed = true;
      current = outcome(currentContext, side, currentReason, config);
      unpriced ||= current === null;
    }
    if (currentTransition.state.contextual?.extendedDestinationPrice !== undefined) unmodeled = true;
    const variantTransition = advanceMicroBurstOfflineExit(
      variantState,
      observation.context,
      config,
      side,
    );
    variantState = variantTransition.state;
    const variantReason =
      variantTransition.decision.action === 'CLOSE_MARKET'
        ? closeReason(variantTransition.decision.reason)
        : null;
    if (!variantClosed && variantReason) {
      variantClosed = true;
      variant = outcome(observation.context, side, variantReason, config);
      unpriced ||= variant === null;
    }
    if (currentClosed && variantClosed) break;
  }
  const model = {
    economicEvidenceEligible: false as const, executionModel: 'DECISION_QUOTE_MARK_ONLY' as const,
    comparisonScope: 'LEGACY_MULTI_FACTOR_VARIANT_NOT_TIME_ABLATION' as const,
  };
  if (unmodeled || unpriced) return {
    ...model, complete: false,
    incompleteReason: unmodeled ? 'UNMODELED_MANAGEMENT' : 'MISSING_EXECUTABLE_ECONOMICS',
    current: unmodeled ? null : current, variant: unmodeled ? null : variant,
    variantVersion: MICRO_BURST_OFFLINE_EXIT_VARIANT,
  };
  if (current && variant)
    return { ...model, complete: true, current, variant, variantVersion: MICRO_BURST_OFFLINE_EXIT_VARIANT };
  if (ordered.some((observation) => !observation.context.executableEconomics))
    return {
      ...model,
      complete: false,
      incompleteReason: 'MISSING_EXECUTABLE_ECONOMICS',
      current,
      variant,
      variantVersion: MICRO_BURST_OFFLINE_EXIT_VARIANT,
    };
  return {
    ...model,
    complete: false,
    incompleteReason: 'HORIZON_ENDED_OPEN',
    current,
    variant,
    variantVersion: MICRO_BURST_OFFLINE_EXIT_VARIANT,
  };
}
