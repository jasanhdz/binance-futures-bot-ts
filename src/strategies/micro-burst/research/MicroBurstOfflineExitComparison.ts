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
  complete: boolean;
  incompleteReason?: 'NO_OBSERVATIONS' | 'MISSING_EXECUTABLE_ECONOMICS' | 'HORIZON_ENDED_OPEN';
  current: DynamicExitOutcome | null;
  variant: DynamicExitOutcome | null;
  variantVersion: typeof MICRO_BURST_OFFLINE_EXIT_VARIANT;
}

function outcome(
  context: MicroBurstExitContext,
  side: 'LONG' | 'SHORT',
  reason: CounterfactualExitReason,
): DynamicExitOutcome | null {
  const economics = context.executableEconomics;
  if (!economics || !economics.quantityCovered) return null;
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
    };
  const ordered = [...observations].sort((a, b) => a.observedAtMs - b.observedAtMs);
  const currentConfig = { ...config, contextualPolicyVersion: 'MICRO' as const };
  let currentState = initialMicroBurstExitEngineState();
  let variantState = initialMicroBurstOfflineExitState();
  let currentStopPrice: number | null = null;
  let current: DynamicExitOutcome | null = null;
  let variant: DynamicExitOutcome | null = null;
  for (const observation of ordered) {
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
      currentTransition.decision.action === 'MOVE_STOP' &&
      currentTransition.decision.requestedStopPrice !== undefined
    ) {
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
    if (!current && currentReason) current = outcome(currentContext, side, currentReason);
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
    if (!variant && variantReason) variant = outcome(observation.context, side, variantReason);
  }
  if (current && variant)
    return { complete: true, current, variant, variantVersion: MICRO_BURST_OFFLINE_EXIT_VARIANT };
  if (ordered.some((observation) => !observation.context.executableEconomics))
    return {
      complete: false,
      incompleteReason: 'MISSING_EXECUTABLE_ECONOMICS',
      current,
      variant,
      variantVersion: MICRO_BURST_OFFLINE_EXIT_VARIANT,
    };
  return {
    complete: false,
    incompleteReason: 'HORIZON_ENDED_OPEN',
    current,
    variant,
    variantVersion: MICRO_BURST_OFFLINE_EXIT_VARIANT,
  };
}
