/**
 * MICRO BURST V1 — Prospective Outcome Tracker
 *
 * Application-layer component that:
 * - Receives frozen signal snapshots (T0 immutable)
 * - Observes trade events after T0
 * - Computes outcomes at configurable horizons
 * - Persists completed outcomes to journal
 *
 * NO exchange mutation authority. NO entry evaluation participation.
 * Separation: ENTRY PLANE ≠ OUTCOME PLANE.
 */

import { Logger } from '../ports/Logger';
import {
  ShadowSignalSnapshot,
  PendingOutcome,
  ProspectiveOutcomeRecord,
  OutcomeTrackerHealth,
} from '../../domain/strategies/micro-burst/MicroBurstOutcomeTypes';
import {
  computeEntryModels,
  computeAllHorizons,
  aggregateBarrierOutcome,
  computeCostScenarios,
  computeCostComponents,
  simulateDynamicExit,
  createPendingOutcome,
  sideAwareReturnBps,
  computeHorizonOutcome,
  computeEntryModelOutcomes,
  OUTCOME_HORIZONS_MS,
} from '../../domain/strategies/micro-burst/MicroBurstOutcomeEngine';
import { createMicroBurstEpisodeId } from '../../domain/strategies/micro-burst/MicroBurstIdentity';
import {
  MicroBurstConfig,
  defaultMicroBurstConfig,
} from '../../domain/strategies/micro-burst/MicroBurstTypes';
import { MicroBurstOutcomeJournal } from './MicroBurstOutcomeJournal';
import { MicroBurstTradeHistoryStore } from './MicroBurstTradeHistoryStore';
import { MicroBurstStorage } from './MicroBurstStorage';
import { MICRO_BURST_OUTCOME_FEED_DEPENDENCIES } from './MicroBurstFeedDependencies';

interface Clock {
  now(): number;
}

interface OutcomeTrackerDeps {
  logger: Logger;
  clock: Clock;
  journal: MicroBurstOutcomeJournal;
  config?: MicroBurstConfig;
  /** Maximum pending outcomes in memory. Oldest completed are evicted. */
  maxPendingOutcomes?: number;
  /** @deprecated History is time-retained per symbol, never count-truncated. */
  maxPriceHistoryPerSignal?: number;
  storage?: MicroBurstStorage;
}

const DEFAULT_MAX_PENDING = 500;

export class MicroBurstOutcomeTracker {
  private readonly pending = new Map<string, PendingOutcome>();
  private readonly completedIds = new Set<string>();
  private readonly episodes = new Map<
    string,
    {
      signalIds: Set<string>;
      primarySignalId: string;
      symbol: string;
      side: string;
      cohortId?: string | null;
      startedAtMs: number;
      endedAtMs: number;
    }
  >();

  private signalsObserved = 0;
  private completedOutcomes = 0;
  private outcomeErrors = 0;
  private targetFirst = 0;
  private stopFirst = 0;
  private neither = 0;
  private ambiguous = 0;
  private totalMfeBps = 0;
  private totalMaeBps = 0;

  private readonly maxPending: number;
  private readonly exitConfig: MicroBurstConfig;
  private readonly tradeHistory = new MicroBurstTradeHistoryStore();
  private readonly eventWatermarks = new Map<string, number>();
  private readonly knownSignals = new Map<string, ShadowSignalSnapshot>();

  constructor(private readonly deps: OutcomeTrackerDeps) {
    if (!deps.storage && !deps.journal.getHealth().journalHealthy) {
      throw new Error('MALFORMED_OUTCOME_JOURNAL_REQUIRES_SQLITE_AUTHORITY');
    }
    this.maxPending = deps.maxPendingOutcomes ?? DEFAULT_MAX_PENDING;
    this.exitConfig = deps.config ?? defaultMicroBurstConfig();
    for (const episode of deps.storage?.loadEpisodes() ?? []) {
      this.episodes.set(episode.episodeId, { ...episode, signalIds: new Set(episode.signalIds) });
    }
    for (const signal of deps.storage?.loadSignalReconciliation().signals ?? []) {
      if (isSignalSnapshot(signal)) this.knownSignals.set(signal.shadowSignalId, signal);
    }
  }

  /** Register a new signal snapshot for prospective tracking. */
  trackSignal(signal: ShadowSignalSnapshot): void {
    this.signalsObserved++;
    this.knownSignals.set(signal.shadowSignalId, signal);

    // Idempotency: skip if already tracked or completed
    if (
      this.pending.has(signal.shadowSignalId) ||
      this.completedIds.has(signal.shadowSignalId) ||
      this.deps.journal.getWrittenIds().has(signal.shadowSignalId) ||
      this.deps.storage?.hasCompletedOutcome(signal.shadowSignalId)
    ) {
      return;
    }

    // Episodes are connected components of causal signal windows, so arrival order is irrelevant.
    this.rebuildEpisodes(signal.symbol, signal.side);
    const episodeKey = [...this.episodes.entries()].find(([, episode]) =>
      episode.signalIds.has(signal.shadowSignalId),
    )?.[0];
    if (!episodeKey) return;

    const pending = createPendingOutcome(signal, episodeKey);
    pending.entryModels = computeEntryModels(signal, []);
    this.pending.set(signal.shadowSignalId, pending);
    if (this.deps.storage) {
      const signalStored = this.deps.storage.persistSignal({
        ...signal,
        episodeId: episodeKey,
      } as unknown as {
        shadowSignalId: string;
        symbol: string;
        signalAtMs: number;
        [key: string]: unknown;
      });
      const pendingStored = this.deps.storage.persistPendingState(
        signal.shadowSignalId,
        'PENDING',
        {
          shadowSignalId: signal.shadowSignalId,
          signalAtMs: signal.signalAtMs,
          symbol: signal.symbol,
          side: signal.side,
          requiredUntilMs: signal.signalAtMs + 300_000,
        },
      );
      if (!signalStored || !pendingStored) this.outcomeErrors++;
    }

    // Memory safety: evict oldest if over limit
    this.evictIfNeeded();
  }

  private rebuildEpisodes(symbol: string, side: string): void {
    const signals = [...this.knownSignals.values()]
      .filter((candidate) => candidate.symbol === symbol && candidate.side === side)
      .sort(
        (a, b) => a.signalAtMs - b.signalAtMs || a.shadowSignalId.localeCompare(b.shadowSignalId),
      );
    const rebuilt = new Map<string, any>();
    for (const cohortSignals of groupSignalsByCohort(signals).values()) {
      let component: ShadowSignalSnapshot[] = [];
      let componentEnd = -Infinity;
      const flush = () => {
        if (component.length === 0) return;
        const startedAtMs = component[0].signalAtMs;
        const primarySignalId = component[0].shadowSignalId;
        const cohortId = component[0].cohortId;
        const episodeId = createMicroBurstEpisodeId(symbol, side, startedAtMs, cohortId ?? '');
        const episode = {
          signalIds: new Set(component.map((candidate) => candidate.shadowSignalId)),
          primarySignalId,
          symbol,
          side,
          cohortId: cohortId ?? null,
          startedAtMs,
          endedAtMs: Math.max(...component.map((candidate) => candidate.signalAtMs + 300_000)),
        };
        rebuilt.set(episodeId, episode as any);
        this.deps.storage?.persistEpisode({
          episodeId,
          ...episode,
          cohortId: episode.cohortId ?? undefined,
          signalIds: [...episode.signalIds],
        });
        component = [];
        componentEnd = -Infinity;
      };
      for (const candidate of cohortSignals) {
        if (candidate.signalAtMs > componentEnd) flush();
        component.push(candidate);
        componentEnd = Math.max(componentEnd, candidate.signalAtMs + 300_000);
      }
      flush();
    }
    for (const oldId of this.episodes.keys()) {
      if (oldId.startsWith('MBV1-EP-') && !rebuilt.has(oldId)) this.episodes.delete(oldId);
    }
    for (const [episodeId, episode] of rebuilt) this.episodes.set(episodeId, episode as any);
    for (const candidate of signals) {
      const episodeId = [...rebuilt.entries()].find(([, episode]) =>
        episode.signalIds.has(candidate.shadowSignalId),
      )?.[0];
      if (episodeId) {
        this.deps.storage?.assignSignalEpisode(candidate.shadowSignalId, episodeId);
        this.deps.storage?.assignOutcomeEpisode(candidate.shadowSignalId, episodeId);
        const pending = this.pending.get(candidate.shadowSignalId);
        if (pending) pending.episodeId = episodeId;
      }
    }
  }

  /** Process a trade event. Routes to the correct pending outcome by symbol. */
  processTradeEvent(event: {
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
  }): void {
    this.ingestLiveTradeEvent(event);
  }

  /** Observe a runtime-archived trade without appending it to storage again. */
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
  }): void {
    this.observeTradeEventInternal(event, false);
  }

  /** Live WS ingestion: archive once, then evaluate only the in-memory observation. */
  ingestLiveTradeEvent(event: {
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
  }): void {
    this.observeTradeEventInternal(event, true);
  }

  /** Archive replay never feeds records back into the archival queue. */
  replayTradeEvent(event: {
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
  }): void {
    this.observeTradeEventInternal(event, false);
  }

  private observeTradeEventInternal(
    event: {
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
    },
    archive: boolean,
  ): void {
    if (!Number.isFinite(event.price) || event.price <= 0) return;

    this.tradeHistory.append(event.symbol, {
      ...event,
      receivedAtMs: event.receivedAtMs ?? event.eventTime,
      quantity: event.quantity ?? 0,
      isBuyerMaker: event.isBuyerMaker ?? false,
    });
    this.eventWatermarks.set(
      event.symbol,
      Math.max(this.eventWatermarks.get(event.symbol) ?? -Infinity, event.eventTime),
    );
    if (
      archive &&
      this.deps.storage &&
      !this.deps.storage.appendTrade({
        ...event,
        receivedAtMs: event.receivedAtMs ?? event.eventTime,
      })
    ) {
      this.outcomeErrors++;
    }
    this.tradeHistory.prune(this.eventWatermarks.get(event.symbol) ?? event.eventTime);
    for (const [id, pending] of this.pending) {
      if (pending.signal.symbol !== event.symbol || event.eventTime <= pending.signal.signalAtMs)
        continue;
      const watermark = this.eventWatermarks.get(pending.signal.symbol) ?? event.eventTime;
      pending.priceHistory = [
        ...this.tradeHistory.query(pending.signal.symbol, pending.signal.signalAtMs, watermark),
      ];

      // Update peak/trough
      if (event.price > pending.peakPrice) pending.peakPrice = event.price;
      if (event.price < pending.troughPrice) pending.troughPrice = event.price;

      // Resolve NEXT_TRADE entry model
      if (!pending.nextTradeResolved) {
        const nextTrade = pending.priceHistory.find(
          (t) => t.eventTime > pending.signal.signalAtMs && t.price > 0,
        );
        if (nextTrade) {
          pending.entryModels = computeEntryModels(pending.signal, pending.priceHistory);
          pending.nextTradeResolved = true;
        }
      }

      // Check horizon completions
      this.checkHorizonCompletions(id, pending);
      if (pending.pendingHorizons.size === 0) this.completeOutcome(id, pending);
    }
  }

  /** Force-check all pending outcomes (e.g., during health reporting or shutdown). */
  flushPending(currentTimeMs: number): void {
    for (const [id, pending] of this.pending) {
      this.checkHorizonCompletions(id, pending, currentTimeMs);
    }
    // Complete any remaining that have passed all horizons
    for (const [id, pending] of this.pending) {
      if (pending.pendingHorizons.size === 0) {
        this.completeOutcome(id, pending);
      }
    }
  }

  /** Get health metrics. */
  getHealth(): OutcomeTrackerHealth {
    const meanMfeBps = this.completedOutcomes > 0 ? this.totalMfeBps / this.completedOutcomes : 0;
    const meanMaeBps = this.completedOutcomes > 0 ? this.totalMaeBps / this.completedOutcomes : 0;
    return {
      signalsObserved: this.signalsObserved,
      pendingOutcomes: this.pending.size,
      completedOutcomes: this.completedOutcomes,
      outcomeErrors: this.outcomeErrors,
      targetFirst: this.targetFirst,
      stopFirst: this.stopFirst,
      neither: this.neither,
      ambiguous: this.ambiguous,
      meanMfeBps,
      meanMaeBps,
      journalHealthy: this.deps.journal.getHealth().journalHealthy,
      malformedJournalCount: this.deps.journal.getHealth().malformedCount,
      malformedJournalFile: this.deps.journal.getHealth().malformedFile,
      malformedJournalLine: this.deps.journal.getHealth().malformedLine,
      malformedJournalReason: this.deps.journal.getHealth().malformedReason,
    };
  }

  /** Get pending signal IDs (for restart recovery). */
  getPendingIds(): string[] {
    return Array.from(this.pending.keys());
  }

  private checkHorizonCompletions(id: string, pending: PendingOutcome, forceTime?: number): void {
    const t0 = pending.signal.signalAtMs;

    for (const horizonMs of pending.pendingHorizons) {
      const horizonEnd = t0 + horizonMs;
      const watermark =
        this.eventWatermarks.get(pending.signal.symbol) ??
        this.deps.storage?.archiveWatermark(pending.signal.symbol) ??
        -Infinity;
      // Market-event watermark, not local wall time, proves a causal horizon is observable.
      if (watermark < horizonEnd) continue;
      if (
        this.deps.storage?.hasGapForFeed(
          pending.signal.symbol,
          t0,
          horizonEnd,
          MICRO_BURST_OUTCOME_FEED_DEPENDENCIES.SIGNAL_PRICE[0],
        )
      ) {
        this.deps.storage.persistPendingState(id, 'INCOMPLETE_DATA_GAP', {
          shadowSignalId: id,
          requiredUntilMs: t0 + 300_000,
          recoveryStatus: 'INCOMPLETE_DATA_GAP',
        });
        this.pending.delete(id);
        continue;
      }

      // Compute outcome for SIGNAL_PRICE model (primary)
      const signalPriceModel = pending.entryModels.find((m) => m.model === 'SIGNAL_PRICE');
      if (!signalPriceModel?.available || signalPriceModel.entryPrice === null) continue;

      try {
        const outcome = computeHorizonOutcome(
          pending.signal,
          signalPriceModel.entryPrice,
          pending.priceHistory,
          horizonMs,
        );
        pending.completedHorizons.set(horizonMs, outcome);
        pending.pendingHorizons.delete(horizonMs);
      } catch {
        this.outcomeErrors++;
      }
    }
  }

  private completeOutcome(id: string, pending: PendingOutcome): void {
    let completed = false;
    try {
      const history = [
        ...this.tradeHistory.query(
          pending.signal.symbol,
          pending.signal.signalAtMs,
          pending.signal.signalAtMs + 300_000,
        ),
      ];
      const signalPriceModel = pending.entryModels.find((m) => m.model === 'SIGNAL_PRICE');
      const entryPrice = signalPriceModel?.entryPrice ?? pending.signal.marketPriceAtSignal;

      const computedHorizons = computeAllHorizons(pending.signal, entryPrice, history);
      // A completed horizon is frozen at maturity; never replace it with a later query.
      const horizons: Record<
        number,
        import('../../domain/strategies/micro-burst/MicroBurstOutcomeTypes').HorizonOutcome
      > = {
        ...computedHorizons,
        ...Object.fromEntries(pending.completedHorizons),
      };
      const barrierOutcome = aggregateBarrierOutcome(horizons);
      const dynamicExit = simulateDynamicExit(pending.signal, entryPrice, history, this.exitConfig);

      const grossBps = sideAwareReturnBps(
        entryPrice,
        history.length > 0 ? history[history.length - 1].price : entryPrice,
        pending.signal.side,
      );

      const costScenarios = computeCostScenarios(grossBps, [
        { label: 'cost_0', feeBps: 0, slippageBps: 0 },
        { label: 'cost_10', feeBps: 7, slippageBps: 3 },
        { label: 'cost_14', feeBps: 10, slippageBps: 4 },
        { label: 'cost_20', feeBps: 14, slippageBps: 6 },
        { label: 'cost_30', feeBps: 20, slippageBps: 10 },
      ]);

      const record: ProspectiveOutcomeRecord = {
        schemaVersion: 1,
        shadowSignalId: pending.signal.shadowSignalId,
        cohortId: pending.signal.cohortId,
        episodeId: pending.episodeId,
        symbol: pending.signal.symbol,
        side: pending.signal.side,
        signalAtMs: pending.signal.signalAtMs,
        entryPriceModels: pending.entryModels,
        entryOutcomes: computeEntryModelOutcomes(
          pending.signal,
          history,
          undefined,
          this.exitConfig,
        ),
        structuralStopPrice: pending.signal.structuralStopPrice,
        destinationPrice: pending.signal.destinationPrice,
        support: pending.signal.support,
        resistance: pending.signal.resistance,
        roomToTargetBps: pending.signal.roomToTargetBps,
        riskToInvalidationBps: pending.signal.riskToInvalidationBps,
        rewardRisk: pending.signal.rewardRisk,
        confidence: pending.signal.confidence,
        leverageTier: pending.signal.leverageTier,
        leverage: pending.signal.leverage,
        microRegime: pending.signal.microRegime,
        momentum: pending.signal.momentum,
        book: pending.signal.book,
        tradeFlow: pending.signal.tradeFlow,
        btc: pending.signal.btc,
        horizons,
        barrierOutcome,
        dynamicExitOutcome: dynamicExit,
        grossBps,
        costScenarios,
        costComponents: computeCostComponents(grossBps, [
          { label: 'cost_0', feeBps: 0, slippageBps: 0 },
          { label: 'cost_10', feeBps: 7, slippageBps: 3 },
          { label: 'cost_14', feeBps: 10, slippageBps: 4 },
          { label: 'cost_20', feeBps: 14, slippageBps: 6 },
          { label: 'cost_30', feeBps: 20, slippageBps: 10 },
        ]),
        completedAtMs: this.deps.clock.now(),
        strategyVersion: pending.signal.strategyVersion,
        codeCommitSha: pending.signal.codeCommitSha,
        configHash: pending.signal.configHash,
      };

      // SQLite is authoritative. JSONL is a derived export and a failed export is recorded explicitly.
      if (
        this.deps.storage &&
        !this.deps.storage.completeOutcome(
          record as unknown as {
            shadowSignalId: string;
            symbol: string;
            completedAtMs: number;
            [key: string]: unknown;
          },
        )
      ) {
        this.outcomeErrors++;
        return;
      }
      const journaled = this.deps.journal.append(record);
      if (this.deps.storage && journaled) this.deps.storage.markOutcomeJournaled(id);
      if (!journaled) this.outcomeErrors++;

      // Update metrics
      this.completedOutcomes++;
      this.completedIds.add(id);
      if (barrierOutcome === 'TARGET_FIRST') this.targetFirst++;
      else if (barrierOutcome === 'STOP_FIRST') this.stopFirst++;
      else if (barrierOutcome === 'AMBIGUOUS_SAME_INTERVAL') this.ambiguous++;
      else this.neither++;

      const maxHorizon = Math.max(...Object.keys(horizons).map(Number));
      const maxHorizonOutcome = horizons[maxHorizon];
      if (maxHorizonOutcome) {
        this.totalMfeBps += maxHorizonOutcome.mfeBps;
        this.totalMaeBps += maxHorizonOutcome.maeBps;
      }
      completed = true;

      this.deps.logger.info('micro_burst_outcome_completed', {
        shadowSignalId: id,
        symbol: pending.signal.symbol,
        side: pending.signal.side,
        barrierOutcome,
        grossBps,
        horizons: Object.keys(horizons).length,
      });
    } catch (err) {
      this.outcomeErrors++;
      this.deps.logger.error('micro_burst_outcome_completion_error', {
        shadowSignalId: id,
        error: String(err),
      });
    } finally {
      if (completed) this.pending.delete(id);
    }
  }

  /** Restore durable pending snapshots and replay only archived exchange-time trades. */
  recoverPending(): void {
    if (!this.deps.storage) return;
    const reconciliation = this.deps.storage.loadOutcomeReconciliation();
    const unresolved = new Set(reconciliation.unresolvedOutcomeIds);
    for (const outcome of reconciliation.outcomes) {
      if (!unresolved.has(outcome.shadowSignalId)) continue;
      if (this.deps.journal.append(outcome))
        this.deps.storage.markOutcomeJournaled(outcome.shadowSignalId);
      else this.outcomeErrors++;
    }
    for (const recovered of this.deps.storage.recoverPending()) {
      const signal = recovered.snapshot as ShadowSignalSnapshot;
      if (
        !signal ||
        typeof signal.shadowSignalId !== 'string' ||
        this.pending.has(signal.shadowSignalId)
      )
        continue;
      const requiredUntilMs = signal.signalAtMs + 300_000;
      const history = this.deps.storage.queryArchivedTrades(
        signal.symbol,
        signal.signalAtMs,
        Math.min(requiredUntilMs, this.deps.clock.now()),
      );
      const watermark = this.deps.storage.archiveWatermark(signal.symbol);
      if (
        this.deps.clock.now() >= requiredUntilMs &&
        (watermark === null ||
          watermark < requiredUntilMs ||
          this.deps.storage.hasGapForFeed(
            signal.symbol,
            signal.signalAtMs,
            requiredUntilMs,
            MICRO_BURST_OUTCOME_FEED_DEPENDENCIES.SIGNAL_PRICE[0],
          ))
      ) {
        this.deps.storage.persistPendingState(signal.shadowSignalId, 'INCOMPLETE_DATA_GAP', {
          shadowSignalId: signal.shadowSignalId,
          recoveredAtMs: this.deps.clock.now(),
          requiredUntilMs,
          recoveryStatus: 'INCOMPLETE_DATA_GAP',
        });
        this.outcomeErrors++;
        continue;
      }
      this.trackSignal(signal);
      for (const trade of history)
        this.replayTradeEvent({ symbol: signal.symbol, ...(trade as any) });
      this.deps.storage.persistPendingState(signal.shadowSignalId, 'RECOVERED', {
        shadowSignalId: signal.shadowSignalId,
        recoveredAtMs: this.deps.clock.now(),
        requiredUntilMs,
        recoveryStatus: 'RECOVERED',
      });
    }
  }

  private evictIfNeeded(): void {
    while (this.pending.size > this.maxPending) {
      // Evict the oldest pending outcome (earliest createdAtMs)
      let oldestId: string | null = null;
      let oldestTime = Infinity;
      for (const [id, pending] of this.pending) {
        if (pending.createdAtMs < oldestTime) {
          oldestTime = pending.createdAtMs;
          oldestId = id;
        }
      }
      if (oldestId) {
        this.deps.logger.warn('micro_burst_outcome_evicted', { shadowSignalId: oldestId });
        const evicted = this.pending.get(oldestId)!;
        if (
          this.deps.storage &&
          !this.deps.storage.persistPendingState(oldestId, 'EVICTED_CAPACITY', {
            shadowSignalId: oldestId,
            requiredUntilMs: evicted.signal.signalAtMs + 300_000,
            recoveryStatus: 'EVICTED_CAPACITY',
            evictedAtMs: this.deps.clock.now(),
            reason: 'max_pending_outcomes',
          })
        )
          this.outcomeErrors++;
        this.pending.delete(oldestId);
      } else {
        break;
      }
    }
  }
}

function groupSignalsByCohort(
  signals: readonly ShadowSignalSnapshot[],
): Map<string, ShadowSignalSnapshot[]> {
  const groups = new Map<string, ShadowSignalSnapshot[]>();
  for (const signal of signals) {
    const key = signal.cohortId ?? '';
    groups.set(key, [...(groups.get(key) ?? []), signal]);
  }
  return groups;
}

function isSignalSnapshot(value: unknown): value is ShadowSignalSnapshot {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.shadowSignalId === 'string' &&
    typeof candidate.symbol === 'string' &&
    (candidate.side === 'LONG' || candidate.side === 'SHORT') &&
    Number.isFinite(candidate.signalAtMs)
  );
}
