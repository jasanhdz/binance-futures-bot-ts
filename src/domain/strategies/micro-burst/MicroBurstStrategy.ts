import { EntryStrategy } from '../../strategy/EntryStrategy';
import { StrategyEvaluationResult } from '../../strategy/StrategyDecision';
import { StrategyIdentity, StrategyMode } from '../../strategy/StrategyIdentity';
import { MicroBurstConfig, MicroBurstContext, defaultMicroBurstConfig } from './MicroBurstTypes';
import { evaluateMicroBurstEntry } from './MicroBurstEntryPolicy';

export interface MicroBurstStrategyContext extends MicroBurstContext {
  config?: Partial<MicroBurstConfig>;
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
    const decision = evaluateMicroBurstEntry(context, config);
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
        leverage: decision.leverage,
        positionFraction: decision.positionFraction,
        leverageTier: decision.leverageTier,
        roomToTargetBps: decision.roomToTargetBps,
        riskToInvalidationBps: decision.riskToInvalidationBps,
      },
    };
  }
}
