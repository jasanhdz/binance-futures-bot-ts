import type { Side } from '../../../core/types';
import { validateOpportunityPrediction, type MicroOpportunityPredictionV1 } from './MicroOpportunityPredictionContract';

export type MicroOpportunityGateAction = 'ALLOW' | 'REJECT';

export interface MicroOpportunityGateDecision {
  readonly action: MicroOpportunityGateAction;
  readonly reason: string;
  readonly side: Side | null;
}

export function evaluateMicroOpportunityGate(input: {
  readonly stableDecision: 'ENTRY_INTENT' | 'NO_TRADE';
  readonly stableSide: Side | null;
  readonly prediction: MicroOpportunityPredictionV1 | null;
  readonly nowMs: number;
  readonly maxPredictionAgeMs: number;
  readonly minimumProbability: number;
}): MicroOpportunityGateDecision {
  if (input.stableDecision !== 'ENTRY_INTENT' || input.stableSide === null)
    return reject('STABLE_MICRO_NO_TRADE');
  if (!input.prediction || !validateOpportunityPrediction(input.prediction))
    return reject('PREDICTION_INVALID');
  if (input.prediction.observedAt > input.nowMs || input.nowMs - input.prediction.observedAt > input.maxPredictionAgeMs)
    return reject('PREDICTION_STALE');
  if (input.prediction.probabilityNetPositive < input.minimumProbability)
    return reject('PROBABILITY_BELOW_THRESHOLD');
  return { action: 'ALLOW', reason: 'OPPORTUNITY_THRESHOLD_PASSED', side: input.stableSide };
}

function reject(reason: string): MicroOpportunityGateDecision {
  return { action: 'REJECT', reason, side: null };
}
