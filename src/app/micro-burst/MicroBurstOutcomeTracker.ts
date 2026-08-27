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
  simulateDynamicExit,
  createPendingOutcome,
  sideAwareReturnBps,
  computeHorizonOutcome,
  OUTCOME_HORIZONS_MS,
} from '../../domain/strategies/micro-burst/MicroBurstOutcomeEngine';
import { MicroBurstConfig, defaultMicroBurstConfig } from '../../domain/strategies/micro-burst/MicroBurstTypes';
import { MicroBurstOutcomeJournal } from './MicroBurstOutcomeJournal';

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
  /** Maximum price history events retained per pending outcome. */
  maxPriceHistoryPerSignal?: number;
}

const DEFAULT_MAX_PENDING = 500;
const DEFAULT_MAX_PRICE_HISTORY = 2000;

export class MicroBurstOutcomeTracker {
  private readonly pending = new Map<string, PendingOutcome>();
  private readonly completedIds = new Set<string>();
  private readonly episodes = new Map<string, { signalIds: Set<string>; primarySignalId: string }>();

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
  private readonly maxPriceHistory: number;
  private readonly exitConfig: MicroBurstConfig;

  constructor(private readonly deps: OutcomeTrackerDeps) {
    this.maxPending = deps.maxPendingOutcomes ?? DEFAULT_MAX_PENDING;
    this.maxPriceHistory = deps.maxPriceHistoryPerSignal ?? DEFAULT_MAX_PRICE_HISTORY;
    this.exitConfig = deps.config ?? defaultMicroBurstConfig();
  }

  /** Register a new signal snapshot for prospective tracking. */
  trackSignal(signal: ShadowSignalSnapshot): void {
    this.signalsObserved++;

    // Idempotency: skip if already tracked or completed
    if (this.pending.has(signal.shadowSignalId) || this.completedIds.has(signal.shadowSignalId)) {
      return;
    }

    // Episode management
    const episodeKey = `${signal.symbol}:${signal.side}:${Math.round(signal.structuralStopPrice * 100)}`;
    let episode = this.episodes.get(episodeKey);
    if (!episode) {
      episode = { signalIds: new Set(), primarySignalId: signal.shadowSignalId };
      this.episodes.set(episodeKey, episode);
    }
    episode.signalIds.add(signal.shadowSignalId);

    const pending = createPendingOutcome(signal, episodeKey);
    pending.entryModels = computeEntryModels(signal, []);
    this.pending.set(signal.shadowSignalId, pending);

    // Memory safety: evict oldest if over limit
    this.evictIfNeeded();
  }

  /** Process a trade event. Routes to the correct pending outcome by symbol. */
  processTradeEvent(event: { eventTime: number; price: number; symbol: string }): void {
    if (!Number.isFinite(event.price) || event.price <= 0) return;

    for (const [id, pending] of this.pending) {
      if (pending.signal.symbol !== event.symbol) continue;
      if (event.eventTime <= pending.signal.signalAtMs) continue;

      pending.priceHistory.push({ eventTime: event.eventTime, price: event.price });

      // Ring buffer: trim if over limit
      if (pending.priceHistory.length > this.maxPriceHistory) {
        pending.priceHistory = pending.priceHistory.slice(-this.maxPriceHistory);
      }

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
    };
  }

  /** Get pending signal IDs (for restart recovery). */
  getPendingIds(): string[] {
    return Array.from(this.pending.keys());
  }

  private checkHorizonCompletions(id: string, pending: PendingOutcome, forceTime?: number): void {
    const now = forceTime ?? this.deps.clock.now();
    const t0 = pending.signal.signalAtMs;

    for (const horizonMs of pending.pendingHorizons) {
      const horizonEnd = t0 + horizonMs;
      if (now < horizonEnd) continue;

      // Compute outcome for SIGNAL_PRICE model (primary)
      const signalPriceModel = pending.entryModels.find((m) => m.model === 'SIGNAL_PRICE');
      if (!signalPriceModel) continue;

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
    try {
      const signalPriceModel = pending.entryModels.find((m) => m.model === 'SIGNAL_PRICE');
      const entryPrice = signalPriceModel?.entryPrice ?? pending.signal.marketPriceAtSignal;

      const horizons = computeAllHorizons(pending.signal, entryPrice, pending.priceHistory);
      const barrierOutcome = aggregateBarrierOutcome(horizons);
      const dynamicExit = simulateDynamicExit(pending.signal, entryPrice, pending.priceHistory, this.exitConfig);

      const grossBps = sideAwareReturnBps(
        entryPrice,
        pending.priceHistory.length > 0
          ? pending.priceHistory[pending.priceHistory.length - 1].price
          : entryPrice,
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
        shadowSignalId: pending.signal.shadowSignalId,
        episodeId: pending.episodeId,
        symbol: pending.signal.symbol,
        side: pending.signal.side,
        signalAtMs: pending.signal.signalAtMs,
        entryPriceModels: pending.entryModels,
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
        completedAtMs: this.deps.clock.now(),
        strategyVersion: pending.signal.strategyVersion,
        codeCommitSha: pending.signal.codeCommitSha,
        configHash: pending.signal.configHash,
      };

      this.deps.journal.append(record);

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
      this.pending.delete(id);
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
        this.pending.delete(oldestId);
      } else {
        break;
      }
    }
  }
}
