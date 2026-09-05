export interface TradeOutcome {
  tradeId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  strategyId: string;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  grossPnl: number;
  commissions: number;
  funding: number;
  netPnl: number;
  closedAtMs: number;
  /** Whether netPnl has been verified with exchange fills. */
  verified: boolean;
}

export interface DailyRiskState {
  dayKey: string;
  tradesToday: number;
  strategyTradesToday: Record<string, number>;
  consecutiveLosses: number;
  dailyPnl: number;
  peakDailyPnl: number;
  closedTradeIds: string[];
  /** Idempotency keys that have been applied, for persistence across restarts. */
  appliedKeys: string[];
  /** Per-day PnL attribution for late closes. Key is dayKey, value is cumulative netPnl. */
  historicalPnl: Record<string, number>;
}

export interface RiskLedgerEntry {
  tradeId: string;
  event: 'TRADE_CLOSED' | 'RISK_APPLIED';
  dayKey: string;
  timestampMs: number;
  /** Prevent double-application of the same close event. */
  idempotencyKey: string;
}

/**
 * Idempotent risk ledger for daily risk tracking.
 * Ensures streaks/limits are updated exactly once per trade close,
 * even across restarts.
 */
export class RiskLedger {
  private readonly applied = new Set<string>();
  private state: DailyRiskState;

  constructor(initial?: Partial<DailyRiskState>) {
    this.state = {
      dayKey: initial?.dayKey ?? currentDayKey(),
      tradesToday: initial?.tradesToday ?? 0,
      strategyTradesToday: initial?.strategyTradesToday ?? {},
      consecutiveLosses: initial?.consecutiveLosses ?? 0,
      dailyPnl: initial?.dailyPnl ?? 0,
      peakDailyPnl: initial?.peakDailyPnl ?? 0,
      closedTradeIds: initial?.closedTradeIds ?? [],
      appliedKeys: initial?.appliedKeys ?? [],
      historicalPnl: initial?.historicalPnl ?? {},
    };
    // Restore applied set from persisted keys.
    for (const key of this.state.appliedKeys) {
      this.applied.add(key);
    }
  }

  getState(): DailyRiskState {
    return {
      ...this.state,
      closedTradeIds: [...this.state.closedTradeIds],
      appliedKeys: [...this.applied],
    };
  }

  /**
   * Apply a trade close event idempotently.
   * Only verified outcomes are applied; unverified outcomes are rejected.
   * Late closes (from a previous day) are attributed to their own day
   * without resetting current day counters. Returns true if this is the
   * first application, false if already applied or rejected.
   */
  applyTradeClose(outcome: TradeOutcome): boolean {
    // Reject unverified outcomes: do not pollute risk state.
    if (!outcome.verified) return false;

    const idempotencyKey = `close:${outcome.tradeId}:${outcome.closedAtMs}`;
    if (this.applied.has(idempotencyKey)) return false;

    const tradeDay = dayKeyFromDate(outcome.closedAtMs);

    // Day rollover: only roll forward, never backward.
    if (tradeDay > this.state.dayKey) {
      this.resetDay(tradeDay);
    }

    this.applied.add(idempotencyKey);

    // Late closes from previous days: apply PnL but do NOT reset counters.
    // The trade belongs to the past day; only the PnL impact carries forward.
    const isLateClose = tradeDay < this.state.dayKey;

    if (!isLateClose) {
      // Same day: update all counters normally.
      this.state.dailyPnl += outcome.netPnl;
      if (this.state.dailyPnl > this.state.peakDailyPnl) {
        this.state.peakDailyPnl = this.state.dailyPnl;
      }
      if (outcome.netPnl < 0) {
        this.state.consecutiveLosses += 1;
      } else {
        this.state.consecutiveLosses = 0;
      }
      this.state.tradesToday += 1;
      this.state.strategyTradesToday[outcome.strategyId] =
        (this.state.strategyTradesToday[outcome.strategyId] ?? 0) + 1;
    } else {
      // Late close: belongs to a past day. Do NOT modify any current-day
      // counters (dailyPnl, peakDailyPnl, tradesToday, consecutiveLosses,
      // strategyTradesToday). Record the PnL in historicalPnl keyed by
      // the trade's own day for economic attribution.
      this.state.historicalPnl[tradeDay] =
        (this.state.historicalPnl[tradeDay] ?? 0) + outcome.netPnl;
    }

    // Track closed trade (always, regardless of timeliness).
    this.state.closedTradeIds.push(outcome.tradeId);

    return true;
  }

  /**
   * Check if a trade close has already been applied.
   */
  isApplied(tradeId: string, closedAtMs: number): boolean {
    return this.applied.has(`close:${tradeId}:${closedAtMs}`);
  }

  /**
   * Get all applied idempotency keys for persistence.
   */
  getAppliedKeys(): string[] {
    return [...this.applied];
  }

  /**
   * Get the cumulative PnL attributed to a specific day (for late closes).
   * Returns 0 if no late closes have been recorded for that day.
   */
  getHistoricalPnl(dayKey: string): number {
    return this.state.historicalPnl[dayKey] ?? 0;
  }

  /**
   * Reconstruct applied set from persisted state (for restart recovery).
   * This is now handled automatically by the constructor from appliedKeys.
   * This method is kept for backward compatibility.
   */
  restoreApplied(idempotencyKeys: string[]): void {
    for (const key of idempotencyKeys) {
      this.applied.add(key);
    }
  }

  private resetDay(newDayKey: string): void {
    this.state.dayKey = newDayKey;
    this.state.tradesToday = 0;
    this.state.strategyTradesToday = {};
    this.state.dailyPnl = 0;
    this.state.peakDailyPnl = 0;
    this.state.closedTradeIds = [];
  }
}

function currentDayKey(): string {
  return dayKeyFromDate(Date.now());
}

function dayKeyFromDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
