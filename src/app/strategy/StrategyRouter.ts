import {
  StrategyDecisionEnvelope,
  StrategyEvaluationResult,
} from '../../domain/strategy/StrategyDecision';
import { EntryStrategy } from '../../domain/strategy/EntryStrategy';
import { StrategyId } from '../../domain/strategy/StrategyIdentity';

export class StrategyRouter<TContext = unknown> {
  private readonly strategies = new Map<StrategyId, EntryStrategy<TContext>>();

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

    if (strategy.mode === 'OFF') {
      return {
        identity: strategy.identity,
        mode: strategy.mode,
        symbol: extractSymbol(context),
        timestamp: Date.now(),
        decision: 'NO_TRADE',
        reason: 'strategy_off',
        diagnostics: { routerBlocked: true },
      };
    }

    const decision = await strategy.evaluate(context);
    validateDecision(decision);

    return {
      identity: strategy.identity,
      mode: strategy.mode,
      ...decision,
    };
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
