import { randomUUID } from 'node:crypto';
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
import {
  isMicroBurstExitEngineState,
  MicroBurstExitEngine,
  microBurstExitDeadline,
} from '../domain/MicroBurstExitPolicy';
import { MicroBurstExitObservation } from './MicroBurstExitObservation';
import { MICRO_BURST_V1_LIVE_AUTHORITY_ENABLED } from '../domain/MicroBurstIdentity';
import { isMicroBurstTradePolicy } from '../domain/MicroBurstTradePolicy';

export interface MicroBurstPositionManagementContext extends StrategyPositionLifecycleContext {
  strategyMode: 'OFF' | 'LIVE';
  exitContext: MicroBurstExitContext;
  side: 'LONG' | 'SHORT';
}

export interface MicroBurstPositionManagerExecution {
  close(
    context: MicroBurstPositionManagementContext,
    decision: MicroBurstExitDecision,
  ): Promise<boolean>;
  moveStop(
    context: MicroBurstPositionManagementContext,
    decision: MicroBurstExitDecision,
  ): Promise<boolean>;
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
    (context.strategyMode === 'OFF' || context.strategyMode === 'LIVE') &&
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

  constructor(
    _lifecycle: StrategyPositionLifecycleCore,
    config?: Partial<MicroBurstConfig>,
    private readonly execution?: MicroBurstPositionManagerExecution,
    private readonly liveAuthorityEnabled = MICRO_BURST_V1_LIVE_AUTHORITY_ENABLED,
    private readonly observation?: MicroBurstExitObservation,
    private readonly now: () => number = Date.now,
  ) {
    this.config = { ...defaultMicroBurstConfig(), ...config };
  }

  evaluateExit(
    exitContext: MicroBurstExitContext,
    side: 'LONG' | 'SHORT',
    tradeId = 'MICRO-BURST-DIRECT-EVALUATION',
    config = this.config,
  ): MicroBurstExitDecision {
    return this.exitEngine.evaluate(tradeId, exitContext, config, side);
  }

  async manage(
    identity: StrategyIdentity,
    context: StrategyPositionLifecycleContext,
  ): Promise<PositionManagementResult> {
    assertOwnership(this.strategyId, identity);
    const hasExitContext = hasExitDecisionContext(context);
    const tradeId = context.botState.lastTradeId ?? `MICRO-BURST-V1-${context.symbol}`;
    const storedIdentity = {
      ...identity,
      strategyVersion: context.botState.lastStrategyVersion ?? identity.strategyVersion,
      configHash: context.botState.lastConfigHash ?? identity.configHash,
      codeCommitSha: context.botState.lastCodeCommitSha ?? identity.codeCommitSha,
    };
    const savedPolicy = context.botState.microBurstTradePolicy;
    const policy = isMicroBurstTradePolicy(savedPolicy, storedIdentity) ? savedPolicy : undefined;
    if (
      storedIdentity.strategyVersion === 'CONTEXTUAL_V3' &&
      (!policy ||
        (context.botState.microBurstExitState !== undefined &&
          context.botState.microBurstExitPolicyDigest !== policy.digest))
    ) {
      return {
        tradeId,
        decision: 'NO_ACTION',
        reason: 'MICRO_PERSISTED_EXIT_POLICY_UNVERIFIED',
        diagnostics: {
          actionApplied: false,
          lifecycleApplied: false,
          lifecycleOwner: this.strategyId,
        },
      };
    }
    const config = policy?.config ?? this.config;
    const previousTradeId = this.activeTradeBySymbol.get(context.symbol);
    if (previousTradeId && previousTradeId !== tradeId) this.exitEngine.forget(previousTradeId);
    if (
      !previousTradeId &&
      isMicroBurstExitEngineState(context.botState.microBurstExitState) &&
      (!hasExitContext ||
        context.botState.microBurstExitState.lastObservedAtMs === null ||
        context.botState.microBurstExitState.lastObservedAtMs <= context.exitContext.observedAtMs!)
    ) {
      this.exitEngine.restore(tradeId, context.botState.microBurstExitState);
    }
    this.activeTradeBySymbol.set(context.symbol, tradeId);
    const exitDecision = hasExitContext
      ? this.evaluateExit(context.exitContext, context.side, tradeId, config)
      : config.contextualPolicyVersion
        ? microBurstExitDeadline(context.botState.lastEntryAt, this.now(), config)
        : null;
    if (exitDecision) {
      const observation = {
        schemaVersion: 1 as const,
        authority: 'OBSERVATION_ONLY' as const,
        identity,
        symbol: context.symbol,
        tradeId,
        decisionId: randomUUID(),
        observedAtMs: hasExitContext ? (context.exitContext.observedAtMs ?? null) : this.now(),
        decision: exitDecision,
        context: hasExitContext ? context.exitContext : null,
        realizedNetPnl: null,
      };
      this.observation?.observe({
        ...observation,
        phase: 'DECISION',
        actionApplied: null,
        applicationStatus: 'NOT_ATTEMPTED',
      });
      const engineState = this.exitEngine.getState(tradeId);
      if (
        engineState &&
        typeof context.symbolState.set === 'function' &&
        (!config.contextualPolicyVersion || policy)
      ) {
        context.symbolState.set({
          microBurstExitState: engineState,
          ...(policy ? { microBurstExitPolicyDigest: policy.digest } : {}),
        });
        if (policy) {
          if (!context.symbolState.flush) throw new Error('MICRO_EXIT_POLICY_PERSISTENCE_REQUIRED');
          await context.symbolState.flush();
        }
      }
      let actionApplied = false;
      let applicationAttempted = false;
      if (
        hasExitContext &&
        context.strategyMode === 'LIVE' &&
        this.execution &&
        this.liveAuthorityEnabled &&
        !config.contextualPolicyVersion
      ) {
        try {
          if (exitDecision.action === 'CLOSE_MARKET') {
            applicationAttempted = true;
            actionApplied = await this.execution.close(context, exitDecision);
            if (actionApplied) {
              this.exitEngine.forget(tradeId);
              this.activeTradeBySymbol.delete(context.symbol);
            }
          } else if (exitDecision.action === 'MOVE_STOP') {
            applicationAttempted = true;
            actionApplied = await this.execution.moveStop(context, exitDecision);
          }
        } catch (error) {
          this.observation?.observe({
            ...observation,
            phase: 'APPLICATION_RESULT',
            actionApplied: null,
            applicationStatus: 'UNKNOWN',
          });
          throw error;
        }
      }
      this.observation?.observe({
        ...observation,
        phase: 'APPLICATION_RESULT',
        actionApplied,
        applicationStatus: actionApplied
          ? 'APPLIED'
          : applicationAttempted
            ? 'NOT_APPLIED'
            : 'NOT_ATTEMPTED',
      });
      return {
        tradeId,
        decision: exitDecision.action,
        reason: exitDecision.reason,
        requestedStopPrice: exitDecision.requestedStopPrice,
        diagnostics: {
          ...exitDecision.diagnostics,
          lifecycleOwner: this.strategyId,
          strategyMode: hasExitContext ? context.strategyMode : 'OFF',
          actionApplied,
          authorityReason:
            hasExitContext && context.strategyMode === 'LIVE'
              ? config.contextualPolicyVersion
                ? 'MICRO_CONTEXTUAL_POLICY_RESEARCH_ONLY'
                : this.execution && this.liveAuthorityEnabled
                  ? 'MICRO_BURST_V1_LIVE'
                  : 'LIVE_AUTHORITY_DISABLED_OR_EXECUTION_PORT_MISSING'
              : 'MICRO_BURST_V1_OFF',
          lifecycleApplied: actionApplied,
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
