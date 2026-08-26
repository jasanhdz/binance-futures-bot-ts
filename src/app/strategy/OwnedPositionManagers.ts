import { StrategyLifecyclePolicy, strategyLifecyclePolicy } from '../../domain/strategy/StrategyLifecyclePolicy';
import { PositionManagementResult } from '../../domain/strategy/StrategyDecision';
import { StrategyIdentity } from '../../domain/strategy/StrategyIdentity';
import { StrategyPositionManager } from './PositionManagerRouter';

export type OwnedPositionLifecycleDelegate<TContext> = (
  identity: StrategyIdentity,
  policy: StrategyLifecyclePolicy,
  context: TContext,
) => Promise<PositionManagementResult> | PositionManagementResult;

abstract class BaseOwnedPositionManager<TContext>
  implements StrategyPositionManager<TContext>
{
  abstract readonly strategyId: 'AEGIS_TURBO' | 'MOMENTUM_RIDE';

  constructor(private readonly delegate: OwnedPositionLifecycleDelegate<TContext>) {}

  manage(
    identity: StrategyIdentity,
    context: TContext,
  ): Promise<PositionManagementResult> | PositionManagementResult {
    if (identity.strategyId !== this.strategyId) {
      throw new Error(
        `POSITION_MANAGER_OWNERSHIP_MISMATCH:${this.strategyId}:${identity.strategyId}`,
      );
    }
    return this.delegate(identity, strategyLifecyclePolicy(this.strategyId), context);
  }
}

/**
 * Aegis-owned position lifecycle boundary.
 * Aegis-specific ExitEye/guardian behavior may exist behind this manager only.
 */
export class AegisPositionManager<TContext> extends BaseOwnedPositionManager<TContext> {
  readonly strategyId = 'AEGIS_TURBO' as const;
}

/**
 * Momentum-owned position lifecycle boundary.
 * It must never inherit Aegis current-brain/ExitEye authority.
 */
export class MomentumRidePositionManager<TContext> extends BaseOwnedPositionManager<TContext> {
  readonly strategyId = 'MOMENTUM_RIDE' as const;
}
