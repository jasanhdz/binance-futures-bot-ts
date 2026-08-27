import { Logger } from '../../../app/ports/Logger';
import { Exchange } from '../../../app/ports/Exchange';
import { StrategyRouter } from '../../../app/strategy/StrategyRouter';
import { SynchronizedOrderBook, SynchronizedOrderBookDeps } from './SynchronizedOrderBook';
import { BtcMicroContextProvider, BtcMicroContextDeps } from './BtcMicroContextProvider';
import { MicroBurstAggTradeBuffer } from './MicroBurstAggTradeBuffer';
import { MicroBurstReferencePriceProvider, MicroBurstReferencePriceDeps } from './MicroBurstReferencePrice';
import { MicroBurstShadowEvaluator } from './MicroBurstShadowEvaluator';
import { MicroBurstDuplicateSignalGuard } from './MicroBurstDuplicateSignalGuard';
import {
  MicroBurstRuntimeConfig,
  MicroBurstShadowEvaluationResult,
  AggTradeEvent,
  SynchronizedOrderBookState,
} from './MicroBurstMarketDataTypes';
import { MicroBurstStrategyContext } from './MicroBurstStrategy';
import { MicroBurstContextBuilderDeps } from './MicroBurstContextBuilder';
import { MicroBurstSignalJournal } from './MicroBurstSignalJournal';
import { ShadowSignalSnapshot } from './MicroBurstOutcomeTypes';
import { freezeSignalSnapshot } from './MicroBurstOutcomeEngine';

const DEFAULT_EVALUATION_INTERVAL_MS = 5000;
const HEALTH_REPORT_INTERVAL_MS = 60_000;

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
  totalDuplicateSignals: number;
  totalInvalidContexts: number;
  totalResyncs: number;
  liveExecution: false;
  lastHealthReportAt: number;
  outcomeTracker: {
    signalsObserved: number;
    pendingOutcomes: number;
    completedOutcomes: number;
    outcomeErrors: number;
  } | null;
  signalJournalHealthy: boolean;
  marketArchiveHealthy: boolean | null;
  storageErrors: number;
  readiness: MicroBurstRuntimeReadiness;
}

export interface MicroBurstRuntimeReadiness {
  ready: boolean;
  blockers: string[];
  cohortId: string | null;
  strategyVersion: string | null;
  codeCommitSha: string | null;
  configHash: string | null;
  liveExecution: false;
}

interface SymbolRuntimeState {
  book: SynchronizedOrderBook;
  aggTradeBuffer: MicroBurstAggTradeBuffer;
  referencePriceProvider: MicroBurstReferencePriceProvider;
  evaluationInFlight: boolean;
  lastEvaluationAt: number;
  evaluationCount: number;
  uniqueSignalCount: number;
  duplicateSignalCount: number;
  invalidContextCount: number;
  bookResyncCount: number;
  unsubscribeAggTrades?: () => void;
}

export interface MicroBurstRuntimeDeps {
  exchange: Exchange;
  logger: Logger;
  clock: Clock;
  strategyRouter: StrategyRouter<MicroBurstStrategyContext>;
  outcomeTracker?: {
    trackSignal(snapshot: ShadowSignalSnapshot): void;
    processTradeEvent(event: { eventTime: number; receivedAtMs?: number; price: number; symbol: string; quantity?: number; isBuyerMaker?: boolean; tradeTime?: number; aggregateTradeId?: number; firstTradeId?: number; lastTradeId?: number }): void;
    flushPending(currentTimeMs: number): void;
    getHealth(): { signalsObserved: number; pendingOutcomes: number; completedOutcomes: number; outcomeErrors: number };
  };
  marketStorage?: {
    appendDepth(event: Record<string, unknown>): boolean;
    persistCheckpoint(symbol: string, eventTimeMs: number, checkpoint: unknown): boolean;
    flush?(): boolean | Promise<boolean>;
    close?(): void | Promise<void>;
    getHealth(): { healthy: boolean; errorCount: number; queueDepth?: number; queueCapacity?: number; draining?: boolean };
  };
  provenance?: { codeCommitSha: string; configHash: string; cohortId: string; officialCohortReady: boolean };
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
  private totalDuplicateSignals = 0;
  private totalInvalidContexts = 0;
  private lastHealthReportAt = 0;
  private readonly evaluationIntervalMs: number;
  private readonly journal: MicroBurstSignalJournal;
  private stopPromise: Promise<void> | null = null;

  constructor(
    private readonly deps: MicroBurstRuntimeDeps,
    private readonly config: MicroBurstRuntimeConfig,
    evaluationIntervalMs = DEFAULT_EVALUATION_INTERVAL_MS,
    journalDir?: string,
  ) {
    this.evaluationIntervalMs = evaluationIntervalMs;
    this.journal = new MicroBurstSignalJournal(journalDir);
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (!this.config.enabled || this.config.mode === 'OFF') {
      this.deps.logger.info('micro_burst_runtime_skip_start', {
        enabled: this.config.enabled,
        mode: this.config.mode,
      });
      return;
    }

    if (this.config.mode === 'LIVE') {
      this.deps.logger.error('micro_burst_runtime_live_rejected', {
        message: 'MICRO_BURST_V1 LIVE mode not authorized. Failing closed.',
      });
      throw new Error('MICRO_BURST_V1_LIVE_NOT_AUTHORIZED');
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

    const btcDeps: BtcMicroContextDeps = {
      getCandles: (sym, interval, limit) => exchange.getCandles(sym, interval, limit),
      logger,
    };
    this.btcProvider = new BtcMicroContextProvider('BTCUSDT', btcDeps, clock);
    this.btcProvider.start();

    const duplicateGuard = new MicroBurstDuplicateSignalGuard(clock);

    for (const symbol of enabledSymbols) {
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

      const book = new SynchronizedOrderBook(symbol, bookDeps);
      const aggTradeBuffer = new MicroBurstAggTradeBuffer(clock);

      const refPriceDeps: MicroBurstReferencePriceDeps = {
        getMarkPrice: (sym: string) => exchange.getMarkPrice(sym),
        getDepthSnapshot: book.getSnapshotForPressure.bind(book) as any,
        logger,
      };
      const refPriceProvider = new MicroBurstReferencePriceProvider(refPriceDeps, clock);

      const state: SymbolRuntimeState = {
        book,
        aggTradeBuffer,
        referencePriceProvider: refPriceProvider,
        evaluationInFlight: false,
        lastEvaluationAt: 0,
        evaluationCount: 0,
        uniqueSignalCount: 0,
        duplicateSignalCount: 0,
        invalidContextCount: 0,
        bookResyncCount: 0,
      };
      this.symbolStates.set(symbol, state);

      book.start();

      if (exchange.subscribeToAggTrades) {
        state.unsubscribeAggTrades = exchange.subscribeToAggTrades(symbol, (trade) => {
          const event: AggTradeEvent = {
            eventTime: trade.eventTime,
            price: Number(trade.price),
            quantity: Number(trade.quantity),
            isBuyerMaker: trade.isBuyerMaker,
          };
          aggTradeBuffer.push(event);

          // M3: Forward trade events to outcome tracker
          if (this.deps.outcomeTracker) {
            this.deps.outcomeTracker.processTradeEvent({
              eventTime: trade.eventTime,
              receivedAtMs: trade.receivedAtMs,
              price: Number(trade.price),
              symbol,
              quantity: Number(trade.quantity),
              isBuyerMaker: trade.isBuyerMaker,
              tradeTime: trade.tradeTime,
              aggregateTradeId: trade.aggregateTradeId,
              firstTradeId: trade.firstTradeId,
              lastTradeId: trade.lastTradeId,
            });
          }
        });
      }

      refPriceProvider.pollMarkPrice(symbol).catch(() => {});
    }

    const contextBuilderDeps: MicroBurstContextBuilderDeps = {
      candles: {
        getCandles: (sym, interval, limit) => exchange.getCandles(sym, interval, limit),
      },
      btc: this.btcProvider,
      book: {
        getDepthSnapshot: (sym: string) => {
          const state = this.symbolStates.get(sym);
          if (!state) return undefined;
          return state.book.getSnapshotForPressure() as any;
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
          if (!state) return { buyVolume: 0, sellVolume: 0, netTakerVolume: 0, tradeCount: 0 };
          return state.aggTradeBuffer.getTakerFlow();
        },
      },
    };

    this.shadowEvaluator = new MicroBurstShadowEvaluator(
      {
        contextBuilderDeps,
        strategyRouter: this.deps.strategyRouter,
        duplicateGuard,
        logger,
        clock,
        getServerTime: () => exchange.getServerTime(),
      },
      this.config,
    );

    this.startEvaluationLoop();
    this.startHealthReporting();

    logger.info('micro_burst_runtime_started', {
      mode: this.config.mode,
      symbols: enabledSymbols,
      evaluationIntervalMs: this.evaluationIntervalMs,
    });
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (!this.running) return Promise.resolve();
    this.running = false;

    if (this.evaluationTimer) {
      clearInterval(this.evaluationTimer);
      this.evaluationTimer = null;
    }
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }

    for (const [symbol, state] of this.symbolStates) {
      state.book.stop();
      state.unsubscribeAggTrades?.();
      state.aggTradeBuffer.clear();
      state.evaluationInFlight = false;
    }
    this.symbolStates.clear();

    if (this.btcProvider) {
      this.btcProvider.stop();
      this.btcProvider = null;
    }

    this.journal.flush();

    // M3: Flush pending outcomes
    if (this.deps.outcomeTracker) {
      this.deps.outcomeTracker.flushPending(this.deps.clock.now());
    }
    this.deps.logger.info('micro_burst_runtime_stopped');
    this.stopPromise = this.drainAndCloseStorage().finally(() => {
      this.stopPromise = null;
    });
    return this.stopPromise;
  }

  async evaluateSymbol(symbol: string, snapshotAtMs?: number): Promise<MicroBurstShadowEvaluationResult | null> {
    const state = this.symbolStates.get(symbol);
    if (!state || !this.shadowEvaluator) return null;
    if (state.evaluationInFlight) return null;
    if (!this.running) return null;

    state.evaluationInFlight = true;
    const t0 = this.deps.clock.now();

    try {
      const result = await this.shadowEvaluator.evaluate({
        symbol,
        snapshotAtMs,
      });

      state.evaluationCount++;
      state.lastEvaluationAt = t0;
      this.totalEvaluations++;

      if (result.dataQuality.contextValid) {
        if (result.duplicateSuppressed) {
          state.duplicateSignalCount++;
          this.totalDuplicateSignals++;
        } else if (result.wouldEnter) {
          state.uniqueSignalCount++;
          this.totalUniqueSignals++;
          if (!this.journal.append(result, this.deps.provenance)) {
            this.deps.logger.error('micro_burst_signal_journal_write_failed', { shadowSignalId: result.shadowSignalId });
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
              referencePriceSource: typeof result.diagnostics?.referencePriceSource === 'string'
                ? result.diagnostics.referencePriceSource : 'UNKNOWN',
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
                temporalAbsorption: typeof result.diagnostics?.temporalAbsorptionDetected === 'boolean'
                  ? result.diagnostics.temporalAbsorptionDetected : false,
                temporalSweep: typeof result.diagnostics?.temporalSweepDetected === 'boolean'
                  ? result.diagnostics.temporalSweepDetected : false,
              },
              tradeFlow: {
                buyTakerVolume: typeof result.diagnostics?.takerBuyVolume === 'number'
                  ? result.diagnostics.takerBuyVolume : 0,
                sellTakerVolume: typeof result.diagnostics?.takerSellVolume === 'number'
                  ? result.diagnostics.takerSellVolume : 0,
                netTakerFlow: typeof result.diagnostics?.takerNetFlow === 'number'
                  ? result.diagnostics.takerNetFlow : 0,
                sampleCount: typeof result.diagnostics?.takerFlowSampleCount === 'number'
                  ? result.diagnostics.takerFlowSampleCount : 0,
              },
              btc: {
                status: result.btc.status,
                ageMs: result.btc.ageMs,
                ret1m: result.btc.ret1m,
                ret3m: result.btc.ret3m,
                ret5m: result.btc.ret5m,
                acceleration: typeof result.diagnostics?.btcAcceleration === 'number'
                  ? result.diagnostics.btcAcceleration : null,
                direction: typeof result.diagnostics?.btcDirection === 'string'
                  ? result.diagnostics.btcDirection as any : null,
                conflict: result.btc.conflict,
              },
              confidence: result.confidence,
              leverageTier: typeof result.diagnostics?.leverageTier === 'string'
                ? result.diagnostics.leverageTier : 'NONE',
              leverage: typeof result.diagnostics?.leverage === 'number'
                ? result.diagnostics.leverage : 0,
              positionFraction: typeof result.diagnostics?.positionFraction === 'number'
                ? result.diagnostics.positionFraction : 0,
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
      this.deps.logger.error('micro_burst_runtime_evaluation_error', {
        symbol,
        error: String(err),
      });
      return null;
    } finally {
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
    const btcHealthy = !!btcContext && this.deps.clock.now() - btcContext.observedAtMs < 120_000;

    return {
      running: this.running,
      symbolCount: this.symbolStates.size,
      healthyBooks,
      btcHealthy,
      totalEvaluations: this.totalEvaluations,
      totalUniqueSignals: this.totalUniqueSignals,
      totalDuplicateSignals: this.totalDuplicateSignals,
      totalInvalidContexts: this.totalInvalidContexts,
      totalResyncs: this.getTotalResyncs(),
      liveExecution: false,
      lastHealthReportAt: this.lastHealthReportAt,
      outcomeTracker: this.deps.outcomeTracker ? this.deps.outcomeTracker.getHealth() : null,
      signalJournalHealthy: this.journal.getHealth().healthy,
      marketArchiveHealthy: this.deps.marketStorage ? this.deps.marketStorage.getHealth().healthy : null,
      storageErrors: this.journal.getHealth().storageErrors + (this.deps.marketStorage?.getHealth().errorCount ?? 0),
      readiness: this.getReadiness(),
    };
  }

  getReadiness(): MicroBurstRuntimeReadiness {
    const blockers: string[] = [];
    const provenance = this.deps.provenance;
    const archive = this.deps.marketStorage;
    const archiveHealth = archive?.getHealth();

    if (!this.config.enabled) blockers.push('MICRO_BURST_DISABLED');
    if (this.config.mode !== 'SHADOW') blockers.push(this.config.mode === 'LIVE' ? 'LIVE_MODE_NOT_DISABLED' : 'SHADOW_MODE_NOT_ENABLED');
    if (!this.config.prospectiveValidation?.enabled) blockers.push('PROSPECTIVE_VALIDATION_DISABLED');
    if (!this.config.marketArchive?.enabled) blockers.push('MARKET_ARCHIVE_DISABLED');
    if (!archive) blockers.push('MARKET_ARCHIVE_UNAVAILABLE');
    if (archiveHealth && !archiveHealth.healthy) blockers.push('MARKET_ARCHIVE_UNHEALTHY');
    if (archiveHealth && archiveHealth.queueCapacity !== undefined && archiveHealth.queueDepth !== undefined && archiveHealth.queueDepth >= archiveHealth.queueCapacity) {
      blockers.push('MARKET_ARCHIVE_QUEUE_AT_CAPACITY');
    }
    if (!provenance?.codeCommitSha || provenance.codeCommitSha === 'UNKNOWN') blockers.push('CODE_COMMIT_SHA_UNKNOWN');
    if (!provenance?.configHash || provenance.configHash === 'UNKNOWN') blockers.push('CONFIG_HASH_UNKNOWN');
    if (!provenance?.cohortId?.startsWith('MBV1-M3_2-')) blockers.push('COHORT_NAMESPACE_INVALID');
    if (!provenance?.officialCohortReady) blockers.push('OFFICIAL_COHORT_NOT_READY');
    if (!this.running) blockers.push('RUNTIME_NOT_RUNNING');

    return {
      ready: blockers.length === 0,
      blockers,
      cohortId: provenance?.cohortId ?? null,
      strategyVersion: this.deps.strategyRouter.get('MICRO_BURST_V1')?.identity.strategyVersion ?? null,
      codeCommitSha: provenance?.codeCommitSha ?? null,
      configHash: provenance?.configHash ?? null,
      liveExecution: false,
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
  } | null {
    const state = this.symbolStates.get(symbol);
    if (!state) return null;

    const bookState = state.book.getState();
    const recentTrades = state.aggTradeBuffer.getRecent();

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
    };
  }

  getSymbolStates(): ReadonlyMap<string, SymbolRuntimeState> {
    return this.symbolStates;
  }

  private startEvaluationLoop(): void {
    this.evaluationTimer = setInterval(async () => {
      if (!this.running) return;
      for (const symbol of this.symbolStates.keys()) {
        if (!this.running) break;
        await this.evaluateSymbol(symbol);
      }
    }, this.evaluationIntervalMs);
  }

  private startHealthReporting(): void {
    this.healthTimer = setInterval(() => {
      if (!this.running) return;
      const health = this.getHealth();
      this.lastHealthReportAt = this.deps.clock.now();
      this.deps.logger.info('MICRO_BURST_SHADOW_HEALTH', {
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
        pendingOutcomes: health.outcomeTracker?.pendingOutcomes ?? 0,
        completedOutcomes: health.outcomeTracker?.completedOutcomes ?? 0,
        storageErrors: health.storageErrors,
      });
    }, HEALTH_REPORT_INTERVAL_MS);
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
      await storage.flush?.();
      await storage.close?.();
    } catch (error) {
      this.deps.logger.error('micro_burst_runtime_storage_shutdown_failed', { error: String(error) });
    }
  }
}
