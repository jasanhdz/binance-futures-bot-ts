import type {
  StrategyExecutionPort,
  StrategyExecutionResult,
} from '../../../core/strategy/StrategyExecution';
import {
  AegisExecutionIntentFactory,
  type ApprovedAegisExecution,
} from '../domain/AegisExecutionIntentFactory';

/**
 * Bridges an approved Aegis entry to shared execution without owning exchange
 * mutation, protection, confirmation, or recovery semantics.
 */
export class AegisExecutionCoordinator {
  constructor(private readonly execution: StrategyExecutionPort) {}

  execute(approved: ApprovedAegisExecution): Promise<StrategyExecutionResult> {
    return this.execution.execute(AegisExecutionIntentFactory.create(approved));
  }
}
