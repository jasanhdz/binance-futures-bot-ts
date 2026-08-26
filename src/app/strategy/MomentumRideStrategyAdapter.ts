import {
  MomentumRideEntryContext,
  MomentumRideEntryPolicyConfig,
  evaluateMomentumRideEntry,
} from '../../domain/strategies/momentum-ride/MomentumRideEntryPolicy';
import { createMomentumRideLegacyIdentity } from '../../domain/strategies/momentum-ride/MomentumRideIdentity';
import { StrategyMode } from '../../domain/strategy/StrategyIdentity';
import { EntryStrategy } from './StrategyRouter';

export class MomentumRideStrategyAdapter implements EntryStrategy<MomentumRideEntryContext> {
  readonly identity = createMomentumRideLegacyIdentity();

  constructor(
    readonly mode: StrategyMode,
    private readonly config: MomentumRideEntryPolicyConfig,
  ) {}

  evaluate(context: MomentumRideEntryContext) {
    return evaluateMomentumRideEntry(context, this.config);
  }
}
