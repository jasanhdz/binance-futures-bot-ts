import type {
  DecisionEvidenceSink,
  MarketSnapshotEvidenceSink,
} from '../../core/blackbox/StrategyDecisionBlackBox';
import type { MarketSnapshotV1 } from '../../core/market-data/MarketSnapshotProvider';
import type { StrategyIdentity } from '../../core/strategy/StrategyIdentity';
import type { StrategyRouter } from '../../core/strategy/StrategyRouter';
import { createReadOnlyAuditedExchange } from '../../infra/adapters/ReadOnlyAuditedExchange';
import { AegisBlackBoxObservation } from '../../strategies/aegis/application/AegisBlackBoxObservation';
import {
  AegisRealtimeMarketState,
  type AegisRealtimeMarketSnapshot,
} from '../../strategies/aegis/application/AegisRealtimeMarketState';
import {
  MicroBurstRuntime,
  type MicroBurstRuntimeDeps,
  type MicroBurstRuntimeReadiness,
} from '../../strategies/micro-burst/application/MicroBurstRuntime';
import type { MicroBurstRuntimeConfig } from '../../strategies/micro-burst/application/MicroBurstRuntimeTypes';
import type {
  MicroBurstExitMarketSnapshot,
  MicroBurstLiveEntryRequest,
} from '../../strategies/micro-burst/application/MicroBurstRuntimeTypes';
import type { MicroBurstStrategyContext } from '../../strategies/micro-burst/domain/MicroBurstStrategy';
import { MicroBurstOutcomeJournal } from '../../strategies/micro-burst/research/MicroBurstOutcomeJournal';
import { MicroBurstOutcomeTracker } from '../../strategies/micro-burst/research/MicroBurstOutcomeTracker';
import { MicroBurstStorage } from '../../strategies/micro-burst/research/MicroBurstStorage';
import { MomentumRideBlackBoxObservation } from '../../strategies/momentum/application/MomentumRideBlackBoxObservation';
import {
  MomentumCandleState,
  type MomentumCandleSnapshot,
} from '../../strategies/momentum/application/MomentumCandleState';
import {
  MomentumRealtimeMarketState,
  type MomentumRealtimeMarketSnapshot,
} from '../../strategies/momentum/application/MomentumRealtimeMarketState';
import type { MomentumRideStrategyContext } from '../../strategies/momentum/domain/MomentumRideStrategy';
import type { Exchange } from '../ports/Exchange';
import type { Logger } from '../ports/Logger';
import type { LiquidityVoidDetector } from '../services/LiquidityVoidDetector';
import { SharedMarketDataRuntime } from '../services/SharedMarketDataRuntime';
import { buildMarketDataDiagnostics } from '../diagnostics/MarketDataDiagnostics';
import { AEGIS_CURRENT_BRAIN_CANONICAL_SYMBOLS } from '../../strategies/aegis/application/AegisMarketContext';
import { getRateLimitMetrics } from '../../infra/adapters/rate-limit';

export type MicroBurstRuntimeProvenance = NonNullable<MicroBurstRuntimeDeps['provenance']>;

export interface StrategyRuntimeCoordinatorDeps {
  exchange: Exchange;
  logger: Logger;
  clock: { now(): number };
  aegisIdentity: StrategyIdentity;
  momentumStrategyRouter: StrategyRouter<MomentumRideStrategyContext>;
  microBurstStrategyRouter: StrategyRouter<MicroBurstStrategyContext>;
  decisionSink: DecisionEvidenceSink;
  marketSnapshotSink: MarketSnapshotEvidenceSink;
  microBurstLiveTrading?: {
    open(request: MicroBurstLiveEntryRequest): Promise<boolean>;
  };
}

export interface StrategyRuntimeStartInput {
  symbols: readonly string[];
  microBurstConfig: MicroBurstRuntimeConfig;
  loadMicroBurstProvenance?: () => MicroBurstRuntimeProvenance;
}

export interface StrategyRuntimeCoordinatorFactories {
  createSharedMarketDataRuntime(
    deps: ConstructorParameters<typeof SharedMarketDataRuntime>[0],
  ): SharedMarketDataRuntime;
  createAegisRealtimeMarketState(
    deps: ConstructorParameters<typeof AegisRealtimeMarketState>[0],
  ): AegisRealtimeMarketState;
  createMomentumRealtimeMarketState(
    deps: ConstructorParameters<typeof MomentumRealtimeMarketState>[0],
  ): MomentumRealtimeMarketState;
  createMomentumCandleState(sharedMarketData: SharedMarketDataRuntime): MomentumCandleState;
  createAegisBlackBoxObservation(
    deps: ConstructorParameters<typeof AegisBlackBoxObservation>[0],
  ): AegisBlackBoxObservation;
  createMomentumBlackBoxObservation(
    deps: ConstructorParameters<typeof MomentumRideBlackBoxObservation>[0],
  ): MomentumRideBlackBoxObservation;
}

const DEFAULT_FACTORIES: StrategyRuntimeCoordinatorFactories = {
  createSharedMarketDataRuntime: (deps) => new SharedMarketDataRuntime(deps),
  createAegisRealtimeMarketState: (deps) => new AegisRealtimeMarketState(deps),
  createMomentumRealtimeMarketState: (deps) => new MomentumRealtimeMarketState(deps),
  createMomentumCandleState: (sharedMarketData) => new MomentumCandleState(sharedMarketData),
  createAegisBlackBoxObservation: (deps) => new AegisBlackBoxObservation(deps),
  createMomentumBlackBoxObservation: (deps) => new MomentumRideBlackBoxObservation(deps),
};

/**
 * Owns construction and lifecycle of strategy-facing market runtimes.
 *
 * TradingService retains operational orchestration and trading authority. This
 * coordinator only owns observational/read-only runtime state and exposes typed
 * views to the strategies. It has no strategy execution port.
 */
export class StrategyRuntimeCoordinator {
  private readonly factories: StrategyRuntimeCoordinatorFactories;
  private sharedMarketDataRuntime: SharedMarketDataRuntime | null = null;
  private aegisBlackBoxObservation: AegisBlackBoxObservation | null = null;
  private aegisRealtimeMarketState: AegisRealtimeMarketState | null = null;
  private momentumBlackBoxObservation: MomentumRideBlackBoxObservation | null = null;
  private momentumRealtimeMarketState: MomentumRealtimeMarketState | null = null;
  private momentumCandleState: MomentumCandleState | null = null;
  private microBurstRuntime: MicroBurstRuntime | null = null;
  private microBurstReadiness: MicroBurstRuntimeReadiness | null = null;

  constructor(
    private readonly deps: StrategyRuntimeCoordinatorDeps,
    factories: Partial<StrategyRuntimeCoordinatorFactories> = {},
  ) {
    this.factories = { ...DEFAULT_FACTORIES, ...factories };
  }

  hasAegisRealtimeMarketState(): boolean {
    return this.aegisRealtimeMarketState !== null;
  }

  aegisDetectorFor(symbol: string): LiquidityVoidDetector | undefined {
    return this.aegisRealtimeMarketState?.detectorFor(symbol);
  }

  readAegisRealtimeMarket(symbol: string): AegisRealtimeMarketSnapshot | undefined {
    return this.aegisRealtimeMarketState?.read(symbol);
  }

  getAegisCandles(
    symbol: string,
    limit: number,
  ): ReturnType<AegisRealtimeMarketState['getCandles']> {
    return this.aegisRealtimeMarketState?.getCandles(symbol, limit) ?? [];
  }

  readMomentumRealtimeMarket(symbol: string): MomentumRealtimeMarketSnapshot | undefined {
    return this.momentumRealtimeMarketState?.read(symbol);
  }

  async readMomentumCandles(
    symbol: string,
    limit: number,
  ): Promise<MomentumCandleSnapshot | undefined> {
    return this.momentumCandleState?.read(symbol, limit);
  }

  async captureAegisDecision(symbol: string): Promise<MarketSnapshotV1 | null | undefined> {
    return this.aegisBlackBoxObservation?.capture(symbol);
  }

  async observeAegisDecision(
    snapshot: MarketSnapshotV1 | null,
    input: Parameters<AegisBlackBoxObservation['observe']>[1],
  ): Promise<void> {
    await this.aegisBlackBoxObservation?.observe(snapshot, input);
  }

  getMicroBurstReadiness(): MicroBurstRuntimeReadiness | null {
    return this.microBurstReadiness;
  }

  readMicroBurstExitMarket(symbol: string, sinceMs?: number): MicroBurstExitMarketSnapshot | null {
    return this.microBurstRuntime?.readExitMarketSnapshot(symbol, sinceMs) ?? null;
  }

  getMarketDataDiagnostics(): Record<string, unknown> {
    const exchangeRuntime = this.deps.exchange as unknown as {
      wsManager?: {
        getMarketDataHealth(): readonly {
          stream: string;
          consumers: number;
          status: string;
          lastMessageAtMs?: number;
          reconnectCount: number;
        }[];
      };
    };
    const diagnostics = buildMarketDataDiagnostics(this.sharedMarketDataRuntime!, {
      symbols: AEGIS_CURRENT_BRAIN_CANONICAL_SYMBOLS,
      streams: exchangeRuntime.wsManager?.getMarketDataHealth(),
      rateLimit: getRateLimitMetrics(),
    });
    const summary = diagnostics.summary as Record<string, unknown>;
    summary.depthSnapshotMetrics = this.sharedMarketDataRuntime?.getDepthSnapshotMetrics();
    return diagnostics;
  }

  async start(input: StrategyRuntimeStartInput): Promise<void> {
    const { exchange, logger, clock } = this.deps;
    const startupSymbols = [...input.symbols];

    this.sharedMarketDataRuntime ??= this.factories.createSharedMarketDataRuntime({
      exchange,
      logger,
      clock,
    });
    this.aegisRealtimeMarketState ??= this.factories.createAegisRealtimeMarketState({
      sharedMarketData: this.sharedMarketDataRuntime,
      logger,
      clock,
    });
    this.aegisRealtimeMarketState.start(startupSymbols);

    this.momentumRealtimeMarketState ??= this.factories.createMomentumRealtimeMarketState({
      sharedMarketData: this.sharedMarketDataRuntime,
      clock,
    });
    this.momentumRealtimeMarketState.start(startupSymbols);

    this.momentumCandleState ??= this.factories.createMomentumCandleState(
      this.sharedMarketDataRuntime,
    );
    this.momentumCandleState.start(startupSymbols);

    this.aegisBlackBoxObservation ??= this.factories.createAegisBlackBoxObservation({
      exchange,
      sharedMarketData: this.sharedMarketDataRuntime,
      identity: this.deps.aegisIdentity,
      clock,
      decisionSink: this.deps.decisionSink,
      marketSnapshotSink: this.deps.marketSnapshotSink,
    });
    this.aegisBlackBoxObservation.start(startupSymbols);

    this.momentumBlackBoxObservation ??= this.factories.createMomentumBlackBoxObservation({
      exchange,
      sharedMarketData: this.sharedMarketDataRuntime,
      clock,
      decisionSink: this.deps.decisionSink,
      marketSnapshotSink: this.deps.marketSnapshotSink,
    });
    this.momentumBlackBoxObservation.start(startupSymbols);
    this.deps.momentumStrategyRouter.setObservationHook(this.momentumBlackBoxObservation);

    if (input.microBurstConfig.enabled && input.microBurstConfig.mode !== 'OFF') {
      await this.startMicroBurst(input.microBurstConfig, input.loadMicroBurstProvenance);
    }
  }

  async stop(): Promise<void> {
    const microBurstRuntime = this.microBurstRuntime;
    this.microBurstRuntime = null;

    this.aegisBlackBoxObservation?.close();
    this.aegisBlackBoxObservation = null;
    this.aegisRealtimeMarketState?.close();
    this.aegisRealtimeMarketState = null;
    this.deps.momentumStrategyRouter.setObservationHook(undefined);
    this.momentumBlackBoxObservation?.close();
    this.momentumBlackBoxObservation = null;
    this.momentumRealtimeMarketState?.close();
    this.momentumRealtimeMarketState = null;
    this.momentumCandleState?.close();
    this.momentumCandleState = null;
    await microBurstRuntime?.stop();
    this.sharedMarketDataRuntime?.close();
    this.sharedMarketDataRuntime = null;
  }

  private async startMicroBurst(
    config: MicroBurstRuntimeConfig,
    loadProvenance?: () => MicroBurstRuntimeProvenance,
  ): Promise<void> {
    if (!this.sharedMarketDataRuntime) {
      throw new Error('STRATEGY_RUNTIME_SHARED_MARKET_DATA_NOT_STARTED');
    }

    try {
      const provenance = loadProvenance?.();
      const readOnlyExchange = createReadOnlyAuditedExchange(
        this.deps.exchange,
        provenance?.codeCommitSha ?? 'UNKNOWN',
      );
      const archiveConfig = config.marketArchive;
      const storage = archiveConfig?.enabled
        ? new MicroBurstStorage({
            databasePath:
              archiveConfig.sqlitePath ?? 'data/micro-burst/micro_burst_research.sqlite',
            archivePath: archiveConfig.rootDir ?? 'data/micro-burst/market-data',
            maxActiveSegmentRecords: archiveConfig.maxActiveSegmentRecords,
            maxActiveSegmentBytes: archiveConfig.maxActiveSegmentBytes,
            maxActiveSegmentDurationMs: archiveConfig.maxActiveSegmentDurationMs,
            durabilityFlushIntervalMs: archiveConfig.durabilityFlushIntervalMs,
          })
        : undefined;

      this.sharedMarketDataRuntime.setArchiveObserver({
        onDepth: (symbol, depth) => {
          storage?.appendDepth({
            symbol,
            eventTime: depth.E,
            receivedAtMs: depth.receivedAtMs,
            E: depth.E,
            T: depth.T,
            U: depth.U,
            u: depth.u,
            pu: depth.pu,
            b: depth.bids,
            a: depth.asks,
          });
        },
        onAggTradeGap: (symbol, gap) => {
          storage?.recordGap?.({
            symbol,
            startedAtMs: gap.previousEventTimeMs ?? gap.nextEventTimeMs,
            endedAtMs: gap.nextEventTimeMs,
            reason: 'AGG_TRADE_SEQUENCE_GAP',
            kind: 'AGG_TRADE_SEQUENCE',
            feed: 'AGG_TRADE',
            previousAggregateTradeId: gap.previousAggregateTradeId,
            nextAggregateTradeId: gap.nextAggregateTradeId,
            previousFirstTradeId: gap.previousFirstTradeId,
            previousLastTradeId: gap.previousLastTradeId,
            nextFirstTradeId: gap.nextFirstTradeId,
            nextLastTradeId: gap.nextLastTradeId,
            dedupeKey: gap.dedupeKey,
          });
        },
        hasAggTradeGap: (symbol, fromMs, toMs) =>
          storage?.hasAggTradeGap?.(symbol, fromMs, toMs) ?? false,
      });

      const outcomeTracker = new MicroBurstOutcomeTracker({
        logger: this.deps.logger,
        clock: this.deps.clock,
        journal: new MicroBurstOutcomeJournal(),
        storage,
      });
      this.microBurstRuntime = new MicroBurstRuntime(
        {
          exchange: readOnlyExchange.exchange,
          logger: this.deps.logger,
          clock: this.deps.clock,
          strategyRouter: this.deps.microBurstStrategyRouter,
          orderBookDataPlane: this.sharedMarketDataRuntime.orderBookDataPlane,
          aggTradeDataPlane: this.sharedMarketDataRuntime.aggTradeDataPlane,
          blackBox: {
            decisionSink: this.deps.decisionSink,
            marketSnapshotSink: this.deps.marketSnapshotSink,
          },
          outcomeTracker,
          marketStorage: storage,
          provenance,
          liveTrading: config.mode === 'LIVE' ? this.deps.microBurstLiveTrading : undefined,
          mutationAudit: () => ({
            totalMutationAttempts: readOnlyExchange.audit.totalMutationAttempts,
            forwardedMutationCalls: readOnlyExchange.audit.forwardedMutationCalls,
          }),
        },
        config,
      );
      outcomeTracker.recoverPending();
      await this.microBurstRuntime.start();
      const readiness = this.microBurstRuntime.getReadiness();
      this.microBurstReadiness = readiness;
      if (readiness.ready) {
        this.deps.logger.info('MICRO_BURST_PROSPECTIVE_COHORT_READY', { ...readiness });
      } else {
        this.deps.logger.error('MICRO_BURST_PROSPECTIVE_COHORT_NOT_READY', { ...readiness });
      }
      this.deps.logger.info('micro_burst_runtime_integrated', {
        mode: config.mode,
        symbols: Object.keys(config.symbols).filter((symbol) => config.symbols[symbol].enabled),
        liveExecution: config.mode === 'LIVE',
        readOnlyExchangeBoundary: true,
        mutationAttempts: readOnlyExchange.audit.totalMutationAttempts,
        forwardedMutations: readOnlyExchange.audit.forwardedMutationCalls,
      });
    } catch (error) {
      this.deps.logger.error('micro_burst_runtime_startup_failed', { error: String(error) });
      const readiness = this.microBurstRuntime?.getReadiness();
      this.microBurstReadiness = readiness
        ? {
            ...readiness,
            ready: false,
            blockers: [...new Set([...readiness.blockers, 'NOT_READY'])],
          }
        : {
            ready: false,
            blockers: ['MICRO_BURST_RUNTIME_STARTUP_FAILED', 'NOT_READY'],
            cohortId: null,
            strategyVersion: null,
            codeCommitSha: null,
            configHash: null,
            liveExecution: false,
            readyForSoak: false,
            readyForFreeze: false,
            official: false,
            officialAuthority: false,
            liveAuthority: false,
            checks: {} as MicroBurstRuntimeReadiness['checks'],
            warnings: [],
            symbolBlockers: {},
          };
      this.deps.logger.error('MICRO_BURST_PROSPECTIVE_COHORT_NOT_READY', {
        ...this.microBurstReadiness,
      });
    }
  }
}
