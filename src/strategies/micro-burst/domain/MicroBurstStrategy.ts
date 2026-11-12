import {
  EntryStrategy,
  freezeStrategyRuntimeContract,
  StrategyRuntimeContract,
} from '../../../core/strategy/EntryStrategy';
import { StrategyEvaluationResult } from '../../../core/strategy/StrategyDecision';
import {
  StrategyIdentity,
  StrategyMode,
  hasLiveAuthority,
} from '../../../core/strategy/StrategyIdentity';
import { MicroBurstConfig, MicroBurstContext, defaultMicroBurstConfig } from './MicroBurstTypes';
import { evaluateMicroBurstReactionEntry } from './MicroBurstReactionEntryPolicy';
import type { OrderBookSnapshot } from './MicroBurstTypes';
import { captureMicroBurstReplay } from './MicroBurstExactReplay';
import { validateMicroBurstInputFreshness } from './MicroBurstInputFreshness';
import type { LocalCausalContextEvidence } from '../../../core/market-data/LocalCausalWatermark';

export interface MicroBurstStrategyContext extends MicroBurstContext {
  config?: Partial<MicroBurstConfig>;
  entryPolicy?: 'MICRO';
  executionBook?: OrderBookSnapshot;
  observedAtMs?: number;
  /** Conservative exchange-time upper bound, sampled by the caller without a new capture REST call. */
  exchangeObservedAtMs?: number;
  clockReference?: {
    source: 'SERVER_REQUEST_RESPONSE_BOUND' | 'CALLER_DECLARED_AS_OF';
    serverSampleAtMs: number;
    localRequestStartedAtMs: number;
    localResponseReceivedAtMs: number;
    requestRoundTripMs: number;
    contextBuiltExchangeLowerBoundMs: number;
    contextBuiltExchangeUpperBoundMs: number;
  };
  inputCaptureTiming?: {
    captureStartedAtMs: number;
    capturedAtMs: number;
    captureDurationMs: number;
    timestampClock: 'LOCAL_RECEIVE_TIME';
    durationClock: 'MONOTONIC';
    contextCaptureAtMonotonicMs?: number | null;
    decisionAtMonotonicMs?: number | null;
    localCausalContext?: LocalCausalContextEvidence;
  };
}

export class MicroBurstStrategy implements EntryStrategy<MicroBurstStrategyContext> {
  private readonly config: MicroBurstConfig;
  readonly contract: StrategyRuntimeContract;

  constructor(
    readonly identity: StrategyIdentity,
    readonly mode: StrategyMode,
    config?: Partial<MicroBurstConfig>,
  ) {
    if (identity.strategyId !== 'MICRO_BURST') {
      throw new Error(`MICRO_BURST_IDENTITY_MISMATCH:${identity.strategyId}`);
    }
    this.config = { ...defaultMicroBurstConfig(), ...config };
    this.contract = microBurstStrategyContract(identity, this.config);
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
        evaluationStatus: 'NOT_EVALUABLE',
        reason: 'MICRO_CONTEXTUAL_LIVE_IDENTITY_REQUIRED',
        diagnostics: {
          authority: 'OBSERVATION_ONLY',
          policyVersion: config.contextualPolicyVersion,
        },
      };
    }
    let replay;
    try {
      replay = captureMicroBurstReplay(context, config, this.identity.codeCommitSha);
    } catch {
      // Input capture is observational. Oversized evidence is explicitly incomplete.
    }
    const input = replay?.context ?? context;
    const decision = evaluateMicroBurstReactionEntry(
      input,
      replay?.config ?? config,
      input.executionBook,
      input.observedAtMs ?? NaN,
      input.exchangeObservedAtMs ?? input.observedAtMs ?? NaN,
    );
    return {
      symbol: context.symbol,
      timestamp: context.timestamp,
      decision: decision.action,
      evaluationStatus:
        decision.action === 'ENTRY_INTENT'
          ? 'INTENT'
          : input.dataQuality.contextValid
            ? 'REJECTED'
            : 'NOT_EVALUABLE',
      side: decision.side,
      reason: decision.reason,
      confidence: decision.confirmationStrength,
      destinationPrice: decision.targetPrice,
      structuralInvalidation: decision.stopInvalidationPrice,
      diagnostics: {
        ...decision.diagnostics,
        inputFreshness: {
          schemaVersion: 1,
          signalAsOfMs: input.timestamp,
          localDecisionAtMs: input.observedAtMs,
          exchangeDecisionAtMs: input.exchangeObservedAtMs,
          candleCloseTimeMs: input.candles.candles1m
            .filter((c) => c.closeTime <= input.timestamp)
            .slice(-1)[0]?.closeTime,
          btcEventAtMs: input.btcContext?.observedAtMs,
          flowEventAtMs: input.aggTradeFlow?.eventWatermarkMs,
          bookReceivedAtMs: input.executionBook?.observedAtMs,
        },
        ...(replay
          ? { strategyInputReplay: replay }
          : { exactInputStatus: 'OBSERVATIONAL_DROP_INPUT_LIMIT' }),
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

  validateAfterRequiredAudit(
    context: MicroBurstStrategyContext,
    decision: StrategyEvaluationResult,
    elapsedMs: number,
  ): string | undefined {
    return validateMicroBurstInputFreshness(
      decision.diagnostics.inputFreshness,
      (context.observedAtMs ?? NaN) + elapsedMs,
      { ...this.config, ...context.config },
    );
  }

  afterObservationWait(
    context: MicroBurstStrategyContext,
    elapsedMs: number,
    decisionAtMonotonicMs?: number,
  ): MicroBurstStrategyContext {
    return {
      ...context,
      observedAtMs: (context.observedAtMs ?? NaN) + elapsedMs,
      exchangeObservedAtMs:
        (context.exchangeObservedAtMs ?? context.observedAtMs ?? NaN) + elapsedMs,
      inputCaptureTiming: context.inputCaptureTiming
        ? { ...context.inputCaptureTiming, decisionAtMonotonicMs: decisionAtMonotonicMs ?? null }
        : undefined,
    };
  }
}

function microBurstStrategyContract(
  identity: StrategyIdentity,
  config: MicroBurstConfig,
): StrategyRuntimeContract {
  const contract: StrategyRuntimeContract = {
    symbols: { source: 'CALLER_CONTEXT' },
    configuration: {
      source: 'STRATEGY_INSTANCE',
      schemaVersion: 'MICRO_BURST_CONFIG_V1',
      effectiveConfigHash: identity.configHash ?? null,
      value: structuredClone(config) as unknown as Readonly<Record<string, unknown>>,
    },
    inputs: [
      {
        kind: 'CLOSED_CANDLES',
        interval: '1m',
        limit: 100,
        minimumClosed: 30,
        maximumAgeMs: config.candleFreshness1mMaxMs,
        gapPolicy: 'REJECT',
      },
      {
        kind: 'CLOSED_CANDLES',
        interval: '3m',
        limit: 80,
        minimumClosed: 20,
        maximumAgeMs: config.candleFreshness3mMaxMs,
        gapPolicy: 'REJECT',
      },
      {
        kind: 'CLOSED_CANDLES',
        interval: '5m',
        limit: 60,
        minimumClosed: 15,
        maximumAgeMs: config.candleFreshness5mMaxMs,
        gapPolicy: 'REJECT',
      },
      {
        kind: 'ORDER_BOOK',
        minimumDepthLevels: 1,
        maximumAgeMs: config.bookFreshnessMaxMs,
        sequencePolicy: 'REQUIRE_LINKED_UPDATES',
      },
      {
        kind: 'AGG_TRADE_FLOW',
        windowMs: 300_000,
        minimumObservedSamples: 0,
        continuityPolicy: 'REQUIRE_GAP_FREE',
      },
      {
        kind: 'BENCHMARK_CONTEXT',
        benchmarkId: 'PRIMARY_CRYPTO_BENCHMARK:BTCUSDT',
        intervals: ['1m', '3m', '5m'],
        maximumAgeMs: config.btcFreshnessMaxMs,
      },
    ],
    warmup: [
      { inputKind: 'CLOSED_CANDLES', minimumReadyCondition: '1m>=30 closed candles' },
      { inputKind: 'CLOSED_CANDLES', minimumReadyCondition: '3m>=20 closed candles' },
      { inputKind: 'CLOSED_CANDLES', minimumReadyCondition: '5m>=15 closed candles' },
      { inputKind: 'ORDER_BOOK', minimumReadyCondition: 'HEALTHY synchronized book' },
      { inputKind: 'AGG_TRADE_FLOW', minimumReadyCondition: 'complete gap-free 300000ms window' },
      { inputKind: 'BENCHMARK_CONTEXT', minimumReadyCondition: 'fresh BTC 1m/3m/5m context' },
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
  return freezeStrategyRuntimeContract(contract);
}
