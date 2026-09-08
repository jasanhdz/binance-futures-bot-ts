import { EntryStrategy } from '../../../core/strategy/EntryStrategy';
import { StrategyEvaluationResult } from '../../../core/strategy/StrategyDecision';
import {
  StrategyIdentity,
  StrategyMode,
  hasLiveAuthority,
} from '../../../core/strategy/StrategyIdentity';
import { MicroBurstConfig, MicroBurstContext, defaultMicroBurstConfig } from './MicroBurstTypes';
import { evaluateMicroBurstEntry } from './MicroBurstEntryPolicy';
import {
  evaluateMicroBurstReactionEntry,
  MICRO_REACTION_CANDIDATE_VERSION,
  MICRO_CONTEXTUAL_REACTION_VERSION,
} from './MicroBurstReactionEntryPolicy';
import type { OrderBookSnapshot } from './MicroBurstTypes';

export interface MicroBurstStrategyContext extends MicroBurstContext {
  config?: Partial<MicroBurstConfig>;
  entryPolicy?: 'BASELINE' | 'REACTION';
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
    if (identity.strategyId !== 'MICRO_BURST_V1') {
      throw new Error(`MICRO_BURST_V1_IDENTITY_MISMATCH:${identity.strategyId}`);
    }
    this.config = { ...defaultMicroBurstConfig(), ...config };
  }

  evaluate(context: MicroBurstStrategyContext): StrategyEvaluationResult {
    const config = { ...this.config, ...context.config };
    if (
      config.contextualPolicyVersion &&
      this.mode === 'LIVE' &&
      (this.identity.strategyVersion !== 'CONTEXTUAL_V3' ||
        !hasLiveAuthority(this.identity, 'LIVE') ||
        context.entryPolicy !== 'REACTION')
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
    const entryPolicy = context.entryPolicy ?? 'BASELINE';
    const decision =
      entryPolicy === 'REACTION'
        ? evaluateMicroBurstReactionEntry(
            context,
            config,
            context.executionBook,
            context.observedAtMs ?? NaN,
          )
        : evaluateMicroBurstEntry(context, config);
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
        entryPolicy,
        entryPolicyVersion:
          entryPolicy === 'REACTION'
            ? config.contextualPolicyVersion
              ? MICRO_CONTEXTUAL_REACTION_VERSION
              : MICRO_REACTION_CANDIDATE_VERSION
            : 'baseline',
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
