import {
  EntryStrategy,
  freezeStrategyRuntimeContract,
  StrategyRuntimeContract,
} from '../../../core/strategy/EntryStrategy';
import { StrategyEvaluationResult } from '../../../core/strategy/StrategyDecision';
import { StrategyIdentity, StrategyMode } from '../../../core/strategy/StrategyIdentity';
import {
  evaluateMomentumRideEntry,
  MomentumRideEntryContext,
  MomentumRideEntryPolicyConfig,
} from './MomentumRideEntryPolicy';

export interface MomentumRideStrategyContext extends MomentumRideEntryContext {
  policy: MomentumRideEntryPolicyConfig;
}

/**
 * Concrete strategy adapter for Momentum Ride.
 * It has no knowledge of Aegis EntryQuality, E4, DecisionBrain, CleanEntry,
 * ProbeMode, ExitEye, or any other Aegis-specific policy.
 */
export class MomentumRideStrategy implements EntryStrategy<MomentumRideStrategyContext> {
  readonly contract: StrategyRuntimeContract;

  constructor(
    readonly identity: StrategyIdentity,
    readonly mode: StrategyMode,
  ) {
    if (identity.strategyId !== 'MOMENTUM_RIDE') {
      throw new Error(`MOMENTUM_RIDE_IDENTITY_MISMATCH:${identity.strategyId}`);
    }
    const contract: StrategyRuntimeContract = {
      symbols: { source: 'CALLER_CONTEXT' },
      configuration: {
        source: 'EVALUATION_CONTEXT',
        schemaVersion: 'MOMENTUM_RIDE_ENTRY_POLICY_V1',
        effectiveConfigHash: identity.configHash ?? null,
        scope: 'PER_SYMBOL_POLICY',
      },
      inputs: [
        {
          kind: 'CLOSED_CANDLES',
          interval: '5m',
          limit: 300,
          minimumClosed: 80,
          maximumAgeMs: null,
          gapPolicy: 'UNSPECIFIED_BY_ADAPTER',
        },
        {
          kind: 'REALTIME_MARKET_FEATURES',
          schemaVersion: 'MOMENTUM_REALTIME_MARKET_V1',
          requiredFields: ['orderBookHealth', 'aggTradeGapFree', 'aggTradeCount', 'netTakerVolume'],
          maximumAgeMs: 3_000,
        },
      ],
      warmup: [
        {
          inputKind: 'CLOSED_CANDLES',
          minimumReadyCondition: '80 consecutive completed 5m candles',
        },
        {
          inputKind: 'REALTIME_MARKET_FEATURES',
          minimumReadyCondition: 'fresh healthy shared book and gap-free AggTrade',
        },
      ],
      entryState: {
        kind: 'STATELESS',
        schemaVersion: 1,
        recovery: 'REBUILD_FROM_CONTEXT',
      },
      positionLifecycle: {
        managerStrategyId: identity.strategyId,
        stateSchemaVersion: 1,
        recovery: 'RESTORE_BY_PERSISTED_STRATEGY_IDENTITY',
      },
    };
    this.contract = freezeStrategyRuntimeContract(contract);
  }

  evaluate(context: MomentumRideStrategyContext): StrategyEvaluationResult {
    const decision = evaluateMomentumRideEntry(context, context.policy);
    return {
      ...decision,
      evaluationStatus:
        decision.decision === 'ENTRY_INTENT'
          ? 'INTENT'
          : context.realtimeMarketStatus !== 'FRESH' ||
              context.liquidityStressStatus === 'NO_DATA' ||
              (context.candleStatus !== undefined && context.candleStatus !== 'FRESH')
            ? 'NOT_EVALUABLE'
            : 'REJECTED',
    };
  }
}
