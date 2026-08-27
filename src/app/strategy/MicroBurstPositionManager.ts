import { PositionManagementResult } from '../../domain/strategy/StrategyDecision';
import { StrategyIdentity } from '../../domain/strategy/StrategyIdentity';
import { strategyLifecyclePolicy } from '../../domain/strategy/StrategyLifecyclePolicy';
import {
  StrategyPositionLifecycleCore,
  StrategyPositionLifecycleContext,
} from '../position/StrategyPositionLifecycleCore';
import { StrategyPositionManager } from './PositionManagerRouter';
import {
  MicroBurstConfig,
  MicroBurstExitContext,
  MicroBurstExitDecision,
  defaultMicroBurstConfig,
} from '../../domain/strategies/micro-burst/MicroBurstTypes';
import { evaluateMicroBurstExit } from '../../domain/strategies/micro-burst/MicroBurstExitPolicy';

function assertOwnership(expected: 'MICRO_BURST_V1', identity: StrategyIdentity): void {
  if (identity.strategyId !== expected) {
    throw new Error(`POSITION_MANAGER_OWNERSHIP_MISMATCH:${expected}:${identity.strategyId}`);
  }
}

export class MicroBurstPositionManager
  implements StrategyPositionManager<StrategyPositionLifecycleContext>
{
  readonly strategyId = 'MICRO_BURST_V1' as const;

  private readonly config: MicroBurstConfig;

  constructor(
    private readonly lifecycle: StrategyPositionLifecycleCore,
    config?: Partial<MicroBurstConfig>,
  ) {
    this.config = { ...defaultMicroBurstConfig(), ...config };
  }

  evaluateExit(exitContext: MicroBurstExitContext, side: 'LONG' | 'SHORT'): MicroBurstExitDecision {
    return evaluateMicroBurstExit(exitContext, this.config, side);
  }

  async manage(
    identity: StrategyIdentity,
    context: StrategyPositionLifecycleContext,
  ): Promise<PositionManagementResult> {
    assertOwnership(this.strategyId, identity);
    await this.lifecycle.manage(strategyLifecyclePolicy('MICRO_BURST_V1'), context);
    return {
      tradeId: context.botState.lastTradeId ?? `MICRO-BURST-V1-${context.symbol}`,
      decision: 'NO_ACTION',
      reason: 'micro_burst_position_manager_completed',
      diagnostics: { lifecycleOwner: this.strategyId },
    };
  }
}
