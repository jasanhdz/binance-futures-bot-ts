import type { StrategyDecisionObservationHook } from '../blackbox/StrategyDecisionObservation';
import { StrategyDecisionEnvelope, StrategyEvaluationResult } from './StrategyDecision';
import { EntryStrategy, StrategyDataReadiness } from './EntryStrategy';
import { StrategyId } from './StrategyIdentity';
import { randomUUID } from 'node:crypto';

export class StrategyRouter<TContext = unknown> {
  private readonly strategies = new Map<StrategyId, EntryStrategy<TContext>>();
  private observationHook?: StrategyDecisionObservationHook<TContext>;
  private lastObservationHealth?: Readonly<Record<string, unknown>>;

  constructor(observationHook?: StrategyDecisionObservationHook<TContext>) {
    this.observationHook = observationHook;
  }

  /** Runtime composition hook. Observation remains side-effect-only and may be detached on shutdown. */
  setObservationHook(observationHook?: StrategyDecisionObservationHook<TContext>): void {
    this.observationHook = observationHook;
  }

  async closeObservation(): Promise<void> {
    const hook = this.observationHook;
    this.observationHook = undefined;
    await hook?.close?.();
    this.lastObservationHealth = hook?.observationHealth?.();
  }

  observationHealth(): Readonly<Record<string, unknown>> | undefined {
    return this.observationHook?.observationHealth?.() ?? this.lastObservationHealth;
  }

  register(strategy: EntryStrategy<TContext>): void {
    const strategyId = strategy.identity.strategyId;
    if (this.strategies.has(strategyId)) {
      throw new Error(`STRATEGY_ALREADY_REGISTERED:${strategyId}`);
    }
    if (strategy.contract && strategy.contract.positionLifecycle.managerStrategyId !== strategyId)
      throw new Error(`STRATEGY_CONTRACT_POSITION_OWNER_MISMATCH:${strategyId}`);
    if (
      strategy.contract &&
      strategy.contract.configuration.effectiveConfigHash !== null &&
      strategy.contract.configuration.effectiveConfigHash !== (strategy.identity.configHash ?? null)
    )
      throw new Error(`STRATEGY_CONTRACT_CONFIG_HASH_MISMATCH:${strategyId}`);
    if (strategy.contract) validateStrategyContract(strategyId, strategy.contract);
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

  /** Declared inputs/warmup/configuration for a registered strategy, if migrated. */
  contract(strategyId: StrategyId): EntryStrategy<TContext>['contract'] {
    return this.strategies.get(strategyId)?.contract;
  }

  /**
   * Evaluate from one explicit readiness snapshot. Incomplete/invalid input returns
   * before observation or strategy evaluation; the context factory receives the exact
   * snapshot used to produce the readiness result.
   */
  async evaluateWithReadiness<TSnapshot>(
    strategyId: StrategyId,
    readiness: StrategyDataReadiness<TSnapshot>,
    contextFromSnapshot: (
      snapshot: TSnapshot,
    ) => TContext & { readonly marketDataSnapshot: TSnapshot },
  ): Promise<StrategyDecisionEnvelope> {
    const strategy = this.strategies.get(strategyId);
    if (!strategy) throw new Error(`STRATEGY_NOT_REGISTERED:${strategyId}`);
    if (!strategy.contract)
      throw new Error(`STRATEGY_CONTRACT_REQUIRED_FOR_READINESS:${strategyId}`);

    const context = contextFromSnapshot(readiness.snapshot);
    if (context.marketDataSnapshot !== readiness.snapshot)
      throw new Error('STRATEGY_READINESS_CONTEXT_SNAPSHOT_MISMATCH');
    const snapshotSymbol = extractSymbol(readiness.snapshot);
    const symbol = extractSymbol(context);
    if (snapshotSymbol !== 'UNKNOWN' && symbol !== snapshotSymbol)
      throw new Error('STRATEGY_READINESS_CONTEXT_SYMBOL_MISMATCH');
    if (strategy.mode === 'OFF')
      return {
        identity: strategy.identity,
        mode: strategy.mode,
        symbol,
        timestamp: Date.now(),
        decision: 'NO_TRADE',
        evaluationStatus: 'NOT_EVALUABLE',
        reason: 'strategy_off',
        diagnostics: { routerBlocked: true },
      };

    if (readiness.status !== 'READY')
      return {
        identity: strategy.identity,
        mode: strategy.mode,
        symbol,
        timestamp: Date.now(),
        decision: 'NO_TRADE',
        evaluationStatus: readiness.status,
        reason: readiness.reasons[0] ?? `STRATEGY_DATA_${readiness.status}`,
        diagnostics: {
          sharedMarketDataReadiness: {
            status: readiness.status,
            reasons: [...readiness.reasons],
            evidence: readiness.diagnostics,
          },
        },
      };

    const envelope = await this.evaluate(strategyId, context);
    return {
      ...envelope,
      diagnostics: {
        ...envelope.diagnostics,
        sharedMarketDataReadiness: {
          status: 'READY',
          reasons: [...readiness.reasons],
          evidence: readiness.diagnostics,
        },
      },
    };
  }

  async evaluate(strategyId: StrategyId, context: TContext): Promise<StrategyDecisionEnvelope> {
    const strategy = this.strategies.get(strategyId);
    if (!strategy) {
      throw new Error(`STRATEGY_NOT_REGISTERED:${strategyId}`);
    }

    const hook = this.observationHook;
    const waitStarted = performance.now();
    let snapshot: Awaited<
      ReturnType<StrategyDecisionObservationHook<TContext>['beforeEvaluation']>
    > = null;
    const exact = !!hook?.captureExactInput && !!hook.enqueueExactDecision;
    if (exact) {
      try {
        const captured = hook!.captureExactInput!(strategyId, context);
        if (captured) {
          context = captured.context;
          snapshot = captured.snapshot;
        }
      } catch {
        /* Observational capture failure does not confer execution authority. */
      }
    } else {
      snapshot = await this.captureObservation(strategyId, context);
    }
    context =
      strategy.afterObservationWait?.(
        context,
        performance.now() - waitStarted,
        performance.now(),
      ) ?? context;
    const evaluationStartedAtMs = Date.now();
    const evaluationStartedMono = performance.now();

    let envelope: StrategyDecisionEnvelope;
    if (strategy.mode === 'OFF') {
      envelope = {
        identity: strategy.identity,
        mode: strategy.mode,
        symbol: extractSymbol(context),
        timestamp: Date.now(),
        decision: 'NO_TRADE',
        evaluationStatus: 'NOT_EVALUABLE',
        reason: 'strategy_off',
        diagnostics: { routerBlocked: true },
      };
    } else {
      const decision = await strategy.evaluate(context);
      validateDecision(decision);
      envelope = {
        identity: strategy.identity,
        mode: strategy.mode,
        ...decision,
        evaluationStatus:
          decision.evaluationStatus ??
          (decision.decision === 'ENTRY_INTENT'
            ? 'INTENT'
            : strategy.contract
              ? 'NOT_EVALUABLE'
              : 'REJECTED'),
      };
    }

    const evaluationFinishedAtMs = Date.now();
    const evaluationFinishedAtMono = performance.now();
    if (exact)
      envelope = {
        ...envelope,
        diagnostics: {
          ...envelope.diagnostics,
          decisionId: randomUUID(),
          evaluationTiming: {
            evaluationStartedAtMs,
            evaluationFinishedAtMs,
            evaluationStartedAtMonotonicMs: evaluationStartedMono,
            evaluationFinishedAtMonotonicMs: evaluationFinishedAtMono,
            processGenerationId: extractProcessGenerationId(context),
            evaluationDurationMs: performance.now() - evaluationStartedMono,
            durationClock: 'MONOTONIC',
            timestampClock: 'LOCAL_RECEIVE_TIME',
          },
        },
      };
    if (hook?.requiredAudit && envelope.decision === 'ENTRY_INTENT') {
      const auditStartedMono = performance.now();
      const auditStartedAtMs = Date.now();
      try {
        await hook.requiredAudit.acknowledge(envelope);
        const auditFinishedAtMs = Date.now();
        const auditDurationMs = performance.now() - auditStartedMono;
        const reason = strategy.validateAfterRequiredAudit?.(
          context,
          envelope,
          performance.now() - evaluationStartedMono,
        );
        envelope = {
          ...envelope,
          diagnostics: {
            ...envelope.diagnostics,
            requiredAuditAcknowledged: true,
            requiredAuditTiming: {
              auditStartedAtMs,
              auditFinishedAtMs,
              durationMs: auditDurationMs,
              durationClock: 'MONOTONIC',
            },
          },
        };
        if (reason)
          envelope = {
            identity: envelope.identity,
            mode: envelope.mode,
            symbol: envelope.symbol,
            timestamp: envelope.timestamp,
            decision: 'NO_TRADE',
            evaluationStatus: 'REJECTED',
            reason,
            diagnostics: {
              ...envelope.diagnostics,
              postAuditAdmissionRejected: true,
              evaluatedDecision: 'ENTRY_INTENT',
            },
          };
      } catch {
        envelope = {
          identity: envelope.identity,
          mode: envelope.mode,
          symbol: envelope.symbol,
          timestamp: envelope.timestamp,
          decision: 'NO_TRADE',
          evaluationStatus: 'NOT_EVALUABLE',
          reason: 'REQUIRED_DECISION_AUDIT_FAILED',
          diagnostics: {
            ...envelope.diagnostics,
            requiredAuditAcknowledged: false,
            requiredAuditTiming: {
              auditStartedAtMs,
              auditFinishedAtMs: Date.now(),
              durationMs: performance.now() - auditStartedMono,
              durationClock: 'MONOTONIC',
            },
          },
        };
      }
    }
    if (exact) {
      if (snapshot) {
        try {
          const status = hook!.enqueueExactDecision!(snapshot, envelope);
          envelope = {
            ...envelope,
            diagnostics: { ...envelope.diagnostics, exactInputObservation: status ?? 'SUBMITTED' },
          };
        } catch {
          envelope = {
            ...envelope,
            diagnostics: { ...envelope.diagnostics, exactInputObservation: 'OBSERVATIONAL_DROP' },
          };
        }
      } else {
        envelope = {
          ...envelope,
          diagnostics: {
            ...envelope.diagnostics,
            exactInputObservation: 'OBSERVATIONAL_DROP_CAPTURE',
          },
        };
      }
    } else await this.persistObservation(snapshot, envelope);
    return envelope;
  }

  private async captureObservation(
    strategyId: StrategyId,
    context: TContext,
  ): Promise<Awaited<ReturnType<StrategyDecisionObservationHook<TContext>['beforeEvaluation']>>> {
    if (!this.observationHook) return null;
    try {
      return await this.observationHook.beforeEvaluation(strategyId, context);
    } catch {
      return null;
    }
  }

  private async persistObservation(
    snapshot: Awaited<ReturnType<StrategyDecisionObservationHook<TContext>['beforeEvaluation']>>,
    envelope: StrategyDecisionEnvelope,
  ): Promise<void> {
    if (!this.observationHook || !snapshot) return;
    try {
      await this.observationHook.afterEvaluation(snapshot, envelope);
    } catch {
      // Phase T is observational. Evidence failures must not alter trading semantics.
    }
  }
}

function validateDecision(decision: StrategyEvaluationResult): void {
  if (decision.decision === 'ENTRY_INTENT' && !decision.side) {
    throw new Error('STRATEGY_ENTRY_INTENT_MISSING_SIDE');
  }
  if (!decision.symbol || !Number.isFinite(decision.timestamp)) {
    throw new Error('STRATEGY_DECISION_INVALID_IDENTITY_FIELDS');
  }
  if (
    (decision.decision === 'ENTRY_INTENT' &&
      decision.evaluationStatus !== undefined &&
      decision.evaluationStatus !== 'INTENT') ||
    (decision.decision === 'NO_TRADE' && decision.evaluationStatus === 'INTENT')
  )
    throw new Error('STRATEGY_EVALUATION_STATUS_CONFLICT');
}

function validateStrategyContract(
  strategyId: StrategyId,
  contract: NonNullable<EntryStrategy['contract']>,
): void {
  if (
    !contract.configuration.schemaVersion ||
    !contract.entryState.schemaVersion ||
    !Number.isSafeInteger(contract.entryState.schemaVersion) ||
    contract.entryState.schemaVersion <= 0 ||
    !Number.isSafeInteger(contract.positionLifecycle.stateSchemaVersion) ||
    contract.positionLifecycle.stateSchemaVersion <= 0
  )
    throw new Error(`STRATEGY_CONTRACT_SCHEMA_INVALID:${strategyId}`);
  const candleIntervals = new Set<string>();
  for (const input of contract.inputs) {
    if (input.kind === 'CLOSED_CANDLES') {
      if (
        !input.interval ||
        !Number.isSafeInteger(input.limit) ||
        !Number.isSafeInteger(input.minimumClosed) ||
        input.limit < input.minimumClosed ||
        input.minimumClosed <= 0 ||
        (input.maximumAgeMs !== null &&
          (!Number.isFinite(input.maximumAgeMs) || input.maximumAgeMs < 0)) ||
        candleIntervals.has(input.interval)
      )
        throw new Error(`STRATEGY_CONTRACT_CANDLE_REQUIREMENT_INVALID:${strategyId}`);
      candleIntervals.add(input.interval);
    } else if (input.kind === 'ORDER_BOOK') {
      if (
        !Number.isSafeInteger(input.minimumDepthLevels) ||
        input.minimumDepthLevels <= 0 ||
        !Number.isFinite(input.maximumAgeMs) ||
        input.maximumAgeMs < 0
      )
        throw new Error(`STRATEGY_CONTRACT_ORDER_BOOK_REQUIREMENT_INVALID:${strategyId}`);
    } else if (input.kind === 'AGG_TRADE_FLOW') {
      if (
        !Number.isFinite(input.windowMs) ||
        input.windowMs <= 0 ||
        !Number.isSafeInteger(input.minimumObservedSamples) ||
        input.minimumObservedSamples < 0 ||
        (input.maximumAgeMs !== undefined &&
          (!Number.isFinite(input.maximumAgeMs) || input.maximumAgeMs < 0))
      )
        throw new Error(`STRATEGY_CONTRACT_FLOW_REQUIREMENT_INVALID:${strategyId}`);
    } else if (input.kind === 'BENCHMARK_CONTEXT') {
      if (
        !input.benchmarkId ||
        !input.intervals.length ||
        !Number.isFinite(input.maximumAgeMs) ||
        input.maximumAgeMs < 0
      )
        throw new Error(`STRATEGY_CONTRACT_BENCHMARK_REQUIREMENT_INVALID:${strategyId}`);
    } else if (
      !input.schemaVersion ||
      !input.requiredFields.length ||
      !Number.isFinite(input.maximumAgeMs) ||
      input.maximumAgeMs < 0
    )
      throw new Error(`STRATEGY_CONTRACT_FEATURE_REQUIREMENT_INVALID:${strategyId}`);
  }
  if (!contract.modelFeatureSchema) return;
  const featureSchema = contract.modelFeatureSchema;
  if (!featureSchema.schemaId || !featureSchema.version || featureSchema.features.length === 0)
    throw new Error(`STRATEGY_CONTRACT_FEATURE_SCHEMA_INVALID:${strategyId}`);
  const featureNames = new Set<string>();
  featureSchema.features.forEach((feature, index) => {
    if (
      !feature.name ||
      featureNames.has(feature.name) ||
      feature.order !== index ||
      !feature.units ||
      !feature.version ||
      !feature.availability.requiredEvidence.length
    )
      throw new Error(`STRATEGY_CONTRACT_FEATURE_DEFINITION_INVALID:${strategyId}`);
    featureNames.add(feature.name);
  });
}

function extractSymbol(context: unknown): string {
  if (context && typeof context === 'object' && 'symbol' in context) {
    const symbol = (context as { symbol?: unknown }).symbol;
    if (typeof symbol === 'string') return symbol;
  }
  return 'UNKNOWN';
}

function extractProcessGenerationId(context: unknown): string | null {
  if (!context || typeof context !== 'object' || !('inputCaptureTiming' in context)) return null;
  const timing = (context as { inputCaptureTiming?: unknown }).inputCaptureTiming;
  if (!timing || typeof timing !== 'object' || !('localCausalContext' in timing)) return null;
  const causal = (timing as { localCausalContext?: unknown }).localCausalContext;
  if (!causal || typeof causal !== 'object' || !('processGenerationId' in causal)) return null;
  const processGenerationId = (causal as { processGenerationId?: unknown }).processGenerationId;
  return typeof processGenerationId === 'string' ? processGenerationId : null;
}
