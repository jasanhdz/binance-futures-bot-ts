import { StrategyEvaluationResult } from './StrategyDecision';
import { StrategyIdentity, StrategyMode } from './StrategyIdentity';

export interface EntryStrategy<TContext = unknown> {
  readonly identity: StrategyIdentity;
  readonly mode: StrategyMode;
  evaluate(context: TContext): Promise<StrategyEvaluationResult> | StrategyEvaluationResult;
}
