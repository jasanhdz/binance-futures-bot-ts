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
   * Returns true if this is the first application, false if already applied or rejected.
   */
  applyTradeClose(outcome: TradeOutcome): boolean {
    // Reject unverified outcomes: do not pollute risk state.
    if (!outcome.verified) return false;

    const idempotencyKey = `close:${outcome.tradeId}:${outcome.closedAtMs}`;
    if (this.applied.has(idempotencyKey)) return false;

    // Day rollover check: only roll forward, never backward.
    // A late close from a previous day does NOT reset today's counters.
    const tradeDay = dayKeyFromDate(outcome.closedAtMs);
    if (tradeDay > this.state.dayKey) {
      this.resetDay(tradeDay);
    }

    this.applied.add(idempotencyKey);

    // Update daily PnL.
    this.state.dailyPnl += outcome.netPnl;
    if (this.state.dailyPnl > this.state.peakDailyPnl) {
      this.state.peakDailyPnl = this.state.dailyPnl;
    }

    // Update consecutive losses.
    if (outcome.netPnl < 0) {
      this.state.consecutiveLosses += 1;
    } else {
      this.state.consecutiveLosses = 0;
    }

    // Update strategy trades.
    this.state.tradesToday += 1;
    this.state.strategyTradesToday[outcome.strategyId] =
      (this.state.strategyTradesToday[outcome.strategyId] ?? 0) + 1;

    // Track closed trade.
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
