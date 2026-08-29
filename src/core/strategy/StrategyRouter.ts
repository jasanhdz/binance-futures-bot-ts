import type { StrategyDecisionObservationHook } from '../blackbox/StrategyDecisionObservation';
import {
  StrategyDecisionEnvelope,
  StrategyEvaluationResult,
} from './StrategyDecision';
import { EntryStrategy } from './EntryStrategy';
import { StrategyId } from './StrategyIdentity';

export class StrategyRouter<TContext = unknown> {
  private readonly strategies = new Map<StrategyId, EntryStrategy<TContext>>();
  private observationHook?: StrategyDecisionObservationHook<TContext>;

  constructor(observationHook?: StrategyDecisionObservationHook<TContext>) {
    this.observationHook = observationHook;
  }

  /** Runtime composition hook. Observation remains side-effect-only and may be detached on shutdown. */
  setObservationHook(observationHook?: StrategyDecisionObservationHook<TContext>): void {
    this.observationHook = observationHook;
  }

  register(strategy: EntryStrategy<TContext>): void {
    const strategyId = strategy.identity.strategyId;
    if (this.strategies.has(strategyId)) {
      throw new Error(`STRATEGY_ALREADY_REGISTERED:${strategyId}`);
    }
    this.strategies.set(strategyId, strategy);
  }

  has(strategyId: StrategyId): boolean {
    return this.strategies.has(strategyId);
  }

  get(strategyId: StrategyId): EntryStrategy<TContext> | undefined {
    return this.strategies.get(strategyId);
  }

  list(): EntryStrategy<TContext>[] {
    return Array.from(this.strategies.values());
  }

  async evaluate(strategyId: StrategyId, context: TContext): Promise<StrategyDecisionEnvelope> {
    const strategy = this.strategies.get(strategyId);
    if (!strategy) {
      throw new Error(`STRATEGY_NOT_REGISTERED:${strategyId}`);
    }

    const snapshot = await this.captureObservation(strategyId, context);

    let envelope: StrategyDecisionEnvelope;
    if (strategy.mode === 'OFF') {
      envelope = {
        identity: strategy.identity,
        mode: strategy.mode,
        symbol: extractSymbol(context),
        timestamp: Date.now(),
        decision: 'NO_TRADE',
        reason: 'strategy_off',
        diagnostics: { routerBlocked: true },
      };
    } else {
      const decision = await strategy.evaluate(context);
      validateDecision(decision);
      envelope = {
        identity: strategy.identity,
        mode: strategy.mode,
        ...decision,
      };
    }

    await this.persistObservation(snapshot, envelope);
    return envelope;
  }

  private async captureObservation(
    strategyId: StrategyId,
    context: TContext,
  ): Promise<Awaited<ReturnType<StrategyDecisionObservationHook<TContext>['beforeEvaluation']>>> {
    if (!this.observationHook) return null;
    try {
      return await this.observationHook.beforeEvaluation(strategyId, context);
    } catch {
      return null;
    }
  }

  private async persistObservation(
    snapshot: Awaited<ReturnType<StrategyDecisionObservationHook<TContext>['beforeEvaluation']>>,
    envelope: StrategyDecisionEnvelope,
  ): Promise<void> {
    if (!this.observationHook || !snapshot) return;
    try {
      await this.observationHook.afterEvaluation(snapshot, envelope);
    } catch {
      // Phase T is observational. Evidence failures must not alter trading semantics.
    }
  }
}

function validateDecision(decision: StrategyEvaluationResult): void {
  if (decision.decision === 'ENTRY_INTENT' && !decision.side) {
    throw new Error('STRATEGY_ENTRY_INTENT_MISSING_SIDE');
  }
  if (!decision.symbol || !Number.isFinite(decision.timestamp)) {
    throw new Error('STRATEGY_DECISION_INVALID_IDENTITY_FIELDS');
  }
}

function extractSymbol(context: unknown): string {
  if (context && typeof context === 'object' && 'symbol' in context) {
    const symbol = (context as { symbol?: unknown }).symbol;
    if (typeof symbol === 'string') return symbol;
  }
  return 'UNKNOWN';
}
