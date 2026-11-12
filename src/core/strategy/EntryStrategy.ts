import { StrategyEvaluationResult } from './StrategyDecision';
import { StrategyIdentity, StrategyMode } from './StrategyIdentity';

export type StrategyEvaluationStatus = 'INTENT' | 'REJECTED' | 'WAIT' | 'NOT_EVALUABLE';

export type StrategyDataRequirement =
  | {
      readonly kind: 'CLOSED_CANDLES';
      readonly interval: string;
      readonly limit: number;
      readonly minimumClosed: number;
      readonly maximumAgeMs: number | null;
      readonly gapPolicy: 'REJECT' | 'REPORT_TO_STRATEGY' | 'UNSPECIFIED_BY_ADAPTER';
    }
  | {
      readonly kind: 'ORDER_BOOK';
      readonly minimumDepthLevels: number;
      readonly maximumAgeMs: number;
      readonly sequencePolicy: 'REQUIRE_LINKED_UPDATES' | 'REQUIRE_HEALTHY_POINT';
    }
  | {
      readonly kind: 'AGG_TRADE_FLOW';
      readonly windowMs: number;
      readonly minimumObservedSamples: number;
      readonly continuityPolicy: 'REQUIRE_GAP_FREE' | 'REPORT_TO_STRATEGY';
    }
  | {
      readonly kind: 'BENCHMARK_CONTEXT';
      readonly benchmarkId: string;
      readonly intervals: readonly string[];
      readonly maximumAgeMs: number;
    }
  | {
      readonly kind: 'REALTIME_MARKET_FEATURES';
      readonly schemaVersion: string;
      readonly requiredFields: readonly string[];
      readonly maximumAgeMs: number;
    };

export type StrategyConfigurationDeclaration =
  | {
      readonly source: 'STRATEGY_INSTANCE';
      readonly schemaVersion: string;
      readonly effectiveConfigHash: string | null;
      readonly value: Readonly<Record<string, unknown>>;
    }
  | {
      readonly source: 'EVALUATION_CONTEXT';
      readonly schemaVersion: string;
      readonly effectiveConfigHash: string | null;
      readonly scope: 'PER_SYMBOL_POLICY';
    };

export interface StrategyFeatureDefinition {
  readonly name: string;
  readonly order: number;
  readonly type: 'NUMBER' | 'BOOLEAN' | 'CATEGORY';
  readonly units: string;
  readonly version: string;
  readonly availability: {
    readonly timestampDomain: 'EXCHANGE_EVENT' | 'LOCAL_RECEIVE' | 'BOTH';
    readonly requiredEvidence: readonly string[];
    readonly maximumAgeMs?: number;
  };
  readonly missingValue: 'REJECT' | 'NULL' | 'EXPLICIT_DEFAULT';
}

/** Feature schema contract for future offline-training/in-process model adapters. */
export interface StrategyFeatureSchema {
  readonly schemaId: string;
  readonly version: string;
  readonly features: readonly StrategyFeatureDefinition[];
}

export interface StrategyFeatureVector {
  readonly kind: 'STRATEGY_FEATURE_VECTOR';
  readonly schemaId: string;
  readonly schemaVersion: string;
  readonly values: readonly (number | boolean | string | null)[];
  readonly missingFeatureNames: readonly string[];
  readonly warmupStatus: 'READY' | 'WARMING' | 'UNAVAILABLE';
  readonly sourceTimestamps: readonly {
    readonly domain: 'EXCHANGE_EVENT' | 'LOCAL_RECEIVE';
    readonly observedAtMs: number;
    readonly evidenceReference: string;
  }[];
  readonly evidenceSha256: string;
}

/** A future model emits evidence, never an execution order. No inference service is implied. */
export interface StrategyModelPredictionInput {
  readonly kind: 'MODEL_PREDICTION_INPUT';
  readonly model: {
    readonly modelId: string;
    readonly version: string;
    readonly sha256: string;
    readonly inputSchemaId: string;
    readonly inputSchemaVersion: string;
  };
  readonly predictionAtMs: number;
  readonly sourceTimestampDomain: 'EXCHANGE_EVENT' | 'LOCAL_RECEIVE';
  readonly featureEvidenceSha256: string;
  readonly values: Readonly<Record<string, number | boolean | string | null>>;
}

/** The eventual model-port shape is a strategy input wrapper, never an order intent. */
export interface StrategyEvaluationInput<TContext> {
  readonly strategyContext: TContext;
  readonly featureVector?: StrategyFeatureVector;
  readonly modelPredictions: readonly StrategyModelPredictionInput[];
}

export interface StrategyRuntimeContract {
  readonly symbols:
    | { readonly source: 'CALLER_CONTEXT' }
    | { readonly source: 'CONFIGURATION'; readonly values: readonly string[] };
  readonly configuration: StrategyConfigurationDeclaration;
  readonly inputs: readonly StrategyDataRequirement[];
  readonly warmup: readonly {
    readonly inputKind: StrategyDataRequirement['kind'];
    readonly minimumReadyCondition: string;
  }[];
  readonly entryState: {
    readonly kind: 'STATELESS' | 'PERSISTED';
    readonly schemaVersion: number;
    readonly recovery: 'REBUILD_FROM_CONTEXT' | 'RESTORE_FROM_PERSISTED_STATE';
  };
  readonly positionLifecycle: {
    readonly managerStrategyId: StrategyIdentity['strategyId'];
    readonly stateSchemaVersion: number;
    readonly recovery: 'RESTORE_BY_PERSISTED_STRATEGY_IDENTITY';
  };
  readonly modelFeatureSchema?: StrategyFeatureSchema;
}

export function freezeStrategyRuntimeContract<T extends StrategyRuntimeContract>(contract: T): T {
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  };
  freeze(contract);
  return contract;
}

export interface EntryStrategy<TContext = unknown> {
  readonly identity: StrategyIdentity;
  readonly mode: StrategyMode;
  /** Missing only on legacy/test adapters not yet migrated to the strategy contract. */
  readonly contract?: StrategyRuntimeContract;
  /** Refresh only evaluation clocks after a router wait; never renew input timestamps. */
  afterObservationWait?(context: TContext, elapsedMs: number, monotonicNowMs?: number): TContext;
  validateAfterRequiredAudit?(
    context: TContext,
    decision: StrategyEvaluationResult,
    elapsedMs: number,
  ): string | undefined;
  evaluate(context: TContext): Promise<StrategyEvaluationResult> | StrategyEvaluationResult;
}
