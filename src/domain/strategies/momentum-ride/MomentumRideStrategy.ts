import { EntryStrategy } from '../../../app/strategy/StrategyRouter';
import { StrategyEvaluationResult } from '../../strategy/StrategyDecision';
import { StrategyIdentity, StrategyMode } from '../../strategy/StrategyIdentity';
import {
  evaluateMomentumRideEntry,
  MomentumRideEntryContext,
  MomentumRideEntryPolicyConfig,
} from './MomentumRideEntryPolicy';

export interface MomentumRideStrategyContext extends MomentumRideEntryContext {
  policy: MomentumRideEntryPolicyConfig;
}

/**
 * Concrete strategy adapter for Momentum Ride.
 * It has no knowledge of Aegis EntryQuality, E4, DecisionBrain, CleanEntry,
 * ProbeMode, ExitEye, or any other Aegis-specific policy.
 */
export class MomentumRideStrategy implements EntryStrategy<MomentumRideStrategyContext> {
  constructor(
    readonly identity: StrategyIdentity,
    readonly mode: StrategyMode,
  ) {
    if (identity.strategyId !== 'MOMENTUM_RIDE') {
      throw new Error(`MOMENTUM_RIDE_IDENTITY_MISMATCH:${identity.strategyId}`);
    }
  }

  evaluate(context: MomentumRideStrategyContext): StrategyEvaluationResult {
    return evaluateMomentumRideEntry(context, context.policy);
  }
}
