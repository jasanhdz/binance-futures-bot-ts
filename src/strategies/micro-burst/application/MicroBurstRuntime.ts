import { Logger } from '../../../app/ports/Logger';
import { MarketDataPort } from '../../../app/ports/MarketData';
import { StrategyRouter } from '../../../core/strategy/StrategyRouter';
import {
  SynchronizedOrderBook,
  SynchronizedOrderBookDeps,
} from '../../../core/market-data/SynchronizedOrderBook';
import { BtcMicroContextProvider, BtcMicroContextDeps } from '../domain/BtcMicroContextProvider';
import { RollingAggTradeBuffer } from '../../../core/market-data/RollingAggTradeBuffer';
import {
  MicroBurstReferencePriceProvider,
  MicroBurstReferencePriceDeps,
} from '../domain/MicroBurstReferencePrice';
import { MicroBurstShadowEvaluator } from './MicroBurstShadowEvaluator';
import { MicroBurstDuplicateSignalGuard } from '../domain/MicroBurstDuplicateSignalGuard';
import type {
  MicroBurstExitMarketSnapshot,
  MicroBurstLiveEntryRequest,
  MicroBurstRuntimeConfig,
} from './MicroBurstRuntimeTypes';
import type { MicroBurstShadowEvaluationResult } from './MicroBurstShadowEvaluationTypes';
import type {
  AggTradeEvent,
  OrderBookState as SynchronizedOrderBookState,
} from '../../../app/ports/MarketData';
import { MicroBurstStrategyContext } from '../domain/MicroBurstStrategy';
import { MicroBurstContextBuilderDeps } from '../domain/MicroBurstContextBuilder';
import { MicroBurstSignalJournal } from '../research/MicroBurstSignalJournal';
import { ShadowSignalSnapshot } from '../research/MicroBurstOutcomeTypes';
import { freezeSignalSnapshot } from '../research/MicroBurstOutcomeEngine';
import { assessMicroBurstReadiness, MicroBurstReadinessResult } from './MicroBurstReadiness';
import { GapKind, MarketDataFeed } from '../../../core/market-data/NormalizedMarketEvents';
import {
  defaultMicroBurstConfig,
  MicroBurstConfig,
  MicroBurstExitMarketEvidence,
} from '../domain/MicroBurstTypes';
import { analyzeBookPressure } from '../domain/MicroBurstBookPressureAnalyzer';
import { FileShadowTradeJournal, ShadowJournal } from '../../../core/shadow/ShadowTradeJournal';
import { ShadowTradingEngine } from '../../../core/shadow/ShadowTradingEngine';
import { ShadowMarketQuote, ShadowPosition } from '../../../core/shadow/ShadowTradingTypes';
import { MicroBurstShadowPolicyAdapter } from '../domain/MicroBurstShadowPolicyAdapter';
import { DEFAULT_COST_SCENARIOS } from '../research/MicroBurstOutcomeTypes';
import { OrderBookDataPlane } from '../../../core/market-data/OrderBookDataPlane';
import type { OrderBookLease } from '../../../core/market-data/OrderBookDataPlane';
import { AggTradeDataPlane } from '../../../core/market-data/AggTradeDataPlane';
import type { AggTradeLease } from '../../../core/market-data/AggTradeDataPlane';
import { CandleDataPlane } from '../../../core/market-data/CandleDataPlane';
import type { CandleLease } from '../../../core/market-data/CandleDataPlane';
import { ComposedBenchmarkMarketDataPort } from '../../../core/market-data/BenchmarkMarketData';
import { MarketDataCandleProvider } from '../../../core/market-data/MarketDataCandleProvider';
import type {
  DecisionEvidenceSink,
  MarketSnapshotEvidenceSink,
} from '../../../core/blackbox/StrategyDecisionBlackBox';
import { createMicroBurstBlackBoxObservation } from './MicroBurstBlackBoxObservation';
import { MicroBurstFastMarketState } from './MicroBurstFastMarketState';
import {
  projectMicroBurstSlowMarketState,
  type MicroBurstSlowMarketState,
} from '../domain/MicroBurstMarketState';
import {
  MicroOpportunityResearchSampler,
  MICRO_OPPORTUNITY_RESEARCH_SAMPLE_INTERVAL_MS,
} from '../research/MicroOpportunityResearchSampler';
import type { MicroOpportunityDecisionMetadata } from '../research/MicroOpportunityTypes';
import { labelMicroOpportunitySample } from '../research/MicroOpportunityLabeler';
import type { MicroOpportunityResearchSample } from '../research/MicroOpportunityTypes';
import type { MicroOpportunitySampleOutcome } from '../research/MicroOpportunityResearchSampler';

const DEFAULT_EVALUATION_INTERVAL_MS = 5000;
const HEALTH_REPORT_INTERVAL_MS = 60_000;
const EXIT_SHORT_HORIZON_MS = 5_000;
const EXIT_MEDIUM_HORIZON_MS = 20_000;

interface Clock {
  now(): number;
}

export interface MicroBurstRuntimeHealth {
  running: boolean;
  symbolCount: number;
  healthyBooks: number;
  btcHealthy: boolean;
  totalEvaluations: number;
  totalUniqueSignals: number;
  paperSuppressedEntries: number;
  totalDuplicateSignals: number;
  totalInvalidContexts: number;
  totalResyncs: number;
  liveExecution: boolean;
  paperEngine: 'GENERIC';
  lastHealthReportAt: number;
  outcomeTracker: {
    signalsObserved: number;
    pendingOutcomes: number;
    completedOutcomes: number;
    outcomeErrors: number;
    journalHealthy?: boolean;
    malformedJournalCount?: number;
    malformedJournalFile?: string | null;
    malformedJournalLine?: number | null;
    malformedJournalReason?: string | null;
  } | null;
  signalJournalHealthy: boolean;
  marketArchiveHealthy: boolean | null;
  archiveQueueDepth: number | null;
  archiveQueuedRecords: number | null;
  archiveWrittenRecords: number | null;
  archiveOverflowRecords: number | null;
  archiveActiveSegmentCount: number | null;
  archiveActiveSegmentRecords: number | null;
  archiveSegmentsFinalized: number | null;
  archiveRecordsDurablyFlushed: number | null;
  archiveFinalizationQueueDepth: number | null;
  archiveRecoveryFailures: number | null;
  archiveBytes: number | null;
  archiveFileCount: number | null;
  archiveRetentionAgeMs: number | null;
  archiveRetentionWarning: boolean | null;
  opportunitySamples: {
    sampled: number;
    persisted: number;
    persistenceRejected: number;
    sinkErrors: number;
    tickDurationMs: { p50: number; p95: number; p99: number };
    bySymbol: Record<
      string,
      { attempts: number; persisted: number; skipReasons: Record<string, number> }
    >;
  };
  symbolMetrics: Record<string, Record<string, unknown>>;
  storageErrors: number;
  mutationAttempts: number;
  forwardedMutations: number;
  readiness: MicroBurstRuntimeReadiness;
  paperTrading: {
    openPositions: number;
    recoveryBlocked: boolean;
    journalHealthy: boolean;
    completedManagedTrades: number;
    persistenceErrors: number;
  };
}

export interface MicroBurstRuntimeReadiness extends MicroBurstReadinessResult {
  cohortId: string | null;
  strategyVersion: string | null;
  codeCommitSha: string | null;
  configHash: string | null;
  liveExecution: boolean;
}

interface SymbolRuntimeState {
  book: SynchronizedOrderBook;
  bookLease: OrderBookLease<SynchronizedOrderBook>;
  aggTradeBuffer: RollingAggTradeBuffer;
  aggTradeLease: AggTradeLease<RollingAggTradeBuffer>;
  referencePriceProvider: MicroBurstReferencePriceProvider;
  evaluationInFlight: boolean;
  lastEvaluationAt: number;
  evaluationCount: number;
  evaluationScheduled: number;
  evaluationStarted: number;
  evaluationCompleted: number;
  evaluationFailed: number;
  candleCacheHit: number;
  candleUnavailable: number;
  candleStale: number;
  latestSlowStatePublished: number;
  latestSlowStatePublishedAt: number | null;
  opportunitySamplerAttempts: number;
  opportunityPersisted: number;
  opportunitySkipReasons: Record<string, number>;
  evaluationDurationsMs: number[];
  uniqueSignalCount: number;
  duplicateSignalCount: number;
  invalidContextCount: number;
  bookResyncCount: number;
  latestSlowState: MicroBurstSlowMarketState | null;
  latestDecision: MicroOpportunityDecisionMetadata;
}

export interface MicroBurstRuntimeDeps {
  exchange: MarketDataPort;
  logger: Logger;
  clock: Clock;
  strategyRouter: StrategyRouter<MicroBurstStrategyContext>;
  outcomeTracker?: {
    trackSignal(snapshot: ShadowSignalSnapshot): void;
    observeTradeEvent(event: {
      eventTime: number;
      receivedAtMs?: number;
      price: number;
      symbol: string;
      quantity?: number;
      isBuyerMaker?: boolean;
      tradeTime?: number;
      aggregateTradeId?: number;
      firstTradeId?: number;
      lastTradeId?: number;
    }): void;
    flushPending(currentTimeMs: number): void;
    getHealth(): {
      signalsObserved: number;
      pendingOutcomes: number;
      completedOutcomes: number;
      outcomeErrors: number;
      journalHealthy?: boolean;
      malformedJournalCount?: number;
      malformedJournalFile?: string | null;
      malformedJournalLine?: number | null;
      malformedJournalReason?: string | null;
    };
  };
  marketStorage?: {
    appendTrade?(event: Record<string, unknown>): boolean;
    appendDepth(event: Record<string, unknown>): boolean;
    recordGap?(gap: {
      symbol: string;
      startedAtMs: number;
      endedAtMs: number;
      reason: string;
      kind?: GapKind;
      feed?: MarketDataFeed;
      [key: string]: unknown;
    }): boolean;
    persistCheckpoint(symbol: string, eventTimeMs: number, checkpoint: unknown): boolean;
    persistOpportunitySample?(
      sample: import('../research/MicroOpportunityTypes').MicroOpportunityResearchSample,
    ): boolean;
    persistOpportunityLabels?(sampleId: string, labels: Record<number, unknown>): boolean;
    hasAggTradeGap?(symbol: string, fromMs: number, toMs: number): boolean;
    flush?(): boolean | Promise<boolean>;
    close?(): boolean | void | Promise<boolean | void>;
    getHealth(): {
      healthy: boolean;
      errorCount: number;
      queueDepth?: number;
      queueCapacity?: number;
      queuedRecords?: number;
      writtenRecords?: number;
      overflowRecords?: number;
      draining?: boolean;
      activeSegmentCount?: number;
      activeSegmentRecords?: number;
      segmentsFinalized?: number;
      recordsDurablyFlushed?: number;
      finalizationQueueDepth?: number;
      recoveryFailures?: number;
      archiveBytes?: number;
      archiveFileCount?: number;
      archiveRetentionAgeMs?: number | null;
      retentionWarning?: boolean;
    };
  };
  provenance?: {
    codeCommitSha: string;
    configHash: string;
    cohortId: string;
    officialCohortReady: boolean;
  };
  readinessEvidence?: {
    mutationAuditAvailable?: boolean;
    manifestValid?: boolean;
    schemaValid?: boolean;
    episodeDefinitionValid?: boolean;
    costSemanticsValid?: boolean;
  };
  mutationAudit?: () => { totalMutationAttempts: number; forwardedMutationCalls: number };
  shadowTradeJournal?: ShadowJournal;
  /** @deprecated Isolated-test fallback only. Production injects app-owned shared planes. */
  orderBookDataPlane?: OrderBookDataPlane<SynchronizedOrderBook>;
  /** @deprecated Isolated-test fallback only. Production injects app-owned shared planes. */
  aggTradeDataPlane?: AggTradeDataPlane<RollingAggTradeBuffer>;
  /** App-owned shared candle state used by the production evaluation path. */
  candleDataPlane?: CandleDataPlane;
  blackBox?: {
    decisionSink: DecisionEvidenceSink;
    marketSnapshotSink: MarketSnapshotEvidenceSink;
  };
  liveTrading?: {
    open(request: MicroBurstLiveEntryRequest): Promise<boolean>;
  };
}

export class MicroBurstRuntime {
  private running = false;
  private evaluationTimer: NodeJS.Timeout | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private btcProvider: BtcMicroContextProvider | null = null;
  private shadowEvaluator: MicroBurstShadowEvaluator | null = null;
  private readonly symbolStates = new Map<string, SymbolRuntimeState>();
  private totalEvaluations = 0;
  private totalUniqueSignals = 0;
  private paperSuppressedEntries = 0;
  private readonly paperSuppressionDiagnostics = new Set<string>();
  private totalDuplicateSignals = 0;
  private totalInvalidContexts = 0;
  private lastHealthReportAt = 0;
  private readonly evaluationIntervalMs: number;
  private readonly journal: MicroBurstSignalJournal;
  private stopPromise: Promise<void> | null = null;
  private readonly shadowEngine: ShadowTradingEngine;
  private readonly shadowTradeJournal: ShadowJournal;
  private readonly paperOpenSymbols = new Set<string>();
  private paperRecoveryBlocked = false;
  private paperPersistenceError: string | null = null;
  private orderBookDataPlane?: OrderBookDataPlane<SynchronizedOrderBook>;
  private aggTradeDataPlane?: AggTradeDataPlane<RollingAggTradeBuffer>;
  private candleDataPlane?: CandleDataPlane;
  private readonly candleLeases: CandleLease[] = [];
  private opportunitySampler: MicroOpportunityResearchSampler | null = null;
  private readonly pendingOpportunitySamples = new Map<string, MicroOpportunityResearchSample>();

  constructor(
    private readonly deps: MicroBurstRuntimeDeps,
    private readonly config: MicroBurstRuntimeConfig,
    evaluationIntervalMs = DEFAULT_EVALUATION_INTERVAL_MS,
    journalDir?: string,
  ) {
    this.evaluationIntervalMs = evaluationIntervalMs;
    this.journal = new MicroBurstSignalJournal(journalDir);
    this.shadowTradeJournal =
      deps.shadowTradeJournal ??
      new FileShadowTradeJournal(
        'logs/micro-burst/shadow/trades',
        'logs/micro-burst/shadow/trade-events',
      );
    const microBurstConfig: MicroBurstConfig = {
      ...defaultMicroBurstConfig(),
      ...config.exitPolicy,
    };
    const costScenarios = new Map([
      [
        'MICRO_BURST_V1' as const,
        Object.fromEntries(
          DEFAULT_COST_SCENARIOS.map((scenario) => [
            scenario.label,
            { feeBps: scenario.feeBps, additionalSlippageBps: scenario.slippageBps },
          ]),
        ),
      ],
    ]);
    this.shadowEngine = new ShadowTradingEngine(
      this.shadowTradeJournal,
      new Map([['MICRO_BURST_V1', new MicroBurstShadowPolicyAdapter(microBurstConfig)]] as const),
      costScenarios,
    );
    for (const position of this.shadowEngine.getOpenPositions()) {
      if (position.strategyId === 'MICRO_BURST_V1') this.paperOpenSymbols.add(position.symbol);
    }
    try {
      if (!this.shadowTradeJournal.getHealth().healthy)
        throw new Error('SHADOW_TRADE_JOURNAL_MALFORMED');
      this.paperRecoveryBlocked = Object.values(this.shadowEngine.getHealth().strategies).some(
        (strategy) => strategy.recoveryBlocked > 0,
      );
    } catch (error) {
      this.paperRecoveryBlocked = true;
      this.deps.logger.error('micro_burst_paper_recovery_blocked', { error: String(error) });
    }
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (this.stopPromise) this.stopPromise = null;
    if (!this.config.enabled || this.config.mode === 'OFF') {
      this.deps.logger.info('micro_burst_runtime_skip_start', {
        enabled: this.config.enabled,
        mode: this.config.mode,
      });
      return;
    }

    if (this.config.mode === 'LIVE' && !this.deps.liveTrading) {
      this.deps.logger.error('micro_burst_runtime_live_rejected', {
        message: 'MICRO_BURST_V1 LIVE execution port missing. Failing closed.',
      });
      throw new Error('MICRO_BURST_V1_LIVE_EXECUTION_PORT_REQUIRED');
    }

    const enabledSymbols = Object.entries(this.config.symbols)
      .filter(([, symConf]) => symConf.enabled)
      .map(([symbol]) => symbol);

    if (enabledSymbols.length === 0) {
      this.deps.logger.info('micro_burst_runtime_no_enabled_symbols');
      return;
    }

    this.running = true;

    const clock = this.deps.clock;
    const logger = this.deps.logger;
    const exchange = this.deps.exchange;

    this.candleDataPlane = this.deps.candleDataPlane;
    if (this.candleDataPlane) {
      for (const symbol of enabledSymbols) {
        for (const interval of ['1m', '3m', '5m'] as const) {
          this.candleLeases.push(this.candleDataPlane.acquire(symbol, interval));
        }
      }
      const warmupResults = await Promise.allSettled(
        enabledSymbols.flatMap((symbol) =>
          (['1m', '3m', '5m'] as const).map((interval) =>
            this.candleDataPlane!.ensureWarm(
              symbol,
              interval,
              interval === '1m' ? 100 : interval === '3m' ? 80 : 60,
            ),
          ),
        ),
      );
      for (const result of warmupResults) {
        if (result.status === 'rejected') {
          logger.warn('micro_burst_candle_warmup_failed', { error: String(result.reason) });
        }
      }
    }

    const candleProvider = new MarketDataCandleProvider(exchange, clock);
    const benchmarkData = new ComposedBenchmarkMarketDataPort({
      candles: () => candleProvider,
    }).getBenchmark({ id: 'PRIMARY_CRYPTO_BENCHMARK', symbol: 'BTCUSDT' });
    const btcDeps: BtcMicroContextDeps = {
      benchmark: benchmarkData,
      logger,
    };
    this.btcProvider = new BtcMicroContextProvider('BTCUSDT', btcDeps, clock);
    this.btcProvider.start();

    const duplicateGuard = new MicroBurstDuplicateSignalGuard(clock);

    this.orderBookDataPlane =
      this.deps.orderBookDataPlane ??
      new OrderBookDataPlane((symbol) => {
        const bookDeps: SynchronizedOrderBookDeps = {
          snapshotSource: {
            getSnapshot: async (sym: string, levels: number) => {
              if (!exchange.getDepthSnapshot) {
                throw new Error('Exchange does not support depth snapshot');
              }
              return exchange.getDepthSnapshot(sym, levels);
            },
          },
          diffSource: {
            onDiff: (sym: string, callback: (event: any) => void) => {
              if (!exchange.subscribeToDepthDiff) {
                logger.warn('micro_burst_exchange_no_depth_diff', { symbol: sym });
                return () => {};
              }
              return exchange.subscribeToDepthDiff(sym, '100ms', (depth) => {
                this.deps.marketStorage?.appendDepth({
                  symbol: sym,
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
                callback(depth);
              });
            },
          },
          logger,
          clock,
          getServerTime: () => exchange.getServerTime(),
        };
        return new SynchronizedOrderBook(symbol, bookDeps);
      });

    const aggTradeDataPlane =
      this.deps.aggTradeDataPlane ??
      new AggTradeDataPlane(
        (symbol) =>
          new RollingAggTradeBuffer(
            clock,
            undefined,
            undefined,
            (gap) => {
              this.deps.marketStorage?.recordGap?.({
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
            (fromMs, toMs) =>
              this.deps.marketStorage?.hasAggTradeGap?.(symbol, fromMs, toMs) ?? false,
          ),
        {
          subscribe: (symbol, onEvent, onStatus) => {
            if (!exchange.subscribeToAggTrades) return () => {};
            return exchange.subscribeToAggTrades(
              symbol,
              (trade) =>
                onEvent({
                  eventTime: trade.eventTime,
                  receivedAtMs: trade.receivedAtMs,
                  price: Number(trade.price),
                  quantity: Number(trade.quantity),
                  isBuyerMaker: trade.isBuyerMaker,
                  tradeTime: trade.tradeTime,
                  aggregateTradeId: trade.aggregateTradeId,
                  firstTradeId: trade.firstTradeId,
                  lastTradeId: trade.lastTradeId,
                }),
              onStatus,
            );
          },
        },
      );
    this.aggTradeDataPlane = aggTradeDataPlane;

    for (const symbol of enabledSymbols) {
      const bookLease = this.orderBookDataPlane.acquire(symbol);
      const book = bookLease.book;
      const aggTradeLease = aggTradeDataPlane.acquire(symbol, (event) => {
        this.managePaperTrade(symbol, event);
        this.deps.marketStorage?.appendTrade?.({
          symbol,
          eventTime: event.eventTime,
          receivedAtMs: event.receivedAtMs ?? this.deps.clock.now(),
          price: event.price,
          quantity: event.quantity,
          isBuyerMaker: event.isBuyerMaker,
          aggregateTradeId: event.aggregateTradeId,
          firstTradeId: event.firstTradeId,
          lastTradeId: event.lastTradeId,
        });

        if (this.deps.outcomeTracker) {
          this.deps.outcomeTracker.observeTradeEvent({
            eventTime: event.eventTime,
            receivedAtMs: event.receivedAtMs,
            price: event.price,
            symbol,
            quantity: event.quantity,
            isBuyerMaker: event.isBuyerMaker,
            tradeTime: event.tradeTime,
            aggregateTradeId: event.aggregateTradeId,
            firstTradeId: event.firstTradeId,
            lastTradeId: event.lastTradeId,
          });
        }
      });
      const aggTradeBuffer = aggTradeLease.state;

      const refPriceDeps: MicroBurstReferencePriceDeps = {
        getMarkPrice: (sym: string) => exchange.getMarkPrice(sym),
        getDepthSnapshot: book.getSnapshot.bind(book) as any,
        logger,
      };
      const refPriceProvider = new MicroBurstReferencePriceProvider(refPriceDeps, clock);

      const state: SymbolRuntimeState = {
        book,
        bookLease,
        aggTradeBuffer,
        aggTradeLease,
        referencePriceProvider: refPriceProvider,
        evaluationInFlight: false,
        lastEvaluationAt: 0,
        evaluationCount: 0,
        evaluationScheduled: 0,
        evaluationStarted: 0,
        evaluationCompleted: 0,
        evaluationFailed: 0,
        candleCacheHit: 0,
        candleUnavailable: 0,
        candleStale: 0,
        latestSlowStatePublished: 0,
        latestSlowStatePublishedAt: null,
        opportunitySamplerAttempts: 0,
        opportunityPersisted: 0,
        opportunitySkipReasons: {},
        evaluationDurationsMs: [],
        uniqueSignalCount: 0,
        duplicateSignalCount: 0,
        invalidContextCount: 0,
        bookResyncCount: 0,
        latestSlowState: null,
        latestDecision: {
          decision: 'UNKNOWN',
          side: null,
          reason: null,
          confidence: null,
          uniqueCandidateId: null,
        },
      };
      this.symbolStates.set(symbol, state);

      refPriceProvider.pollMarkPrice(symbol).catch(() => {});
    }

    const contextBuilderDeps: MicroBurstContextBuilderDeps = {
      candles: {
        getCandles: async (sym, interval, limit) => {
          if (!this.candleDataPlane) return exchange.getCandles(sym, interval, limit);
          const snapshot = this.candleDataPlane.read(sym, interval, limit);
          const state = this.symbolStates.get(sym);
          if (snapshot.status === 'FRESH') state && state.candleCacheHit++;
          else if (snapshot.status === 'STALE') state && state.candleStale++;
          else state && state.candleUnavailable++;
          return snapshot.status === 'FRESH' ? [...snapshot.candles] : [];
        },
      },
      btc: this.btcProvider,
      book: {
        getDepthSnapshot: (sym: string) => {
          const state = this.symbolStates.get(sym);
          if (!state) return undefined;
          return state.book.getSnapshot() as any;
        },
      },
      referencePrice: {
        getReferencePrice: (sym: string, bookSnapshot?: any) => {
          const state = this.symbolStates.get(sym);
          if (!state) return undefined;
          return state.referencePriceProvider.getReferencePrice(sym, bookSnapshot);
        },
      },
      aggTradeFlow: {
        getTakerFlow: (sym: string) => {
          const state = this.symbolStates.get(sym);
          if (!state) {
            return {
              buyVolume: 0,
              sellVolume: 0,
              netTakerVolume: 0,
              tradeCount: 0,
              requestedWindowMs: 300_000,
              observedWindowMs: 0,
              observedSampleCount: 0,
              eventWatermarkMs: null,
              capacityTruncated: false,
              coverageStartedAtMs: null,
              windowComplete: false,
              gapFree: true,
            };
          }
          return state.aggTradeBuffer.getTakerFlow();
        },
      },
    };

    if (this.deps.blackBox) {
      this.deps.strategyRouter.setObservationHook(
        createMicroBurstBlackBoxObservation({
          clock,
          candles: candleProvider,
          orderBookFor: (symbol) => this.symbolStates.get(symbol.toUpperCase())?.book,
          aggTradeFor: (symbol) => this.symbolStates.get(symbol.toUpperCase())?.aggTradeBuffer,
          decisionSink: this.deps.blackBox.decisionSink,
          marketSnapshotSink: this.deps.blackBox.marketSnapshotSink,
        }),
      );
      logger.info('micro_burst_decision_blackbox_attached', {
        schema: 'STRATEGY_DECISION_BLACKBOX_V2',
        authority: 'OBSERVATIONAL_ONLY',
        liveExecution: false,
      });
    }

    this.shadowEvaluator = new MicroBurstShadowEvaluator(
      {
        contextBuilderDeps,
        strategyRouter: this.deps.strategyRouter,
        duplicateGuard,
        logger,
        clock,
        getServerTime: () => exchange.getServerTime(),
        onContext: (context) => {
          const state = this.symbolStates.get(context.symbol);
          if (state) {
            state.latestSlowState = projectMicroBurstSlowMarketState(context);
            state.latestSlowStatePublished++;
            state.latestSlowStatePublishedAt = this.deps.clock.now();
          }
        },
      },
      this.config,
    );

    this.startEvaluationLoop();
    this.opportunitySampler = new MicroOpportunityResearchSampler(
      enabledSymbols,
      () => this.deps.clock.now(),
      (symbol, sampledAtMs) => {
        const state = this.symbolStates.get(symbol);
        const fast = state
          ? new MicroBurstFastMarketState(symbol, {
              trades: state.aggTradeBuffer,
              book: state.book,
              clock: this.deps.clock,
            }).read()
          : null;
        return {
          symbol,
          sampledAtMs,
          slow: state?.latestSlowState ?? null,
          fast,
          stableMicroDecision: state?.latestDecision,
        };
      },
      {
        append: (sample) => {
          const persisted = this.deps.marketStorage?.persistOpportunitySample?.(sample) ?? false;
          if (persisted) this.pendingOpportunitySamples.set(sample.sampleId, sample);
          return persisted;
        },
      },
      MICRO_OPPORTUNITY_RESEARCH_SAMPLE_INTERVAL_MS,
      () => this.labelPendingOpportunitySamples(),
      (symbol, outcome) => this.recordOpportunityOutcome(symbol, outcome),
    );
    this.opportunitySampler.start();
    this.startHealthReporting();

    logger.info('micro_burst_runtime_started', {
      mode: this.config.mode,
      symbols: enabledSymbols,
      evaluationIntervalMs: this.evaluationIntervalMs,
    });
  }

  stop(): Promise<void> {
    this.deps.strategyRouter.setObservationHook(undefined);
    if (this.stopPromise) return this.stopPromise;
    this.running = false;

    this.opportunitySampler?.stop();
    this.opportunitySampler = null;
    this.pendingOpportunitySamples.clear();

    if (this.evaluationTimer) {
      clearInterval(this.evaluationTimer);
      this.evaluationTimer = null;
    }
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }

    for (const [symbol, state] of this.symbolStates) {
      state.bookLease.release();
      state.aggTradeLease.release();
      state.aggTradeBuffer.clear();
      state.evaluationInFlight = false;
    }
    for (const lease of this.candleLeases) lease.release();
    this.candleLeases.length = 0;
    this.candleDataPlane = undefined;
    this.symbolStates.clear();

    if (this.btcProvider) {
      this.btcProvider.stop();
      this.btcProvider = null;
    }

    this.stopPromise = (async () => {
      const failures: string[] = [];
      try {
        this.journal.flush();
      } catch (error) {
        failures.push(`signal journal: ${String(error)}`);
      }

      // Attempt every durable sink even when an earlier sink fails.
      try {
        this.deps.outcomeTracker?.flushPending(this.deps.clock.now());
      } catch (error) {
        failures.push(`outcome tracker: ${String(error)}`);
      }
      try {
        this.shadowEngine.flush();
      } catch (error) {
        failures.push(`paper trade journal: ${String(error)}`);
      }
      if (this.paperPersistenceError)
        failures.push(`paper trade persistence: ${this.paperPersistenceError}`);
      if (this.shadowEngine.getCanonicalPersistenceFailureCount() > 0)
        failures.push('paper trade persistence: canonical write failures');
      try {
        await this.drainAndCloseStorage();
      } catch (error) {
        failures.push(`market storage: ${String(error)}`);
      }

      if (failures.length > 0) {
        const error = new Error(`MICRO_BURST_RUNTIME_SHUTDOWN_FAILED: ${failures.join('; ')}`);
        this.deps.logger.error('micro_burst_runtime_shutdown_failed', { error: error.message });
        throw error;
      }
      this.reportHealth('graceful_shutdown');
      this.deps.logger.info('micro_burst_runtime_stopped');
    })();
    return this.stopPromise;
  }

  async evaluateSymbol(
    symbol: string,
    snapshotAtMs?: number,
  ): Promise<MicroBurstShadowEvaluationResult | null> {
    const state = this.symbolStates.get(symbol);
    if (!state || !this.shadowEvaluator) return null;
    state.evaluationScheduled++;
    if (state.evaluationInFlight) return null;
    if (!this.running) return null;

    state.evaluationInFlight = true;
    state.evaluationStarted++;
    const t0 = this.deps.clock.now();

    try {
      const result = await this.shadowEvaluator.evaluate({
        symbol,
        snapshotAtMs,
      });
      state.latestDecision = {
        decision: result.decision,
        side: result.side ?? null,
        reason: typeof result.diagnostics?.reason === 'string' ? result.diagnostics.reason : null,
        confidence: result.confidence,
        uniqueCandidateId:
          result.wouldEnter && !result.duplicateSuppressed ? result.shadowSignalId : null,
      };

      let paperSuppressed = false;
      if (
        this.config.mode === 'SHADOW' &&
        result.wouldEnter &&
        !result.duplicateSuppressed &&
        result.side
      ) {
        const quote = this.paperQuote(state.book.getSnapshot());
        const decisionReceivedAtMs = this.deps.clock.now();
        const opened = this.shadowEngine.open(
          {
            strategyId: 'MICRO_BURST_V1',
            strategyVersion: result.strategyVersion,
            symbol: result.symbol,
            side: result.side,
            decisionAtMs: result.snapshotAtMs,
            decisionReceivedAtMs,
            referencePrice: result.referencePrice,
            structuralStop: result.structuralInvalidation ?? undefined,
            destination: result.destinationPrice ?? undefined,
            leverage: numberDiagnostic(result.diagnostics?.leverage),
            positionFraction: numberDiagnostic(result.diagnostics?.positionFraction),
            parentDecisionId: result.shadowSignalId,
            provenance: {
              strategyVersion: result.strategyVersion,
              cohortId: this.deps.provenance?.cohortId ?? 'UNOFFICIAL',
              codeCommitSha: this.deps.provenance?.codeCommitSha ?? 'UNKNOWN',
              configHash: this.deps.provenance?.configHash ?? 'UNKNOWN',
            },
            diagnostics: result.diagnostics,
          },
          quote,
        );
        if (opened.status === 'OPENED') {
          this.paperOpenSymbols.add(result.symbol);
        } else if (opened.status === 'SUPPRESSED') {
          paperSuppressed = true;
          this.paperSuppressedEntries++;
          const suppressionKey = `${symbol}:${opened.event.tradeId ?? 'UNKNOWN'}`;
          if (!this.paperSuppressionDiagnostics.has(suppressionKey)) {
            this.paperSuppressionDiagnostics.add(suppressionKey);
            this.deps.logger.info('micro_burst_paper_entry_suppressed', {
              symbol,
              tradeId: opened.event.tradeId,
            });
          }
        } else if (opened.status === 'DATA_UNCERTAIN' || opened.status === 'RECOVERY_BLOCKED') {
          if (opened.status === 'RECOVERY_BLOCKED') {
            this.paperRecoveryBlocked = true;
            this.paperPersistenceError = 'RECOVERY_BLOCKED';
          }
        }
      }

      if (
        this.config.mode === 'LIVE' &&
        result.wouldEnter &&
        !result.duplicateSuppressed &&
        result.side &&
        result.structuralInvalidation &&
        result.destinationPrice
      ) {
        const leverage = numberDiagnostic(result.diagnostics?.leverage);
        const positionFraction = numberDiagnostic(result.diagnostics?.positionFraction);
        if (leverage && positionFraction) {
          await this.deps.liveTrading?.open({
            symbol: result.symbol,
            side: result.side,
            signalId: result.shadowSignalId,
            strategyVersion: result.strategyVersion,
            requestedAt: this.deps.clock.now(),
            leverage,
            positionFraction,
            structuralStopPrice: result.structuralInvalidation,
            destinationPrice: result.destinationPrice,
            diagnostics: result.diagnostics ?? {},
          });
        }
      }

      state.evaluationCount++;
      state.evaluationCompleted++;
      state.lastEvaluationAt = t0;
      this.totalEvaluations++;

      if (result.dataQuality.contextValid) {
        if (result.duplicateSuppressed) {
          state.duplicateSignalCount++;
          this.totalDuplicateSignals++;
        } else if (result.wouldEnter && !paperSuppressed) {
          state.uniqueSignalCount++;
          this.totalUniqueSignals++;
          if (!this.journal.append(result, this.deps.provenance)) {
            this.deps.logger.error('micro_burst_signal_journal_write_failed', {
              shadowSignalId: result.shadowSignalId,
            });
          }

          // M3: Track signal for prospective outcome validation
          if (this.deps.outcomeTracker && result.side) {
            const snapshot = freezeSignalSnapshot({
              schemaVersion: 1,
              shadowSignalId: result.shadowSignalId,
              cohortId: this.deps.provenance?.cohortId ?? 'UNOFFICIAL',
              strategyId: 'MICRO_BURST_V1',
              strategyVersion: result.strategyVersion,
              codeCommitSha: this.deps.provenance?.codeCommitSha ?? 'UNKNOWN',
              configHash: this.deps.provenance?.configHash ?? 'UNKNOWN',
              symbol: result.symbol,
              side: result.side,
              signalAtMs: result.snapshotAtMs,
              marketPriceAtSignal: result.referencePrice,
              referencePriceSource:
                typeof result.diagnostics?.referencePriceSource === 'string'
                  ? result.diagnostics.referencePriceSource
                  : 'UNKNOWN',
              structuralStopPrice: result.structuralInvalidation ?? 0,
              destinationPrice: result.destinationPrice ?? 0,
              support: result.supportPrice,
              resistance: result.resistancePrice,
              roomToTargetBps: result.roomToTargetBps ?? 0,
              riskToInvalidationBps: result.riskToInvalidationBps ?? 0,
              rewardRisk: result.rewardRisk ?? 0,
              momentum: result.momentum,
              book: {
                status: result.book.status,
                ageMs: result.book.ageMs,
                imbalance: result.book.imbalance,
                imbalanceSlope: result.book.imbalanceSlope,
                temporalAbsorption:
                  typeof result.diagnostics?.temporalAbsorptionDetected === 'boolean'
                    ? result.diagnostics.temporalAbsorptionDetected
                    : false,
                temporalSweep:
                  typeof result.diagnostics?.temporalSweepDetected === 'boolean'
                    ? result.diagnostics.temporalSweepDetected
                    : false,
              },
              tradeFlow: {
                buyTakerVolume:
                  typeof result.diagnostics?.takerBuyVolume === 'number'
                    ? result.diagnostics.takerBuyVolume
                    : 0,
                sellTakerVolume:
                  typeof result.diagnostics?.takerSellVolume === 'number'
                    ? result.diagnostics.takerSellVolume
                    : 0,
                netTakerFlow:
                  typeof result.diagnostics?.takerNetFlow === 'number'
                    ? result.diagnostics.takerNetFlow
                    : 0,
                sampleCount:
                  typeof result.diagnostics?.takerFlowSampleCount === 'number'
                    ? result.diagnostics.takerFlowSampleCount
                    : 0,
              },
              btc: {
                status: result.btc.status,
                ageMs: result.btc.ageMs,
                ret1m: result.btc.ret1m,
                ret3m: result.btc.ret3m,
                ret5m: result.btc.ret5m,
                acceleration:
                  typeof result.diagnostics?.btcAcceleration === 'number'
                    ? result.diagnostics.btcAcceleration
                    : null,
                direction:
                  typeof result.diagnostics?.btcDirection === 'string'
                    ? (result.diagnostics.btcDirection as any)
                    : null,
                conflict: result.btc.conflict,
              },
              confidence: result.confidence,
              leverageTier:
                typeof result.diagnostics?.leverageTier === 'string'
                  ? result.diagnostics.leverageTier
                  : 'NONE',
              leverage:
                typeof result.diagnostics?.leverage === 'number' ? result.diagnostics.leverage : 0,
              positionFraction:
                typeof result.diagnostics?.positionFraction === 'number'
                  ? result.diagnostics.positionFraction
                  : 0,
              microRegime: result.microRegime,
            });
            this.deps.outcomeTracker.trackSignal(snapshot);
          }
        }
      } else {
        state.invalidContextCount++;
        this.totalInvalidContexts++;
      }

      const bookState = state.book.getState();
      state.bookResyncCount = bookState.resyncCount;

      return result;
    } catch (err) {
      state.evaluationFailed++;
      this.deps.logger.error('micro_burst_runtime_evaluation_error', {
        symbol,
        error: String(err),
      });
      return null;
    } finally {
      state.evaluationDurationsMs.push(Math.max(0, this.deps.clock.now() - t0));
      if (state.evaluationDurationsMs.length > 256) state.evaluationDurationsMs.shift();
      state.evaluationInFlight = false;
    }
  }

  getHealth(): MicroBurstRuntimeHealth {
    let healthyBooks = 0;
    for (const [, state] of this.symbolStates) {
      const h = state.book.getHealth();
      if (h === 'HEALTHY') healthyBooks++;
    }

    const btcContext = this.btcProvider?.getBtcContext();
    const btcAgeMs = btcContext ? this.deps.clock.now() - btcContext.receivedAtMs : null;
    const btcHealthy = btcAgeMs !== null && btcAgeMs >= 0 && btcAgeMs < 120_000;

    const archiveHealth = this.deps.marketStorage?.getHealth();
    const mutationAudit = this.deps.mutationAudit?.() ?? {
      totalMutationAttempts: 0,
      forwardedMutationCalls: 0,
    };
    return {
      running: this.running,
      symbolCount: this.symbolStates.size,
      healthyBooks,
      btcHealthy,
      totalEvaluations: this.totalEvaluations,
      totalUniqueSignals: this.totalUniqueSignals,
      paperSuppressedEntries: this.paperSuppressedEntries,
      totalDuplicateSignals: this.totalDuplicateSignals,
      totalInvalidContexts: this.totalInvalidContexts,
      totalResyncs: this.getTotalResyncs(),
      liveExecution: this.config.mode === 'LIVE' && this.deps.liveTrading !== undefined,
      paperEngine: 'GENERIC',
      lastHealthReportAt: this.lastHealthReportAt,
      outcomeTracker: this.deps.outcomeTracker ? this.deps.outcomeTracker.getHealth() : null,
      signalJournalHealthy: this.journal.getHealth().healthy,
      marketArchiveHealthy: archiveHealth?.healthy ?? null,
      archiveQueueDepth: archiveHealth?.queueDepth ?? null,
      archiveQueuedRecords: archiveHealth?.queuedRecords ?? null,
      archiveWrittenRecords: archiveHealth?.writtenRecords ?? null,
      archiveOverflowRecords: archiveHealth?.overflowRecords ?? null,
      archiveActiveSegmentCount: archiveHealth?.activeSegmentCount ?? null,
      archiveActiveSegmentRecords: archiveHealth?.activeSegmentRecords ?? null,
      archiveSegmentsFinalized: archiveHealth?.segmentsFinalized ?? null,
      archiveRecordsDurablyFlushed: archiveHealth?.recordsDurablyFlushed ?? null,
      archiveFinalizationQueueDepth: archiveHealth?.finalizationQueueDepth ?? null,
      archiveRecoveryFailures: archiveHealth?.recoveryFailures ?? null,
      archiveBytes: archiveHealth?.archiveBytes ?? null,
      archiveFileCount: archiveHealth?.archiveFileCount ?? null,
      archiveRetentionAgeMs: archiveHealth?.archiveRetentionAgeMs ?? null,
      archiveRetentionWarning: archiveHealth?.retentionWarning ?? null,
      opportunitySamples: (() => {
        const samplerHealth = this.opportunitySampler?.getHealth();
        return samplerHealth
          ? {
              sampled: samplerHealth.sampled,
              persisted: samplerHealth.persisted,
              persistenceRejected: samplerHealth.persistenceRejected,
              sinkErrors: samplerHealth.sinkErrors,
              tickDurationMs: samplerHealth.tickDurationMs,
              bySymbol: this.getOpportunityHealthBySymbol(),
            }
          : {
              sampled: 0,
              persisted: 0,
              persistenceRejected: 0,
              sinkErrors: 0,
              tickDurationMs: { p50: 0, p95: 0, p99: 0 },
              bySymbol: this.getOpportunityHealthBySymbol(),
            };
      })(),
      symbolMetrics: this.getSymbolMetrics(),
      storageErrors: this.journal.getHealth().storageErrors + (archiveHealth?.errorCount ?? 0),
      mutationAttempts: mutationAudit.totalMutationAttempts,
      forwardedMutations: mutationAudit.forwardedMutationCalls,
      readiness: this.getReadiness(),
      paperTrading: {
        openPositions: this.shadowEngine.getOpenPositions().length,
        recoveryBlocked:
          this.paperRecoveryBlocked ||
          Object.values(this.shadowEngine.getHealth().strategies).some(
            (strategy) => strategy.recoveryBlocked > 0,
          ),
        journalHealthy: this.shadowTradeJournal.getHealth().healthy,
        completedManagedTrades: this.shadowTradeJournal
          .loadAllPositions()
          .filter((position) => position.state === 'CLOSED').length,
        persistenceErrors: this.shadowEngine.getCanonicalPersistenceFailureCount(),
      },
    };
  }

  private managePaperTrade(symbol: string, event: AggTradeEvent): void {
    if (!this.paperOpenSymbols.has(symbol)) return;
    const state = this.symbolStates.get(symbol);
    const openPosition = this.shadowEngine
      .getOpenPositions()
      .find((position) => position.strategyId === 'MICRO_BURST_V1' && position.symbol === symbol);
    const snapshot = state?.book.getSnapshot();
    const receivedAtMs = event.receivedAtMs ?? this.deps.clock.now();
    const currentBookPressure = snapshot
      ? analyzeBookPressure(snapshot, receivedAtMs, undefined, snapshot.temporalHistory)
      : null;
    const result = this.shadowEngine.manage(
      { strategyId: 'MICRO_BURST_V1', symbol },
      {
        exchangeTimeMs: event.eventTime,
        receivedAtMs,
        currentPrice: event.price,
        quote: this.paperQuote(snapshot),
        marketDataQuality: snapshot?.status ?? 'UNAVAILABLE',
        strategyContext: {
          currentBookPressure,
          currentBtcContext: this.btcProvider?.getBtcContext() ?? null,
          marketEvidence: state
            ? buildExitMarketEvidence(state.aggTradeBuffer, openPosition?.openedAtMs)
            : null,
          anomalyExitFlag: false,
        },
      },
    );
    if (!result) return;
    if (result.state === 'CLOSED') {
      this.paperOpenSymbols.delete(symbol);
      this.paperSuppressionDiagnostics.delete(`${symbol}:${result.tradeId}`);
    }
  }

  readExitMarketSnapshot(symbol: string, sinceMs?: number): MicroBurstExitMarketSnapshot | null {
    const state = this.symbolStates.get(symbol);
    if (!state) return null;
    const trades = state.aggTradeBuffer.getRecent(EXIT_SHORT_HORIZON_MS);
    const eligibleTrades =
      sinceMs === undefined ? trades : trades.filter((trade) => trade.eventTime >= sinceMs);
    const latest = eligibleTrades[eligibleTrades.length - 1];
    if (!latest || !Number.isFinite(latest.price) || latest.price <= 0) return null;
    const now = this.deps.clock.now();
    if (latest.eventTime > now || now - latest.eventTime > EXIT_SHORT_HORIZON_MS) return null;
    const observedAtMs = latest.eventTime;
    const bookSnapshot = state.book.getSnapshot();
    return {
      currentPrice: latest.price,
      observedAtMs,
      currentBookPressure: bookSnapshot
        ? analyzeBookPressure(bookSnapshot, now, undefined, bookSnapshot.temporalHistory)
        : null,
      currentBtcContext: this.btcProvider?.getBtcContext() ?? null,
      marketEvidence: buildExitMarketEvidence(state.aggTradeBuffer, sinceMs),
    };
  }

  /** Deterministic smoke/soak hook; production uses the sampler's 1 s timer. */
  sampleOpportunityNow(): void {
    this.labelPendingOpportunitySamples();
    this.opportunitySampler?.tick();
  }

  private labelPendingOpportunitySamples(): void {
    const storage = this.deps.marketStorage;
    if (!storage?.persistOpportunityLabels) return;
    for (const [sampleId, sample] of this.pendingOpportunitySamples) {
      const state = this.symbolStates.get(sample.symbol);
      if (!state) continue;
      const flow = state.aggTradeBuffer.getTakerFlow(60_000);
      const labeled = labelMicroOpportunitySample(sample, {
        trades: state.aggTradeBuffer.getRecent(60_000),
        watermarkMs: flow.eventWatermarkMs ?? 0,
        hasAggTradeGap: (fromMs, toMs) =>
          this.deps.marketStorage?.hasAggTradeGap?.(sample.symbol, fromMs, toMs) ?? false,
      });
      if (Object.values(labeled.labels).some((label) => !label.valid)) continue;
      if (storage.persistOpportunityLabels(sampleId, labeled.labels as Record<number, unknown>))
        this.pendingOpportunitySamples.delete(sampleId);
    }
  }

  private recordOpportunityOutcome(symbol: string, outcome: MicroOpportunitySampleOutcome): void {
    const state = this.symbolStates.get(symbol);
    if (!state) return;
    state.opportunitySamplerAttempts++;
    if (outcome === 'persisted') state.opportunityPersisted++;
    else {
      state.opportunitySkipReasons[outcome] = (state.opportunitySkipReasons[outcome] ?? 0) + 1;
    }
  }

  private getOpportunityHealthBySymbol(): Record<
    string,
    {
      attempts: number;
      persisted: number;
      skipReasons: Record<string, number>;
    }
  > {
    return Object.fromEntries(
      [...this.symbolStates.entries()].map(([symbol, state]) => [
        symbol,
        {
          attempts: state.opportunitySamplerAttempts,
          persisted: state.opportunityPersisted,
          skipReasons: { ...state.opportunitySkipReasons },
        },
      ]),
    );
  }

  private getSymbolMetrics(): Record<string, Record<string, unknown>> {
    return Object.fromEntries(
      [...this.symbolStates.entries()].map(([symbol, state]) => [
        symbol,
        {
          evaluationScheduled: state.evaluationScheduled,
          evaluationStarted: state.evaluationStarted,
          evaluationCompleted: state.evaluationCompleted,
          evaluationFailed: state.evaluationFailed,
          evaluationDurationMs: MicroBurstRuntime.percentileSummary(state.evaluationDurationsMs),
          candleCacheHit: state.candleCacheHit,
          candleUnavailable: state.candleUnavailable,
          candleStale: state.candleStale,
          latestSlowStatePublished: state.latestSlowStatePublished,
          latestSlowStateAge:
            state.latestSlowStatePublishedAt === null
              ? null
              : Math.max(0, this.deps.clock.now() - state.latestSlowStatePublishedAt),
          opportunitySamplerAttempt: state.opportunitySamplerAttempts,
          opportunityPersisted: state.opportunityPersisted,
          skipReasons: { ...state.opportunitySkipReasons },
        },
      ]),
    );
  }

  private paperQuote(
    snapshot: ReturnType<SynchronizedOrderBook['getSnapshot']>,
  ): ShadowMarketQuote | undefined {
    if (!snapshot) return undefined;
    return {
      bestBid: snapshot.bidDepth[0]?.price ?? NaN,
      bestAsk: snapshot.askDepth[0]?.price ?? NaN,
      observedAtMs: snapshot.observedAtMs,
      status: snapshot.status,
    };
  }

  getReadiness(): MicroBurstRuntimeReadiness {
    const provenance = this.deps.provenance;
    const archive = this.deps.marketStorage;
    const archiveHealth = archive?.getHealth();

    let healthyBookCount = 0;
    for (const state of this.symbolStates.values()) {
      if (state.book.getHealth() === 'HEALTHY') healthyBookCount++;
    }
    const btcContext = this.btcProvider?.getBtcContext();
    const btcAgeMs = btcContext ? this.deps.clock.now() - btcContext.receivedAtMs : null;
    const btcHealthy = btcAgeMs !== null && btcAgeMs >= 0 && btcAgeMs < 120_000;
    const readiness = assessMicroBurstReadiness({
      codeSha: provenance?.codeCommitSha,
      configHash: provenance?.configHash,
      strategyVersion: this.deps.strategyRouter.get('MICRO_BURST_V1')?.identity.strategyVersion,
      cohortId: provenance?.cohortId,
      officialCohortReady: provenance?.officialCohortReady,
      mode: this.config.mode,
      enabled: this.config.enabled,
      enabledSymbolCount: Object.values(this.config.symbols).filter((symbol) => symbol.enabled)
        .length,
      healthyBookCount: this.running ? healthyBookCount : undefined,
      btcHealthy: this.running ? btcHealthy : undefined,
      aggTradeHealthy:
        this.running && this.symbolStates.size > 0
          ? [...this.symbolStates.values()].every((state) => {
              const flow = state.aggTradeBuffer.getTakerFlow();
              return flow.windowComplete && flow.gapFree && !flow.capacityTruncated;
            })
          : undefined,
      archiveEnabled: this.config.marketArchive?.enabled === true,
      archiveAvailable: archive !== undefined,
      archiveHealthy: archiveHealth?.healthy,
      storageHealthy: archiveHealth?.healthy,
      storageErrors: archiveHealth?.errorCount,
      databaseValid: archive !== undefined && archiveHealth?.healthy === true,
      preregistrationEnabled: this.config.prospectiveValidation?.enabled === true,
      mutationAuditAvailable: this.deps.readinessEvidence?.mutationAuditAvailable,
      unresolvedTradeGaps: this.countCurrentAggTradeGaps(),
      manifestValid: this.deps.readinessEvidence?.manifestValid,
      schemaValid: this.deps.readinessEvidence?.schemaValid,
      episodeDefinitionValid: this.deps.readinessEvidence?.episodeDefinitionValid,
      gapSemanticsValid: true,
      costSemanticsValid: this.deps.readinessEvidence?.costSemanticsValid,
      outcomeJournalHealthy: this.deps.outcomeTracker?.getHealth().journalHealthy ?? true,
      symbolBlockers: this.getSymbolReadinessBlockers(),
    });
    /* Retain detailed legacy diagnostics while the typed checks are authoritative. */
    const blockers = [...readiness.blockers];
    if (!this.running) blockers.push('RUNTIME_NOT_RUNNING');
    if (this.paperRecoveryBlocked) blockers.push('PAPER_RECOVERY_BLOCKED');
    if (this.config.mode === 'OFF') blockers.push('SHADOW_MODE_NOT_ENABLED');
    if (!this.config.prospectiveValidation?.enabled)
      blockers.push('PROSPECTIVE_VALIDATION_DISABLED');
    if (!this.config.marketArchive?.enabled) blockers.push('MARKET_ARCHIVE_DISABLED');
    if (!archive) blockers.push('MARKET_ARCHIVE_UNAVAILABLE');
    if (archiveHealth && !archiveHealth.healthy) blockers.push('MARKET_ARCHIVE_UNHEALTHY');
    const outcomeHealth = this.deps.outcomeTracker?.getHealth();
    if (outcomeHealth && outcomeHealth.journalHealthy === false)
      blockers.push('OUTCOME_JOURNAL_MALFORMED');
    if (
      archiveHealth &&
      archiveHealth.queueCapacity !== undefined &&
      archiveHealth.queueDepth !== undefined &&
      archiveHealth.queueDepth >= archiveHealth.queueCapacity
    ) {
      blockers.push('MARKET_ARCHIVE_QUEUE_AT_CAPACITY');
    }
    if (!provenance?.codeCommitSha || provenance.codeCommitSha === 'UNKNOWN')
      blockers.push('CODE_COMMIT_SHA_UNKNOWN');
    if (!provenance?.configHash || provenance.configHash === 'UNKNOWN')
      blockers.push('CONFIG_HASH_UNKNOWN');
    if (!provenance?.cohortId?.startsWith('MBV1-M3_2-')) blockers.push('COHORT_NAMESPACE_INVALID');
    if (!this.running) blockers.push('RUNTIME_NOT_RUNNING');

    return {
      ...readiness,
      ready: readiness.readyForSoak && blockers.length === 0,
      readyForSoak: readiness.readyForSoak && blockers.length === 0,
      readyForFreeze: readiness.readyForFreeze && blockers.length === 0,
      officialAuthority: readiness.officialAuthority && blockers.length === 0,
      blockers,
      cohortId: provenance?.cohortId ?? null,
      strategyVersion:
        this.deps.strategyRouter.get('MICRO_BURST_V1')?.identity.strategyVersion ?? null,
      codeCommitSha: provenance?.codeCommitSha ?? null,
      configHash: provenance?.configHash ?? null,
      liveExecution:
        this.running && this.config.mode === 'LIVE' && this.deps.liveTrading !== undefined,
    };
  }

  getSymbolHealth(symbol: string): {
    bookStatus: string;
    bookAgeMs: number | null;
    lastUpdateId: number;
    resyncCount: number;
    aggTradeCount: number;
    evaluationCount: number;
    uniqueSignals: number;
    duplicateSignals: number;
    invalidContexts: number;
    coverageStartedAtMs: number | null;
    eventWatermarkMs: number | null;
    requestedWindowMs: number;
    windowComplete: boolean;
    capacityTruncated: boolean;
    gapFree: boolean;
    tradeCount: number;
  } | null {
    const state = this.symbolStates.get(symbol);
    if (!state) return null;

    const bookState = state.book.getState();
    const recentTrades = state.aggTradeBuffer.getRecent();
    const flow = state.aggTradeBuffer.getTakerFlow();

    return {
      bookStatus: bookState.health,
      bookAgeMs: bookState.observedAtMs > 0 ? this.deps.clock.now() - bookState.observedAtMs : null,
      lastUpdateId: bookState.lastUpdateId,
      resyncCount: bookState.resyncCount,
      aggTradeCount: recentTrades.length,
      evaluationCount: state.evaluationCount,
      uniqueSignals: state.uniqueSignalCount,
      duplicateSignals: state.duplicateSignalCount,
      invalidContexts: state.invalidContextCount,
      coverageStartedAtMs: flow.coverageStartedAtMs,
      eventWatermarkMs: flow.eventWatermarkMs,
      requestedWindowMs: flow.requestedWindowMs,
      windowComplete: flow.windowComplete,
      capacityTruncated: flow.capacityTruncated,
      gapFree: flow.gapFree,
      tradeCount: flow.tradeCount,
    };
  }

  getSymbolStates(): ReadonlyMap<string, SymbolRuntimeState> {
    return this.symbolStates;
  }

  private getSymbolReadinessBlockers(): Record<string, string[]> {
    const blockers: Record<string, string[]> = {};
    for (const [symbol, state] of this.symbolStates) {
      const reasons: string[] = [];
      const bookHealth = state.book.getHealth();
      if (bookHealth !== 'HEALTHY') reasons.push(`BOOK_${bookHealth}`);
      const flow = state.aggTradeBuffer.getTakerFlow();
      if (!flow.windowComplete) reasons.push('AGG_TRADE_WINDOW_INCOMPLETE');
      if (flow.capacityTruncated) reasons.push('AGG_TRADE_CAPACITY_TRUNCATED');
      if (!flow.gapFree) reasons.push('AGG_TRADE_GAP');
      blockers[symbol] = reasons;
    }
    return blockers;
  }

  private countCurrentAggTradeGaps(): number | undefined {
    const storage = this.deps.marketStorage;
    if (!storage?.hasAggTradeGap) return undefined;
    let count = 0;
    for (const [symbol, state] of this.symbolStates) {
      const flow = state.aggTradeBuffer.getTakerFlow();
      if (flow.eventWatermarkMs === null) continue;
      if (
        storage.hasAggTradeGap(
          symbol,
          flow.eventWatermarkMs - flow.requestedWindowMs,
          flow.eventWatermarkMs,
        )
      )
        count++;
    }
    return count;
  }

  private startEvaluationLoop(): void {
    this.evaluationTimer = setInterval(async () => {
      if (!this.running) return;
      // A slow candle read for one symbol must not starve the other enabled symbols.
      await Promise.all([...this.symbolStates.keys()].map((symbol) => this.evaluateSymbol(symbol)));
    }, this.evaluationIntervalMs);
  }

  private static percentileSummary(values: readonly number[]): {
    p50: number;
    p95: number;
    p99: number;
  } {
    if (values.length === 0) return { p50: 0, p95: 0, p99: 0 };
    const sorted = [...values].sort((a, b) => a - b);
    const at = (fraction: number): number =>
      sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
    return { p50: at(0.5), p95: at(0.95), p99: at(0.99) };
  }

  private startHealthReporting(): void {
    this.healthTimer = setInterval(() => {
      if (!this.running) return;
      this.reportHealth('periodic');
    }, HEALTH_REPORT_INTERVAL_MS);
  }

  private reportHealth(phase: 'periodic' | 'graceful_shutdown'): void {
    const health = this.getHealth();
    this.lastHealthReportAt = this.deps.clock.now();
    this.deps.logger.info('MICRO_BURST_SHADOW_HEALTH', {
      phase,
      symbols: health.symbolCount,
      healthyBooks: health.healthyBooks,
      btcHealthy: health.btcHealthy,
      evaluations: health.totalEvaluations,
      uniqueSignals: health.totalUniqueSignals,
      duplicates: health.totalDuplicateSignals,
      invalidContexts: health.totalInvalidContexts,
      resyncs: health.totalResyncs,
      liveExecution: health.liveExecution,
      signalJournalHealthy: health.signalJournalHealthy,
      marketArchiveHealthy: health.marketArchiveHealthy,
      archiveQueueDepth: health.archiveQueueDepth,
      archiveQueuedRecords: health.archiveQueuedRecords,
      archiveWrittenRecords: health.archiveWrittenRecords,
      archiveOverflowRecords: health.archiveOverflowRecords,
      archiveBytes: health.archiveBytes,
      archiveFileCount: health.archiveFileCount,
      archiveRetentionAgeMs: health.archiveRetentionAgeMs,
      archiveRetentionWarning: health.archiveRetentionWarning,
      pendingOutcomes: health.outcomeTracker?.pendingOutcomes ?? 0,
      completedOutcomes: health.outcomeTracker?.completedOutcomes ?? 0,
      storageErrors: health.storageErrors,
      mutationAttempts: health.mutationAttempts,
      forwardedMutations: health.forwardedMutations,
      opportunitySamplerTickMs: health.opportunitySamples.tickDurationMs,
      opportunitySamplesJson: JSON.stringify(health.opportunitySamples),
      symbolMetricsJson: JSON.stringify(health.symbolMetrics),
    });
  }

  private getTotalResyncs(): number {
    let total = 0;
    for (const [, state] of this.symbolStates) {
      total += state.book.getState().resyncCount;
    }
    return total;
  }

  private async drainAndCloseStorage(): Promise<void> {
    const storage = this.deps.marketStorage;
    if (!storage) return;
    try {
      const flushed = await storage.flush?.();
      if (flushed === false) throw new Error('MICRO_BURST_STORAGE_FLUSH_FAILED');
      const result = await storage.close?.();
      if ((result as boolean | undefined) === false)
        throw new Error('MICRO_BURST_STORAGE_CLOSE_FAILED');
    } catch (error) {
      this.deps.logger.error('micro_burst_runtime_storage_shutdown_failed', {
        error: String(error),
      });
      throw error;
    }
  }
}

function buildExitMarketEvidence(
  buffer: RollingAggTradeBuffer,
  sinceMs?: number,
): MicroBurstExitMarketEvidence | null {
  const afterEntry = (trade: AggTradeEvent): boolean =>
    sinceMs === undefined || trade.eventTime >= sinceMs;
  const shortTrades = buffer.getRecent(EXIT_SHORT_HORIZON_MS).filter(afterEntry);
  const mediumTrades = buffer.getRecent(EXIT_MEDIUM_HORIZON_MS).filter(afterEntry);
  const flow = buffer.getTakerFlow(EXIT_SHORT_HORIZON_MS);
  if (flow.eventWatermarkMs === null) return null;
  let buyTakerVolume = 0;
  let sellTakerVolume = 0;
  for (const trade of shortTrades) {
    if (trade.isBuyerMaker) sellTakerVolume += trade.quantity;
    else buyTakerVolume += trade.quantity;
  }
  return {
    observedAtMs: flow.eventWatermarkMs,
    shortHorizonReturnBps: priceReturnBps(shortTrades),
    mediumHorizonReturnBps: priceReturnBps(mediumTrades),
    priceSampleCount: shortTrades.length,
    buyTakerVolume,
    sellTakerVolume,
    takerTradeCount: shortTrades.length,
    takerFlowWindowComplete:
      flow.windowComplete &&
      (sinceMs === undefined || sinceMs <= flow.eventWatermarkMs - flow.requestedWindowMs),
    takerFlowGapFree: flow.gapFree,
  };
}

function priceReturnBps(trades: ReadonlyArray<AggTradeEvent>): number | null {
  if (trades.length < 2) return null;
  const first = trades[0]?.price;
  const last = trades[trades.length - 1]?.price;
  if (!Number.isFinite(first) || !Number.isFinite(last) || first <= 0 || last <= 0) return null;
  return ((last - first) / first) * 10_000;
}

function numberDiagnostic(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
