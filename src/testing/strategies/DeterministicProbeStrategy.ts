import { freezeStrategyRuntimeContract } from '../../core/strategy/EntryStrategy';
import type {
  EntryStrategy,
  StrategyDataRequirement,
  StrategyRuntimeContract,
  StrategyEvaluationStatus,
} from '../../core/strategy/EntryStrategy';
import type { StrategyEvaluationResult } from '../../core/strategy/StrategyDecision';
import type { StrategyIdentity, StrategyMode } from '../../core/strategy/StrategyIdentity';
import type { LocalCausalStateWatermark } from '../../core/market-data/LocalCausalWatermark';
import type { SharedStrategyMarketDataSnapshot } from '../../app/services/StrategyContractMarketDataProvisioner';

const DEFAULT_REQUIREMENTS: readonly StrategyDataRequirement[] = [
  {
    kind: 'ORDER_BOOK',
    minimumDepthLevels: 1,
    maximumAgeMs: 3_000,
    sequencePolicy: 'REQUIRE_HEALTHY_POINT',
  },
  {
    kind: 'AGG_TRADE_FLOW',
    windowMs: 5_000,
    minimumObservedSamples: 1,
    maximumAgeMs: 3_000,
    continuityPolicy: 'REQUIRE_GAP_FREE',
  },
  {
    kind: 'CLOSED_CANDLES',
    interval: '5m',
    limit: 1,
    minimumClosed: 1,
    maximumAgeMs: 300_000,
    gapPolicy: 'REJECT',
  },
];

/** Test-only strategy: a deterministic probe of common registration and paper seams. */
export interface DeterministicProbeContext {
  readonly symbol: string;
  readonly timestamp: number;
  readonly bookHealth: 'HEALTHY' | 'UNAVAILABLE' | 'STALE' | 'UNSYNCED' | 'ANOMALOUS';
  readonly flowGapFree: boolean;
  readonly candleCount: number;
  readonly localCausalState: {
    readonly depth: LocalCausalStateWatermark | null;
    readonly aggTrade: LocalCausalStateWatermark | null;
  };
  readonly marketDataSnapshot?: SharedStrategyMarketDataSnapshot;
  readonly outcome: 'INTENT' | 'REJECTED' | 'WAIT' | 'NOT_EVALUABLE';
  readonly side?: 'LONG' | 'SHORT';
}

export class DeterministicProbeStrategy implements EntryStrategy<DeterministicProbeContext> {
  public readonly contract: StrategyRuntimeContract;

  public constructor(
    public readonly identity: StrategyIdentity,
    public readonly mode: StrategyMode,
    requirements: readonly StrategyDataRequirement[] = DEFAULT_REQUIREMENTS,
  ) {
    if (identity.strategyId !== 'TEST_PROBE') throw new Error('TEST_PROBE_IDENTITY_REQUIRED');
    const contract: StrategyRuntimeContract = {
      symbols: { source: 'CALLER_CONTEXT' },
      configuration: {
        source: 'STRATEGY_INSTANCE',
        schemaVersion: 'DETERMINISTIC_PROBE_CONFIG_V1',
        effectiveConfigHash: identity.configHash ?? null,
        value: Object.freeze({ operationalRegistration: false }),
      },
      inputs: requirements,
      warmup: requirements.map((requirement) => ({
        inputKind: requirement.kind,
        minimumReadyCondition: `TEST_PROBE requires ${requirement.kind} input readiness`,
      })),
      entryState: {
        kind: 'STATELESS',
        schemaVersion: 1,
        recovery: 'REBUILD_FROM_CONTEXT',
      },
      positionLifecycle: {
        managerStrategyId: 'TEST_PROBE',
        stateSchemaVersion: 1,
        recovery: 'RESTORE_BY_PERSISTED_STRATEGY_IDENTITY',
      },
    };
    this.contract = freezeStrategyRuntimeContract(contract);
  }

  public evaluate(context: DeterministicProbeContext): StrategyEvaluationResult {
    const inputsReady =
      context.bookHealth === 'HEALTHY' && context.flowGapFree && context.candleCount >= 1;
    const evaluationStatus: StrategyEvaluationStatus = inputsReady
      ? context.outcome
      : 'NOT_EVALUABLE';
    return {
      symbol: context.symbol,
      timestamp: context.timestamp,
      decision: evaluationStatus === 'INTENT' ? 'ENTRY_INTENT' : 'NO_TRADE',
      ...(evaluationStatus === 'INTENT' ? { side: context.side ?? 'LONG' } : {}),
      evaluationStatus,
      reason: inputsReady ? `PROBE_${evaluationStatus}` : 'PROBE_INPUTS_NOT_READY',
      diagnostics: {
        owner: this.identity.strategyId,
        depthStateVersion: context.localCausalState.depth?.appliedStateVersion ?? null,
        flowStateVersion: context.localCausalState.aggTrade?.appliedStateVersion ?? null,
        marketDataCapturedAtMs: context.marketDataSnapshot?.capturedAtMs ?? null,
      },
    };
  }
}
