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
import { captureMicroBurstReplay } from './MicroBurstExactReplay';
import { validateMicroBurstInputFreshness } from './MicroBurstInputFreshness';

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
  };
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
  ): MicroBurstStrategyContext {
    return {
      ...context,
      observedAtMs: (context.observedAtMs ?? NaN) + elapsedMs,
      exchangeObservedAtMs:
        (context.exchangeObservedAtMs ?? context.observedAtMs ?? NaN) + elapsedMs,
    };
  }
}
