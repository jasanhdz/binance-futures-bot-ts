import type { Exchange } from '../../../app/ports/Exchange';
import type { Logger } from '../../../app/ports/Logger';
import type {
  DecisionEvidenceSink,
  MarketSnapshotEvidenceSink,
} from '../../../core/blackbox/StrategyDecisionBlackBox';
import type { StrategyRouter } from '../../../core/strategy/StrategyRouter';
import { createReadOnlyAuditedExchange } from '../../../infra/adapters/ReadOnlyAuditedExchange';
import type { SharedMarketDataRuntime } from '../../../app/services/SharedMarketDataRuntime';
import { MicroBurstOutcomeJournal } from '../research/MicroBurstOutcomeJournal';
import { MicroBurstOutcomeTracker } from '../research/MicroBurstOutcomeTracker';
import { MicroBurstStorage } from '../research/MicroBurstStorage';
import type { MicroBurstStrategyContext } from '../domain/MicroBurstStrategy';
import { MicroBurstRuntime, type MicroBurstRuntimeReadiness } from './MicroBurstRuntime';
import type { MicroBurstRuntimeConfig } from './MicroBurstRuntimeTypes';

export interface MicroBurstRuntimeCoordinatorDeps {
  exchange: Exchange;
  logger: Logger;
  sharedMarketData: SharedMarketDataRuntime;
  strategyRouter: StrategyRouter<MicroBurstStrategyContext>;
  decisionSink: DecisionEvidenceSink;
  marketSnapshotSink: MarketSnapshotEvidenceSink;
  provenance: {
    codeCommitSha: string;
    configHash: string;
    cohortId: string;
    officialCohortReady: boolean;
  };
}

export class MicroBurstRuntimeCoordinator {
  private runtime: MicroBurstRuntime | null = null;
  private readiness: MicroBurstRuntimeReadiness | null = null;

  constructor(private readonly deps: MicroBurstRuntimeCoordinatorDeps) {}

  async start(config: MicroBurstRuntimeConfig): Promise<MicroBurstRuntimeReadiness> {
    if (this.runtime) return this.readiness ?? this.runtime.getReadiness();
    const { exchange, logger, sharedMarketData, strategyRouter, decisionSink, marketSnapshotSink, provenance } = this.deps;

    try {
      const auditedExchange = createReadOnlyAuditedExchange(exchange, provenance.codeCommitSha);
      const archiveConfig = config.marketArchive;
      const storage = archiveConfig?.enabled
        ? new MicroBurstStorage({
            databasePath: archiveConfig.sqlitePath ?? 'data/micro-burst/micro_burst_research.sqlite',
            archivePath: archiveConfig.rootDir ?? 'data/micro-burst/market-data',
            maxActiveSegmentRecords: archiveConfig.maxActiveSegmentRecords,
            maxActiveSegmentBytes: archiveConfig.maxActiveSegmentBytes,
            maxActiveSegmentDurationMs: archiveConfig.maxActiveSegmentDurationMs,
            durabilityFlushIntervalMs: archiveConfig.durabilityFlushIntervalMs,
          })
        : undefined;

      sharedMarketData.setArchiveObserver({
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
        hasAggTradeGap: (symbol, fromMs, toMs) => storage?.hasAggTradeGap?.(symbol, fromMs, toMs) ?? false,
      });

      const outcomeTracker = new MicroBurstOutcomeTracker({
        logger,
        clock: { now: () => Date.now() },
        journal: new MicroBurstOutcomeJournal(),
        storage,
      });
      this.runtime = new MicroBurstRuntime(
        {
          exchange: auditedExchange.exchange,
          logger,
          clock: { now: () => Date.now() },
          strategyRouter,
          orderBookDataPlane: sharedMarketData.orderBookDataPlane,
          aggTradeDataPlane: sharedMarketData.aggTradeDataPlane,
          blackBox: { decisionSink, marketSnapshotSink },
          outcomeTracker,
          marketStorage: storage,
          provenance,
          mutationAudit: () => ({
            totalMutationAttempts: auditedExchange.audit.totalMutationAttempts,
            forwardedMutationCalls: auditedExchange.audit.forwardedMutationCalls,
          }),
        },
        config,
      );

      outcomeTracker.recoverPending();
      await this.runtime.start();
      this.readiness = this.runtime.getReadiness();
      if (this.readiness.ready) {
        logger.info('MICRO_BURST_PROSPECTIVE_COHORT_READY', { ...this.readiness });
      } else {
        logger.error('MICRO_BURST_PROSPECTIVE_COHORT_NOT_READY', { ...this.readiness });
      }
      logger.info('micro_burst_runtime_integrated', {
        mode: config.mode,
        symbols: Object.keys(config.symbols).filter((symbol) => config.symbols[symbol].enabled),
        liveExecution: false,
        readOnlyExchangeBoundary: true,
        mutationAttempts: auditedExchange.audit.totalMutationAttempts,
        forwardedMutations: auditedExchange.audit.forwardedMutationCalls,
      });
      return this.readiness;
    } catch (error) {
      logger.error('micro_burst_runtime_startup_failed', { error: String(error) });
      const current = this.runtime?.getReadiness();
      this.readiness = current
        ? {
            ...current,
            ready: false,
            blockers: [...new Set([...current.blockers, 'NOT_READY'])],
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
            checks: {} as any,
            warnings: [],
            symbolBlockers: {},
          };
      logger.error('MICRO_BURST_PROSPECTIVE_COHORT_NOT_READY', { ...this.readiness });
      return this.readiness;
    }
  }

  getReadiness(): MicroBurstRuntimeReadiness | null {
    return this.readiness;
  }

  async stop(): Promise<void> {
    const runtime = this.runtime;
    this.runtime = null;
    await runtime?.stop();
  }
}
