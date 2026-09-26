import type {
  DecisionEvidenceSink,
  MarketSnapshotEvidenceSink,
} from '../../core/blackbox/StrategyDecisionBlackBox';
import type { MarketSnapshotV1 } from '../../core/market-data/MarketSnapshotProvider';
import type { StrategyIdentity } from '../../core/strategy/StrategyIdentity';
import type { StrategyExecutionIntent } from '../../core/strategy/StrategyExecution';
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
  type MicroBurstRuntimeHealth,
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
import type {
  LiquidityVoidDetector,
  LiquidityStressStatus,
} from '../services/LiquidityVoidDetector';
import { SharedMarketDataRuntime } from '../services/SharedMarketDataRuntime';
import { SharedLiquidityState } from '../services/SharedLiquidityState';
import { buildMarketDataDiagnostics } from '../diagnostics/MarketDataDiagnostics';
import { AEGIS_CURRENT_BRAIN_CANONICAL_SYMBOLS } from '../../strategies/aegis/application/AegisMarketContext';
import { getRateLimitMetrics } from '../../infra/adapters/rate-limit';
import type { MicroBurstProspectiveExitEventSource } from '../../strategies/micro-burst/research/MicroBurstProspectiveExitRuntime';
import { createMicroBurstProspectiveExitRuntime } from '../../strategies/micro-burst/research/MicroBurstProspectiveExitRuntime';
import type { MicroBurstProspectiveExitEventBus } from '../../strategies/micro-burst/research/MicroBurstProspectiveExitEventBus';
import type {
  ProspectiveExitEntrySnapshot,
  ProspectiveExitObservation,
} from '../../strategies/micro-burst/research/MicroBurstProspectiveExitObserver';
import { defaultMicroBurstConfig } from '../../strategies/micro-burst/domain/MicroBurstTypes';
import type { MicroBurstConfig } from '../../strategies/micro-burst/domain/MicroBurstTypes';
import { microBurstExecutableExitEconomics } from '../../strategies/micro-burst/domain/MicroBurstExecutableExitEconomics';

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
  microBurstProspectiveExit?: {
    source: MicroBurstProspectiveExitEventSource;
    bus?: MicroBurstProspectiveExitEventBus;
  };
}

export interface StrategyRuntimeStartInput {
  aegisEnabled?: boolean;
  momentumEnabled?: boolean;
  symbols: readonly string[];
  microBurstConfig: MicroBurstRuntimeConfig;
  loadMicroBurstProvenance?: () => MicroBurstRuntimeProvenance;
}

export interface StrategyRuntimeCoordinatorFactories {
  createMicroBurstRuntime(
    deps: ConstructorParameters<typeof MicroBurstRuntime>[0],
    config: ConstructorParameters<typeof MicroBurstRuntime>[1],
  ): MicroBurstRuntime;
  createSharedLiquidityState(
    deps: ConstructorParameters<typeof SharedLiquidityState>[0],
  ): SharedLiquidityState;
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
  createMicroBurstRuntime: (deps, config) => new MicroBurstRuntime(deps, config),
  createSharedLiquidityState: (deps) => new SharedLiquidityState(deps),
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
  private sharedLiquidityState: SharedLiquidityState | null = null;
  private aegisBlackBoxObservation: AegisBlackBoxObservation | null = null;
  private aegisRealtimeMarketState: AegisRealtimeMarketState | null = null;
  private momentumBlackBoxObservation: MomentumRideBlackBoxObservation | null = null;
  private momentumRealtimeMarketState: MomentumRealtimeMarketState | null = null;
  private momentumCandleState: MomentumCandleState | null = null;
  private microBurstRuntime: MicroBurstRuntime | null = null;
  private microBurstReadiness: MicroBurstRuntimeReadiness | null = null;
  private prospectiveExitRuntime: ReturnType<typeof createMicroBurstProspectiveExitRuntime> | null =
    null;
  private prospectiveObservationTimer: ReturnType<typeof setInterval> | null = null;
  private prospectiveExitConfig: MicroBurstConfig | null = null;

  constructor(
    private readonly deps: StrategyRuntimeCoordinatorDeps,
    factories: Partial<StrategyRuntimeCoordinatorFactories> = {},
  ) {
    this.factories = { ...DEFAULT_FACTORIES, ...factories };
  }

  hasAegisRealtimeMarketState(): boolean {
    return this.aegisRealtimeMarketState !== null;
  }

  readLiquidityStatus(
    symbol: string,
    now: number,
    freshnessMs: number,
  ): LiquidityStressStatus | undefined {
    return this.sharedLiquidityState?.read(symbol, now, freshnessMs);
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

  getMicroBurstHealth(): MicroBurstRuntimeHealth | null {
    return this.microBurstRuntime?.getHealth() ?? null;
  }

  getMicroBurstProspectiveExitEntries(): readonly ProspectiveExitEntrySnapshot[] {
    return this.prospectiveExitRuntime?.entriesSnapshot() ?? [];
  }

  validateMicroBurstEntryMarket(
    intent: StrategyExecutionIntent,
    quantity: number,
  ): string | undefined {
    if (!this.microBurstRuntime) return 'MICRO_ENTRY_RUNTIME_UNAVAILABLE';
    return this.microBurstRuntime.validateEntryMarket(intent, quantity);
  }

  readMicroBurstExecutionBook(symbol: string) {
    return this.microBurstRuntime?.readExecutionBook(symbol) ?? undefined;
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
    if (!this.sharedMarketDataRuntime) {
      return {
        version: 'MARKET_DATA_DIAGNOSTICS_V1',
        timestamp: new Date().toISOString(),
        status: 'NOT_READY',
        reason: 'SHARED_MARKET_DATA_NOT_INITIALIZED',
        symbols: [],
        summary: {
          symbolCount: null,
          healthySymbols: null,
          unhealthySymbols: null,
          expectedStreams: null,
          activeStreams: null,
          watchdog: { status: 'NOT_STARTED' },
        },
      };
    }
    const diagnostics = buildMarketDataDiagnostics(this.sharedMarketDataRuntime, {
      symbols: AEGIS_CURRENT_BRAIN_CANONICAL_SYMBOLS,
      streams: exchangeRuntime.wsManager?.getMarketDataHealth(),
      rateLimit: getRateLimitMetrics(),
    });
    const summary = diagnostics.summary as Record<string, unknown>;
    summary.depthSnapshotMetrics = this.sharedMarketDataRuntime?.getDepthSnapshotMetrics();
    diagnostics.status = 'READY';
    diagnostics.microBurstRuntime = this.getMicroBurstHealth();
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
    const liquiditySymbols = new Set(input.momentumEnabled !== false ? startupSymbols : []);
    if (input.microBurstConfig.enabled && input.microBurstConfig.mode !== 'OFF') {
      for (const [symbol, config] of Object.entries(input.microBurstConfig.symbols)) {
        if (config.enabled) liquiditySymbols.add(symbol);
      }
    }
    if (liquiditySymbols.size > 0) {
      this.sharedLiquidityState ??= this.factories.createSharedLiquidityState({
        sharedMarketData: this.sharedMarketDataRuntime,
        logger,
        clock,
      });
      this.sharedLiquidityState.start([...liquiditySymbols]);
    }
    if (input.aegisEnabled !== false) {
      this.aegisRealtimeMarketState ??= this.factories.createAegisRealtimeMarketState({
        sharedMarketData: this.sharedMarketDataRuntime,
        logger,
        clock,
      });
      this.aegisRealtimeMarketState.start(startupSymbols);
    }

    if (input.momentumEnabled !== false) {
      this.momentumRealtimeMarketState ??= this.factories.createMomentumRealtimeMarketState({
        sharedMarketData: this.sharedMarketDataRuntime,
        clock,
      });
      this.momentumRealtimeMarketState.start(startupSymbols);

      this.momentumCandleState ??= this.factories.createMomentumCandleState(
        this.sharedMarketDataRuntime,
      );
      this.momentumCandleState.start(startupSymbols);
    }

    if (input.aegisEnabled !== false) {
      this.aegisBlackBoxObservation ??= this.factories.createAegisBlackBoxObservation({
        exchange,
        sharedMarketData: this.sharedMarketDataRuntime,
        identity: this.deps.aegisIdentity,
        clock,
        decisionSink: this.deps.decisionSink,
        marketSnapshotSink: this.deps.marketSnapshotSink,
      });
      this.aegisBlackBoxObservation.start(startupSymbols);
    }

    if (input.momentumEnabled !== false) {
      this.momentumBlackBoxObservation ??= this.factories.createMomentumBlackBoxObservation({
        exchange,
        sharedMarketData: this.sharedMarketDataRuntime,
        clock,
        decisionSink: this.deps.decisionSink,
        marketSnapshotSink: this.deps.marketSnapshotSink,
      });
      this.momentumBlackBoxObservation.start(startupSymbols);
      this.deps.momentumStrategyRouter.setObservationHook(this.momentumBlackBoxObservation);
    }

    if (input.microBurstConfig.enabled && input.microBurstConfig.mode !== 'OFF') {
      await this.startMicroBurst(input.microBurstConfig, input.loadMicroBurstProvenance);
    }
  }

  async stop(): Promise<void> {
    const microBurstRuntime = this.microBurstRuntime;
    this.microBurstRuntime = null;
    const prospectiveExitRuntime = this.prospectiveExitRuntime;
    this.prospectiveExitRuntime = null;
    if (this.prospectiveObservationTimer) clearInterval(this.prospectiveObservationTimer);
    this.prospectiveObservationTimer = null;
    this.prospectiveExitConfig = null;

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
    await prospectiveExitRuntime?.stop();
    this.sharedLiquidityState?.close();
    this.sharedLiquidityState = null;
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
      this.microBurstRuntime = this.factories.createMicroBurstRuntime(
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
      if (this.deps.microBurstProspectiveExit) {
        const prospectiveEnabled = config.prospectiveValidation?.enabled === true;
        this.prospectiveExitConfig = {
          ...defaultMicroBurstConfig(),
          ...config.exitPolicy,
        };
        this.deps.microBurstProspectiveExit.bus?.setEnabled(prospectiveEnabled);
        this.prospectiveExitRuntime = createMicroBurstProspectiveExitRuntime(
          {
            enabled: prospectiveEnabled,
            journalPath: 'logs/micro-burst/prospective-exits.jsonl',
          },
          this.deps.microBurstProspectiveExit.source,
          {
            config: this.prospectiveExitConfig,
          },
        );
        await this.prospectiveExitRuntime.start();
        if (prospectiveEnabled && this.deps.microBurstProspectiveExit.bus) {
          this.deps.microBurstProspectiveExit.bus.restoreEntries(
            this.prospectiveExitRuntime.entriesSnapshot().filter((entry) => !entry.completed),
          );
          this.prospectiveObservationTimer = setInterval(() => {
            void this.publishClosedProspectiveObservations();
          }, 250);
          this.prospectiveObservationTimer.unref?.();
        }
      }
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

  private async publishClosedProspectiveObservations(): Promise<void> {
    const bus = this.deps.microBurstProspectiveExit?.bus;
    const runtime = this.microBurstRuntime;
    if (!bus || !runtime) return;

    for (const entryId of bus.closedEntriesSnapshot()) {
      const identity = bus.entriesSnapshot().find((entry) => entry.entryId === entryId);
      const previous = bus.latestObservation(entryId);
      const entry = this.prospectiveExitRuntime?.getEntry(entryId);
      if (!identity || !entry) continue;
      const now = this.deps.clock.now();
      const snapshot = runtime.readExitMarketSnapshot(identity.symbol, previous?.eventAtMs);
      if (!snapshot) {
        if (now >= entry.horizonAtMs)
          await this.prospectiveExitRuntime?.finalizeAtHorizon(
            entryId,
            now,
            'POST_CLOSE_MARKET_DATA_UNAVAILABLE',
          );
        continue;
      }
      if (!previous) {
        if (now >= entry.horizonAtMs)
          await this.prospectiveExitRuntime?.finalizeAtHorizon(
            entryId,
            now,
            'POST_CLOSE_OBSERVATION_CONTEXT_UNAVAILABLE',
          );
        continue;
      }

      const sideSign = identity.side === 'LONG' ? 1 : -1;
      const priceReturn =
        identity.entryPrice > 0
          ? ((snapshot.currentPrice - identity.entryPrice) / identity.entryPrice) * sideSign
          : 0;
      const book = snapshot.book;
      const levels = identity.side === 'LONG' ? (book?.bidDepth ?? []) : (book?.askDepth ?? []);
      let availableQuantity = 0;
      let levelsUsed = 0;
      for (const level of levels) {
        if (!Number.isFinite(level.qty) || level.qty < 0) break;
        availableQuantity += level.qty;
        levelsUsed++;
        if (availableQuantity >= identity.quantity) break;
      }
      const quantityCovered = book?.status === 'HEALTHY' && availableQuantity >= identity.quantity;
      const costEvidence = bus.latestEconomicEvidence(entryId);
      const economics =
        this.prospectiveExitConfig &&
        costEvidence &&
        Number.isFinite(costEvidence.costObservedAtMs ?? costEvidence.observedAtMs) &&
        snapshot.observedAtMs >= (costEvidence.costObservedAtMs ?? costEvidence.observedAtMs) &&
        snapshot.observedAtMs - (costEvidence.costObservedAtMs ?? costEvidence.observedAtMs) <=
          this.prospectiveExitConfig.exitIntelligenceMaxObservationGapMs &&
        Number.isFinite(costEvidence.residualCostBps) &&
        Number.isFinite(snapshot.volatilityBps)
          ? microBurstExecutableExitEconomics(
              {
                book,
                side: identity.side,
                quantity: identity.quantity,
                observedAtMs: snapshot.observedAtMs,
                costObservedAtMs: costEvidence.costObservedAtMs ?? costEvidence.observedAtMs,
                costSource: costEvidence.costSource ?? 'PERSISTED_EXIT_COST_EVIDENCE',
                residualCostBps: costEvidence.residualCostBps,
                volatilityBps: snapshot.volatilityBps!,
              },
              this.prospectiveExitConfig,
            )
          : null;
      const context = {
        ...previous.context,
        currentPrice: snapshot.currentPrice,
        priceReturn,
        unrealizedRoe: priceReturn * (identity.leverage ?? previous.context.leverage),
        peakPrice:
          identity.side === 'LONG'
            ? Math.max(previous.context.peakPrice, snapshot.currentPrice)
            : Math.min(previous.context.peakPrice, snapshot.currentPrice),
        troughPrice:
          identity.side === 'LONG'
            ? Math.min(previous.context.troughPrice, snapshot.currentPrice)
            : Math.max(previous.context.troughPrice, snapshot.currentPrice),
        timeInTradeMs: Math.max(0, snapshot.observedAtMs - identity.enteredAtMs),
        observedAtMs: snapshot.observedAtMs,
        currentBookPressure: snapshot.currentBookPressure,
        currentBookObservedAtMs: snapshot.book?.observedAtMs,
        currentBtcContext: snapshot.currentBtcContext,
        marketEvidence: snapshot.marketEvidence,
      };
      const observation: ProspectiveExitObservation = {
        eventAtMs: snapshot.observedAtMs,
        receivedAtMs: Math.max(snapshot.observedAtMs, book?.observedAtMs ?? snapshot.observedAtMs),
        evaluatedAtMs: this.deps.clock.now(),
        context: { ...context, executableEconomics: economics ?? undefined },
        executionAssumptions: {
          roundTripCostBps: economics?.residualCostBps ?? null,
          feeBps: previous.executionAssumptions.feeBps,
          slippageBps: previous.executionAssumptions.slippageBps,
          source: economics
            ? 'MICRO_EXIT_ECONOMICS_RECONSTRUCTED_FROM_CONSUMED_BOOK'
            : 'UNAVAILABLE_AFTER_REAL_POSITION_CLOSE',
        },
        depth: book
          ? {
              status: book.status,
              observedAtMs: book.observedAtMs,
              requiredQuantity: identity.quantity,
              availableQuantity,
              levelsUsed,
              quantityCovered,
            }
          : null,
        inputProvenance: {
          btcAvailable: snapshot.currentBtcContext !== null,
          flowAvailable: snapshot.marketEvidence !== null,
          structureAvailable:
            Number.isFinite(context.structuralInvalidationPrice) &&
            Number.isFinite(context.destinationPrice),
          quality: {
            source: 'MICRO_BURST_RUNTIME_CONSUMED_POST_CLOSE_SNAPSHOT',
            economicsAvailable: economics !== null,
            depthAvailable: book !== undefined,
          },
        },
        ...(economics
          ? {}
          : {
              gap: {
                kind: quantityCovered ? ('UNKNOWN' as const) : ('DEPTH' as const),
                fromMs: previous.eventAtMs,
                toMs: snapshot.observedAtMs,
                reason: quantityCovered
                  ? 'EXECUTABLE_ECONOMICS_UNAVAILABLE'
                  : 'INSUFFICIENT_EXECUTABLE_DEPTH',
              },
            }),
      };
      bus.publishObservation(entryId, observation);
    }
  }
}
