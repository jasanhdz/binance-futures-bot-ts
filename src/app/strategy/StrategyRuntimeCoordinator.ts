import { StrategyDecisionEnvelope } from '../../domain/strategy/StrategyDecision';
import { StrategyExecutionPort, StrategyExecutionResult } from '../../domain/strategy/StrategyExecution';
import { StrategyId } from '../../domain/strategy/StrategyIdentity';
import { StrategyRouter } from './StrategyRouter';

export type StrategyCoordinatorResult =
  | {
      status: 'NO_TRADE' | 'SHADOW_ONLY';
      decision: StrategyDecisionEnvelope;
    }
  | {
      status: 'EXECUTION_RESULT';
      decision: StrategyDecisionEnvelope;
      execution: StrategyExecutionResult;
    };

/**
 * Thin orchestration boundary:
 * market/context -> strategy -> normalized decision -> shared execution plane.
 * It deliberately contains no strategy rules and no Binance calls.
 */
export class StrategyRuntimeCoordinator<TContext = unknown> {
  constructor(
    private readonly router: StrategyRouter<TContext>,
    private readonly execution: StrategyExecutionPort,
    private readonly intentFactory: (
      decision: StrategyDecisionEnvelope,
      context: TContext,
    ) => Parameters<StrategyExecutionPort['execute']>[0],
  ) {}

  async run(strategyId: StrategyId, context: TContext): Promise<StrategyCoordinatorResult> {
    const decision = await this.router.evaluate(strategyId, context);

    if (decision.decision !== 'ENTRY_INTENT') {
      return { status: 'NO_TRADE', decision };
    }

    if (decision.mode !== 'LIVE') {
      return { status: 'SHADOW_ONLY', decision };
    }

    const execution = await this.execution.execute(this.intentFactory(decision, context));
    return { status: 'EXECUTION_RESULT', decision, execution };
  }
}
