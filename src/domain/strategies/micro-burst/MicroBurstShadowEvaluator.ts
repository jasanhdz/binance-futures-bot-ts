import { Side } from '../../types';
import { Logger } from '../../../app/ports/Logger';
import { StrategyRouter } from '../../../app/strategy/StrategyRouter';
import { StrategyDecisionEnvelope } from '../../strategy/StrategyDecision';
import { MicroBurstStrategyContext } from './MicroBurstStrategy';
import { buildMicroBurstContext, MicroBurstContextBuilderDeps } from './MicroBurstContextBuilder';
import { MicroBurstDuplicateSignalGuard } from './MicroBurstDuplicateSignalGuard';
import {
  MicroBurstShadowEvaluationResult,
  MicroBurstShadowTelemetryLog,
  MicroBurstSymbolConfig,
  MicroBurstRuntimeConfig,
} from './MicroBurstMarketDataTypes';
import { priceDistanceToBps } from './MicroBurstUnits';
import { defaultMicroBurstConfig } from './MicroBurstTypes';

interface Clock {
  now(): number;
}

interface ShadowEvaluatorDeps {
  contextBuilderDeps: MicroBurstContextBuilderDeps;
  strategyRouter: StrategyRouter<MicroBurstStrategyContext>;
  duplicateGuard: MicroBurstDuplicateSignalGuard;
  logger: Logger;
  clock: Clock;
  getServerTime(): Promise<number>;
}

export class MicroBurstShadowEvaluator {
  private readonly symbolConfigs: Map<string, MicroBurstSymbolConfig> = new Map();
  private readonly runtimeConfig: MicroBurstRuntimeConfig;

  constructor(
    private readonly deps: ShadowEvaluatorDeps,
    config: MicroBurstRuntimeConfig,
  ) {
    this.runtimeConfig = config;
    for (const [symbol, symConfig] of Object.entries(config.symbols)) {
      this.symbolConfigs.set(symbol, symConfig);
    }
  }

  async evaluate(input: { symbol: string; snapshotAtMs?: number }): Promise<MicroBurstShadowEvaluationResult> {
    const { symbol } = input;
    const symConfig = this.symbolConfigs.get(symbol);

    if (!symConfig || !symConfig.enabled) {
      return this.buildDisabledResult(symbol, input.snapshotAtMs ?? this.deps.clock.now());
    }

    if (this.runtimeConfig.mode === 'OFF') {
      return this.buildDisabledResult(symbol, input.snapshotAtMs ?? this.deps.clock.now());
    }

    const snapshotAtMs = input.snapshotAtMs ?? await this.deps.getServerTime();

    try {
      const context = await buildMicroBurstContext(
        symbol,
        this.deps.contextBuilderDeps,
        {
          snapshotAtMs,
          config: symConfig.btcConflictThresholdBps !== undefined
            ? { btcConflictThresholdBps: symConfig.btcConflictThresholdBps }
            : undefined,
        },
      );

      const strategyContext: MicroBurstStrategyContext = {
        ...context,
      };

      const envelope: StrategyDecisionEnvelope = await this.deps.strategyRouter.evaluate(
        'MICRO_BURST_V1',
        strategyContext,
      );

      const referencePrice = context.marketPriceAtSnapshot ?? context.currentPrice;

      const supportPrice = context.levels.nearest.support?.price ?? null;
      const resistancePrice = context.levels.nearest.resistance?.price ?? null;
      const structuralInvalidation = envelope.structuralInvalidation ?? null;
      const destinationPrice = envelope.destinationPrice ?? null;

      const roomToTargetBps = envelope.destinationPrice && referencePrice > 0
        ? priceDistanceToBps(referencePrice, envelope.destinationPrice)
        : null;
      const riskToInvalidationBps = envelope.structuralInvalidation && referencePrice > 0
        ? priceDistanceToBps(referencePrice, envelope.structuralInvalidation)
        : null;
      const rewardRisk = roomToTargetBps !== null && riskToInvalidationBps !== null && riskToInvalidationBps > 0
        ? roomToTargetBps / riskToInvalidationBps
        : null;

      const wouldEnter = envelope.decision === 'ENTRY_INTENT';

      let shadowSignalId = '';
      let duplicateSuppressed = false;
      let firstObservedAt = snapshotAtMs;
      let lastObservedAt = snapshotAtMs;

      if (wouldEnter && envelope.side) {
        const signalResult = this.deps.duplicateGuard.check(
          'MICRO_BURST_V1',
          symbol,
          envelope.side,
          structuralInvalidation ?? 0,
          snapshotAtMs,
        );
        shadowSignalId = signalResult.shadowSignalId;
        duplicateSuppressed = signalResult.duplicateSuppressed;
        firstObservedAt = signalResult.firstObservedAt;
        lastObservedAt = signalResult.lastObservedAt;
      }

      const result: MicroBurstShadowEvaluationResult = {
        strategyId: 'MICRO_BURST_V1',
        strategyVersion: '0.2.0-correctness',
        symbol,
        snapshotAtMs,
        decision: envelope.decision,
        side: envelope.side,
        confidence: envelope.confidence ?? 0,
        referencePrice,
        supportPrice,
        resistancePrice,
        structuralInvalidation,
        destinationPrice,
        roomToTargetBps,
        riskToInvalidationBps,
        rewardRisk,
        momentum: {
          direction: context.momentum.direction,
          strength: context.momentum.strength,
          continuationScore: context.momentum.continuationScore,
        },
        book: {
          status: context.bookPressure.status,
          ageMs: context.dataQuality.bookAgeMs,
          imbalance: context.bookPressure.topOfBookImbalance,
          imbalanceSlope: context.bookPressure.imbalanceSlope,
        },
        btc: {
          status: context.dataQuality.btcStatus,
          ageMs: context.dataQuality.btcAgeMs,
          ret1m: context.btcContext?.ret1m ?? null,
          ret3m: context.btcContext?.ret3m ?? null,
          ret5m: context.btcContext?.ret5m ?? null,
          conflict: context.btcContext?.conflictFlag ?? false,
        },
        microRegime: context.microRegime,
        dataQuality: {
          contextValid: context.dataQuality.contextValid,
          invalidReasons: context.dataQuality.invalidReasons,
        },
        wouldEnter,
        liveExecution: false as const,
        shadowSignalId,
        duplicateSuppressed,
        firstObservedAt,
        lastObservedAt,
        diagnostics: envelope.diagnostics,
      };

      this.logTelemetry(result);

      return result;
    } catch (err) {
      this.deps.logger.error('MicroBurst shadow evaluation failed', {
        symbol,
        error: String(err),
      });
      return this.buildErrorResult(symbol, snapshotAtMs, String(err));
    }
  }

  private logTelemetry(result: MicroBurstShadowEvaluationResult): void {
    const log: MicroBurstShadowTelemetryLog = {
      strategyId: result.strategyId,
      strategyVersion: result.strategyVersion,
      symbol: result.symbol,
      snapshotAtMs: result.snapshotAtMs,
      decision: result.decision,
      side: result.side,
      confidence: result.confidence,
      referencePrice: result.referencePrice,
      support: result.supportPrice,
      resistance: result.resistancePrice,
      structuralInvalidation: result.structuralInvalidation,
      target: result.destinationPrice,
      roomToTargetBps: result.roomToTargetBps,
      riskToInvalidationBps: result.riskToInvalidationBps,
      rewardRisk: result.rewardRisk,
      momentum: result.momentum,
      bookStatus: result.book.status,
      bookAgeMs: result.book.ageMs,
      bookImbalance: result.book.imbalance,
      imbalanceSlope: result.book.imbalanceSlope,
      btcStatus: result.btc.status,
      btcAgeMs: result.btc.ageMs,
      btcRet1m: result.btc.ret1m,
      btcRet3m: result.btc.ret3m,
      btcRet5m: result.btc.ret5m,
      btcConflict: result.btc.conflict,
      microRegime: result.microRegime,
      dataQualityContextValid: result.dataQuality.contextValid,
      invalidReasons: result.dataQuality.invalidReasons,
      wouldEnter: result.wouldEnter,
      liveExecution: false as const,
      shadowSignalId: result.shadowSignalId,
      duplicateSuppressed: result.duplicateSuppressed,
      firstObservedAt: result.firstObservedAt,
      lastObservedAt: result.lastObservedAt,
    };

    if (result.wouldEnter) {
      this.deps.logger.info('micro_burst_shadow_entry_intent', log as unknown as Record<string, unknown>);
    } else {
      this.deps.logger.debug('micro_burst_shadow_no_trade', log as unknown as Record<string, unknown>);
    }
  }

  private buildDisabledResult(symbol: string, snapshotAtMs: number): MicroBurstShadowEvaluationResult {
    return {
      strategyId: 'MICRO_BURST_V1',
      strategyVersion: '0.2.0-correctness',
      symbol,
      snapshotAtMs,
      decision: 'NO_TRADE',
      confidence: 0,
      referencePrice: 0,
      supportPrice: null,
      resistancePrice: null,
      structuralInvalidation: null,
      destinationPrice: null,
      roomToTargetBps: null,
      riskToInvalidationBps: null,
      rewardRisk: null,
      momentum: { direction: 'NEUTRAL', strength: 0, continuationScore: 0 },
      book: { status: 'UNAVAILABLE', ageMs: null, imbalance: 0, imbalanceSlope: null },
      btc: { status: 'UNAVAILABLE', ageMs: null, ret1m: null, ret3m: null, ret5m: null, conflict: false },
      microRegime: 'RANGING',
      dataQuality: { contextValid: false, invalidReasons: ['strategy_disabled'] },
      wouldEnter: false,
      liveExecution: false as const,
      shadowSignalId: '',
      duplicateSuppressed: false,
      firstObservedAt: snapshotAtMs,
      lastObservedAt: snapshotAtMs,
      diagnostics: { strategyDisabled: true },
    };
  }

  private buildErrorResult(
    symbol: string,
    snapshotAtMs: number,
    error: string,
  ): MicroBurstShadowEvaluationResult {
    return {
      strategyId: 'MICRO_BURST_V1',
      strategyVersion: '0.2.0-correctness',
      symbol,
      snapshotAtMs,
      decision: 'NO_TRADE',
      confidence: 0,
      referencePrice: 0,
      supportPrice: null,
      resistancePrice: null,
      structuralInvalidation: null,
      destinationPrice: null,
      roomToTargetBps: null,
      riskToInvalidationBps: null,
      rewardRisk: null,
      momentum: { direction: 'NEUTRAL', strength: 0, continuationScore: 0 },
      book: { status: 'UNAVAILABLE', ageMs: null, imbalance: 0, imbalanceSlope: null },
      btc: { status: 'UNAVAILABLE', ageMs: null, ret1m: null, ret3m: null, ret5m: null, conflict: false },
      microRegime: 'RANGING',
      dataQuality: { contextValid: false, invalidReasons: ['evaluation_error'] },
      wouldEnter: false,
      liveExecution: false as const,
      shadowSignalId: '',
      duplicateSuppressed: false,
      firstObservedAt: snapshotAtMs,
      lastObservedAt: snapshotAtMs,
      diagnostics: { evaluationError: error },
    };
  }
}
