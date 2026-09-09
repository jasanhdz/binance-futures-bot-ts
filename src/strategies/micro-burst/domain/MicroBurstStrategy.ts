import { EntryStrategy } from '../../../core/strategy/EntryStrategy';
import { StrategyEvaluationResult } from '../../../core/strategy/StrategyDecision';
import {
  StrategyIdentity,
  StrategyMode,
  hasLiveAuthority,
} from '../../../core/strategy/StrategyIdentity';
import { MicroBurstConfig, MicroBurstContext, defaultMicroBurstConfig } from './MicroBurstTypes';
import { evaluateMicroBurstReactionEntry } from './MicroBurstReactionEntryPolicy';
import type { OrderBookSnapshot } from './MicroBurstTypes';

export interface MicroBurstStrategyContext extends MicroBurstContext {
  config?: Partial<MicroBurstConfig>;
  entryPolicy?: 'MICRO';
  executionBook?: OrderBookSnapshot;
  observedAtMs?: number;
}

export class MicroBurstStrategy implements EntryStrategy<MicroBurstStrategyContext> {
  private readonly config: MicroBurstConfig;

  constructor(
    readonly identity: StrategyIdentity,
    readonly mode: StrategyMode,
    config?: Partial<MicroBurstConfig>,
  ) {
    if (identity.strategyId !== 'MICRO_BURST') {
      throw new Error(`MICRO_BURST_IDENTITY_MISMATCH:${identity.strategyId}`);
    }
    this.config = { ...defaultMicroBurstConfig(), ...config };
  }

  evaluate(context: MicroBurstStrategyContext): StrategyEvaluationResult {
    const config = { ...this.config, ...context.config, contextualPolicyVersion: 'MICRO' as const };
    if (
      config.contextualPolicyVersion &&
      this.mode === 'LIVE' &&
      (this.identity.strategyVersion !== 'MICRO' || !hasLiveAuthority(this.identity, 'LIVE'))
    ) {
      return {
        symbol: context.symbol,
        timestamp: context.timestamp,
        decision: 'NO_TRADE',
        reason: 'MICRO_CONTEXTUAL_LIVE_IDENTITY_REQUIRED',
        diagnostics: {
          authority: 'OBSERVATION_ONLY',
          policyVersion: config.contextualPolicyVersion,
        },
      };
    }
    const decision = evaluateMicroBurstReactionEntry(
      context,
      config,
      context.executionBook,
      context.observedAtMs ?? NaN,
    );
    return {
      symbol: context.symbol,
      timestamp: context.timestamp,
      decision: decision.action,
      side: decision.side,
      reason: decision.reason,
      confidence: decision.confirmationStrength,
      destinationPrice: decision.targetPrice,
      structuralInvalidation: decision.stopInvalidationPrice,
      diagnostics: {
        ...decision.diagnostics,
        policy: 'MICRO',
        leverage: decision.leverage,
        positionFraction: decision.positionFraction,
        leverageTier: decision.leverageTier,
        roomToTargetBps: decision.roomToTargetBps,
        riskToInvalidationBps: decision.riskToInvalidationBps,
        rewardRisk: decision.rewardRisk,
      },
    };
  }
}
