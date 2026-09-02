import { PositionManagementResult } from '../../../core/strategy/StrategyDecision';
import { StrategyIdentity } from '../../../core/strategy/StrategyIdentity';
import {
  StrategyPositionLifecycleCore,
  StrategyPositionLifecycleContext,
} from '../../../app/position/StrategyPositionLifecycleCore';
import { StrategyPositionManager } from '../../../core/strategy/PositionManagerRouter';
import {
  MicroBurstConfig,
  MicroBurstExitContext,
  MicroBurstExitDecision,
  defaultMicroBurstConfig,
} from '../domain/MicroBurstTypes';
import { MicroBurstExitEngine } from '../domain/MicroBurstExitPolicy';

export interface MicroBurstPositionManagementContext extends StrategyPositionLifecycleContext {
  strategyMode: 'OFF';
  exitContext: MicroBurstExitContext;
  side: 'LONG' | 'SHORT';
}

function assertOwnership(expected: 'MICRO_BURST_V1', identity: StrategyIdentity): void {
  if (identity.strategyId !== expected) {
    throw new Error(`POSITION_MANAGER_OWNERSHIP_MISMATCH:${expected}:${identity.strategyId}`);
  }
}

function hasExitDecisionContext(
  context: StrategyPositionLifecycleContext,
): context is MicroBurstPositionManagementContext {
  return (
    'strategyMode' in context &&
    context.strategyMode === 'OFF' &&
    'exitContext' in context &&
    'side' in context &&
    (context.side === 'LONG' || context.side === 'SHORT')
  );
}

export class MicroBurstPositionManager
  implements StrategyPositionManager<StrategyPositionLifecycleContext>
{
  readonly strategyId = 'MICRO_BURST_V1' as const;

  private readonly config: MicroBurstConfig;
  private readonly exitEngine = new MicroBurstExitEngine();
  private readonly activeTradeBySymbol = new Map<string, string>();

  constructor(_lifecycle: StrategyPositionLifecycleCore, config?: Partial<MicroBurstConfig>) {
    this.config = { ...defaultMicroBurstConfig(), ...config };
  }

  evaluateExit(
    exitContext: MicroBurstExitContext,
    side: 'LONG' | 'SHORT',
    tradeId = 'MICRO-BURST-DIRECT-EVALUATION',
  ): MicroBurstExitDecision {
    return this.exitEngine.evaluate(tradeId, exitContext, this.config, side);
  }

  async manage(
    identity: StrategyIdentity,
    context: StrategyPositionLifecycleContext,
  ): Promise<PositionManagementResult> {
    assertOwnership(this.strategyId, identity);
    const hasExitContext = hasExitDecisionContext(context);
    const tradeId = context.botState.lastTradeId ?? `MICRO-BURST-V1-${context.symbol}`;
    const previousTradeId = this.activeTradeBySymbol.get(context.symbol);
    if (previousTradeId && previousTradeId !== tradeId) this.exitEngine.forget(previousTradeId);
    this.activeTradeBySymbol.set(context.symbol, tradeId);
    const exitDecision = hasExitContext
      ? this.evaluateExit(context.exitContext, context.side, tradeId)
      : null;
    if (exitDecision) {
      return {
        tradeId,
        decision: exitDecision.action,
        reason: exitDecision.reason,
        requestedStopPrice: exitDecision.requestedStopPrice,
        diagnostics: {
          ...exitDecision.diagnostics,
          lifecycleOwner: this.strategyId,
          strategyMode: 'OFF',
          actionApplied: false,
          authorityReason: 'MICRO_BURST_V1_OFF',
          lifecycleApplied: false,
        },
      };
    }
    return {
      tradeId: context.botState.lastTradeId ?? `MICRO-BURST-V1-${context.symbol}`,
      decision: 'NO_ACTION',
      reason: 'micro_burst_position_manager_completed',
      diagnostics: {
        lifecycleOwner: this.strategyId,
        actionApplied: false,
        authorityReason: 'EXIT_CONTEXT_UNAVAILABLE',
        lifecycleApplied: false,
      },
    };
  }
}
