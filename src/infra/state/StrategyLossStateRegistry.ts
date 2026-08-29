import type { ClosedTradeOutcome } from '../../domain/services/ConsecutiveLossTracker';
import { ConsecutiveLossTracker } from '../../domain/services/ConsecutiveLossTracker';
import {
  STRATEGY_LOSS_STATE_SCHEMA,
  StrategyLossStateStore,
  type StrategyLossState,
  type StrategyLossStateStorePort,
} from './StrategyLossStateStore';

export interface StrategyLossStateRegistryOptions {
  legacyAegisFilePath?: string;
}

/**
 * Generic strategy loss registry. It can track any current or future strategy id,
 * including observational/manual buckets, without adding strategy-specific classes.
 */
export class StrategyLossStateRegistry {
  private readonly stores = new Map<string, StrategyLossStateStorePort>();
  private readonly trackers = new Map<string, ConsecutiveLossTracker>();

  constructor(private readonly options: StrategyLossStateRegistryOptions = {}) {}

  storeFor(strategyId: string): StrategyLossStateStorePort {
    const id = normalizeStrategyId(strategyId);
    const existing = this.stores.get(id);
    if (existing) return existing;
    const store = new StrategyLossStateStore({
      strategyId: id,
      legacy:
        id === 'AEGIS_TURBO' && this.options.legacyAegisFilePath
          ? {
              filePath: this.options.legacyAegisFilePath,
              schemaId: 'aegis-consecutive-loss-state-v1',
            }
          : undefined,
    });
    this.stores.set(id, store);
    return store;
  }

  async restore(strategyId: string, mode: string): Promise<StrategyLossState | null> {
    const id = normalizeStrategyId(strategyId);
    const state = await this.storeFor(id).read(mode);
    const tracker = this.trackerFor(id);
    tracker.restorePersistedValue(state?.consecutive_losses ?? 0);
    return state;
  }

  async record(
    strategyId: string,
    mode: string,
    outcome: ClosedTradeOutcome,
  ): Promise<StrategyLossState> {
    const id = normalizeStrategyId(strategyId);
    const store = this.storeFor(id);
    const previousState = await store.read(mode);
    const tracker = this.trackerFor(id);
    if (tracker.processedCount === 0 && previousState) {
      tracker.restorePersistedValue(previousState.consecutive_losses);
    }
    const update = tracker.record(outcome.tradeId, outcome.pnlUsdt);
    if (!update.applied && previousState) return previousState;

    const isLoss = outcome.pnlUsdt < 0;
    const isWin = outcome.pnlUsdt > 0;
    const now = outcome.closedAt;
    const state: StrategyLossState = {
      schema_id: STRATEGY_LOSS_STATE_SCHEMA,
      strategy_id: id,
      mode,
      consecutive_losses: tracker.value,
      total_losses: (previousState?.total_losses ?? 0) + (isLoss ? 1 : 0),
      total_wins: (previousState?.total_wins ?? 0) + (isWin ? 1 : 0),
      last_result: isLoss ? 'LOSS' : isWin ? 'WIN' : 'BREAKEVEN',
      updated_at: now,
      last_trade_id: outcome.tradeId,
      reset_authority: isLoss
        ? (previousState?.reset_authority ?? 'STRATEGY_LOSS_TRACKER')
        : 'NON_LOSS_OUTCOME_RESET',
      reset_at: isLoss ? (previousState?.reset_at ?? now) : now,
    };
    await store.write(state);
    return state;
  }

  trackerValue(strategyId: string): number {
    return this.trackerFor(normalizeStrategyId(strategyId)).value;
  }

  private trackerFor(strategyId: string): ConsecutiveLossTracker {
    const existing = this.trackers.get(strategyId);
    if (existing) return existing;
    const tracker = new ConsecutiveLossTracker();
    this.trackers.set(strategyId, tracker);
    return tracker;
  }
}

function normalizeStrategyId(strategyId: string): string {
  const value = String(strategyId ?? '')
    .trim()
    .toUpperCase();
  if (!value) throw new Error('STRATEGY_ID_REQUIRED');
  return value;
}
