import {
  PositionManagementResult,
  StrategyEvaluationResult,
} from '../../domain/strategy/StrategyDecision';
import {
  StrategyId,
  StrategyIdentity,
  StrategyMode,
} from '../../domain/strategy/StrategyIdentity';
import { EntryStrategy } from './StrategyRouter';
import { StrategyPositionManager } from './PositionManagerRouter';

export type LegacyEntryEvaluator<TContext> = (
  context: TContext,
) => Promise<StrategyEvaluationResult> | StrategyEvaluationResult;

export type LegacyPositionEvaluator<TContext> = (
  identity: StrategyIdentity,
  context: TContext,
) => Promise<PositionManagementResult> | PositionManagementResult;

export class LegacyEntryStrategyAdapter<TContext = unknown> implements EntryStrategy<TContext> {
  constructor(
    readonly identity: StrategyIdentity,
    readonly mode: StrategyMode,
    private readonly evaluator: LegacyEntryEvaluator<TContext>,
  ) {}

  evaluate(context: TContext): Promise<StrategyEvaluationResult> | StrategyEvaluationResult {
    return this.evaluator(context);
  }
}

export class LegacyPositionManagerAdapter<TContext = unknown>
  implements StrategyPositionManager<TContext>
{
  constructor(
    readonly strategyId: StrategyId,
    private readonly evaluator: LegacyPositionEvaluator<TContext>,
  ) {}

  manage(
    identity: StrategyIdentity,
    context: TContext,
  ): Promise<PositionManagementResult> | PositionManagementResult {
    if (identity.strategyId !== this.strategyId) {
      throw new Error(
        `LEGACY_POSITION_MANAGER_OWNERSHIP_MISMATCH:${this.strategyId}:${identity.strategyId}`,
      );
    }
    return this.evaluator(identity, context);
  }
}
