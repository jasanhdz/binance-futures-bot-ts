import { StrategyId } from '../strategy/StrategyIdentity';

export interface StrategyRiskSnapshot {
  strategyId: StrategyId;
  dayKey: number;
  tradesToday: number;
  consecutiveLosses: number;
  lastEntryAt?: number;
  lastExitAt?: number;
  lastLossAt?: number;
}

export interface StrategyClosedOutcome {
  tradeId: string;
  closedAt: string;
  pnlUsdt: number;
}

interface MutableStrategyRiskState {
  dayKey: number;
  tradesToday: number;
  consecutiveLosses: number;
  lastEntryAt?: number;
  lastExitAt?: number;
  lastLossAt?: number;
  processedTradeIds: Set<string>;
}

/**
 * Runtime risk accounting owned by strategy rather than by the whole bot.
 * Account-wide kill switches remain outside this ledger.
 */
export class StrategyRiskLedger {
  private readonly states = new Map<StrategyId, MutableStrategyRiskState>();

  snapshot(strategyId: StrategyId, now = Date.now()): StrategyRiskSnapshot {
    const state = this.state(strategyId, now);
    return {
      strategyId,
      dayKey: state.dayKey,
      tradesToday: state.tradesToday,
      consecutiveLosses: state.consecutiveLosses,
      lastEntryAt: state.lastEntryAt,
      lastExitAt: state.lastExitAt,
      lastLossAt: state.lastLossAt,
    };
  }

  recordOpen(strategyId: StrategyId, openedAt = Date.now()): StrategyRiskSnapshot {
    const state = this.state(strategyId, openedAt);
    state.tradesToday += 1;
    state.lastEntryAt = openedAt;
    return this.snapshot(strategyId, openedAt);
  }

  recordClose(
    strategyId: StrategyId,
    tradeId: string,
    pnlUsdt: number,
    closedAt = Date.now(),
  ): StrategyRiskSnapshot {
    const state = this.state(strategyId, closedAt);
    if (!tradeId || !Number.isFinite(pnlUsdt) || state.processedTradeIds.has(tradeId)) {
      return this.snapshot(strategyId, closedAt);
    }

    state.processedTradeIds.add(tradeId);
    state.lastExitAt = closedAt;
    if (pnlUsdt < 0) {
      state.consecutiveLosses += 1;
      state.lastLossAt = closedAt;
    } else {
      state.consecutiveLosses = 0;
    }
    return this.snapshot(strategyId, closedAt);
  }

  restoreClosedOutcomes(outcomes: StrategyClosedOutcome[], now = Date.now()): void {
    this.states.clear();
    const ordered = [...outcomes].sort((left, right) => {
      const delta = Date.parse(left.closedAt) - Date.parse(right.closedAt);
      return delta !== 0 ? delta : left.tradeId.localeCompare(right.tradeId);
    });

    for (const outcome of ordered) {
      const strategyId = strategyIdFromTradeId(outcome.tradeId);
      if (!strategyId) continue;
      const closedAt = Date.parse(outcome.closedAt);
      if (!Number.isFinite(closedAt)) continue;
      const state = this.state(strategyId, closedAt);
      state.processedTradeIds.add(outcome.tradeId);
      state.lastExitAt = closedAt;
      if (outcome.pnlUsdt < 0) {
        state.consecutiveLosses += 1;
        state.lastLossAt = closedAt;
      } else {
        state.consecutiveLosses = 0;
      }
    }

    // Ensure today's day bucket is active without destroying recovered streaks.
    for (const strategyId of this.states.keys()) {
      this.state(strategyId, now);
    }
  }

  resetDaily(now = Date.now()): void {
    for (const state of this.states.values()) {
      const nextDayKey = dayKey(now);
      if (state.dayKey !== nextDayKey) {
        state.dayKey = nextDayKey;
        state.tradesToday = 0;
      }
    }
  }

  timeSinceLastExitMs(strategyId: StrategyId, now = Date.now()): number {
    const lastExitAt = this.state(strategyId, now).lastExitAt;
    return lastExitAt === undefined ? Number.POSITIVE_INFINITY : Math.max(0, now - lastExitAt);
  }

  timeSinceLastLossMs(strategyId: StrategyId, now = Date.now()): number {
    const lastLossAt = this.state(strategyId, now).lastLossAt;
    return lastLossAt === undefined ? Number.POSITIVE_INFINITY : Math.max(0, now - lastLossAt);
  }

  private state(strategyId: StrategyId, now: number): MutableStrategyRiskState {
    const currentDay = dayKey(now);
    let state = this.states.get(strategyId);
    if (!state) {
      state = {
        dayKey: currentDay,
        tradesToday: 0,
        consecutiveLosses: 0,
        processedTradeIds: new Set<string>(),
      };
      this.states.set(strategyId, state);
      return state;
    }

    if (state.dayKey !== currentDay) {
      state.dayKey = currentDay;
      state.tradesToday = 0;
    }
    return state;
  }
}

export function strategyIdFromTradeId(tradeId: string): StrategyId | undefined {
  if (tradeId.startsWith('MOMENTUM-RIDE-')) return 'MOMENTUM_RIDE';
  if (tradeId.startsWith('AEGIS-TURBO-')) return 'AEGIS_TURBO';
  if (tradeId.startsWith('MICRO-BURST-V1-')) return 'MICRO_BURST_V1';
  return undefined;
}

function dayKey(timestamp: number): number {
  return Math.floor(timestamp / 86_400_000);
}
