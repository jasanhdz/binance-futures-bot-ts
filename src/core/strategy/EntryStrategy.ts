import { StrategyEvaluationResult } from './StrategyDecision';
import { StrategyIdentity, StrategyMode } from './StrategyIdentity';

export interface EntryStrategy<TContext = unknown> {
  readonly identity: StrategyIdentity;
  readonly mode: StrategyMode;
  /** Refresh only evaluation clocks after a router wait; never renew input timestamps. */
  afterObservationWait?(context: TContext, elapsedMs: number): TContext;
  evaluate(context: TContext): Promise<StrategyEvaluationResult> | StrategyEvaluationResult;
}
