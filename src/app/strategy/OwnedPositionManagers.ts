import { PositionManagementResult } from '../../core/strategy/StrategyDecision';
import { StrategyIdentity } from '../../core/strategy/StrategyIdentity';
import { strategyLifecyclePolicy } from '../../core/strategy/StrategyLifecyclePolicy';
import {
  AegisPositionLifecycle,
  StrategyPositionLifecycleContext,
  StrategyPositionLifecycleCore,
} from '../position/StrategyPositionLifecycleCore';
import { StrategyPositionManager } from '../../core/strategy/PositionManagerRouter';

function assertOwnership(
  expected: 'AEGIS_TURBO' | 'MOMENTUM_RIDE',
  identity: StrategyIdentity,
): void {
  if (identity.strategyId !== expected) {
    throw new Error(`POSITION_MANAGER_OWNERSHIP_MISMATCH:${expected}:${identity.strategyId}`);
  }
}

/**
 * Aegis-owned position lifecycle boundary.
 * Aegis-specific ExitEye/guardian behavior may exist behind this manager only.
 */
export class AegisPositionManager
  implements StrategyPositionManager<StrategyPositionLifecycleContext>
{
  readonly strategyId = 'AEGIS_TURBO' as const;

  constructor(private readonly lifecycle: AegisPositionLifecycle) {}

  async manage(
    identity: StrategyIdentity,
    context: StrategyPositionLifecycleContext,
  ): Promise<PositionManagementResult> {
    assertOwnership(this.strategyId, identity);
    await this.lifecycle.manage(context);
    return {
      tradeId: context.botState.lastTradeId ?? `AEGIS-LEGACY-${context.symbol}`,
      decision: 'NO_ACTION',
      reason: 'aegis_position_manager_completed',
      diagnostics: { lifecycleOwner: this.strategyId },
    };
  }
}

/**
 * Momentum-owned position lifecycle boundary.
 * It must never inherit Aegis current-brain/ExitEye authority.
 */
export class MomentumRidePositionManager
  implements StrategyPositionManager<StrategyPositionLifecycleContext>
{
  readonly strategyId = 'MOMENTUM_RIDE' as const;

  constructor(private readonly lifecycle: StrategyPositionLifecycleCore) {}

  async manage(
    identity: StrategyIdentity,
    context: StrategyPositionLifecycleContext,
  ): Promise<PositionManagementResult> {
    assertOwnership(this.strategyId, identity);
    await this.lifecycle.manage(strategyLifecyclePolicy('MOMENTUM_RIDE'), context);
    return {
      tradeId: context.botState.lastTradeId ?? `MOMENTUM-LEGACY-${context.symbol}`,
      decision: 'NO_ACTION',
      reason: 'momentum_position_manager_completed',
      diagnostics: { lifecycleOwner: this.strategyId },
    };
  }
}
