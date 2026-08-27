import { PositionManagementResult } from '../../domain/strategy/StrategyDecision';
import { StrategyIdentity } from '../../domain/strategy/StrategyIdentity';
import { strategyLifecyclePolicy } from '../../domain/strategy/StrategyLifecyclePolicy';
import { StrategyPositionLifecycleCore, StrategyPositionLifecycleContext } from '../position/StrategyPositionLifecycleCore';
import { StrategyPositionManager } from './PositionManagerRouter';

function assertOwnership(expected: 'MICRO_BURST_V1', identity: StrategyIdentity): void {
  if (identity.strategyId !== expected) {
    throw new Error(`POSITION_MANAGER_OWNERSHIP_MISMATCH:${expected}:${identity.strategyId}`);
  }
}

/**
 * MicroBurst-owned position lifecycle boundary.
 * Uses the MICRO_BURST_RESERVED_POLICY: no legacy guardian, no break-even, no trailing.
 * Only stop bracket required. Exit policy is handled at the strategy level.
 */
export class MicroBurstPositionManager implements StrategyPositionManager<StrategyPositionLifecycleContext> {
  readonly strategyId = 'MICRO_BURST_V1' as const;

  constructor(private readonly lifecycle: StrategyPositionLifecycleCore) {}

  async manage(identity: StrategyIdentity, context: StrategyPositionLifecycleContext): Promise<PositionManagementResult> {
    assertOwnership(this.strategyId, identity);
    await this.lifecycle.manage(strategyLifecyclePolicy('MICRO_BURST_V1'), context);
    return {
      tradeId: context.botState.lastTradeId ?? `MICRO-BURST-LEGACY-${context.symbol}`,
      decision: 'NO_ACTION',
      reason: 'micro_burst_position_manager_completed',
      diagnostics: { lifecycleOwner: this.strategyId },
    };
  }
}
