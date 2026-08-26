import {
  PositionLifecycleDecision,
  PositionManagementResult,
} from '../../domain/strategy/StrategyDecision';
import { StrategyId, StrategyIdentity } from '../../domain/strategy/StrategyIdentity';

export interface StrategyPositionManager<TContext = unknown> {
  readonly strategyId: StrategyId;
  manage(
    identity: StrategyIdentity,
    context: TContext,
  ): Promise<PositionManagementResult> | PositionManagementResult;
}

export type PositionManagerRouteResult =
  | {
      status: 'ROUTED';
      decision: PositionLifecycleDecision;
    }
  | {
      status: 'RECOVERY_REQUIRED';
      strategyId: StrategyId;
      reason: 'POSITION_MANAGER_NOT_REGISTERED';
    };

export class PositionManagerRouter<TContext = unknown> {
  private readonly managers = new Map<StrategyId, StrategyPositionManager<TContext>>();

  register(manager: StrategyPositionManager<TContext>): void {
    if (this.managers.has(manager.strategyId)) {
      throw new Error(`POSITION_MANAGER_ALREADY_REGISTERED:${manager.strategyId}`);
    }
    this.managers.set(manager.strategyId, manager);
  }

  has(strategyId: StrategyId): boolean {
    return this.managers.has(strategyId);
  }

  async route(identity: StrategyIdentity, context: TContext): Promise<PositionManagerRouteResult> {
    const manager = this.managers.get(identity.strategyId);
    if (!manager) {
      return {
        status: 'RECOVERY_REQUIRED',
        strategyId: identity.strategyId,
        reason: 'POSITION_MANAGER_NOT_REGISTERED',
      };
    }

    if (manager.strategyId !== identity.strategyId) {
      throw new Error(
        `POSITION_MANAGER_OWNERSHIP_MISMATCH:${manager.strategyId}:${identity.strategyId}`,
      );
    }

    const decision = await manager.manage(identity, context);
    if (!decision.tradeId) {
      throw new Error('POSITION_MANAGER_DECISION_MISSING_TRADE_ID');
    }

    return {
      status: 'ROUTED',
      decision: {
        identity,
        ...decision,
      },
    };
  }
}
