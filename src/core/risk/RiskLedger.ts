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
  verified: boolean;
  /** Positive safe integer, default 1. A higher revision replaces known evidence. */
  revision?: number;
}

export interface LegacyRiskBaseline {
  dayKey: string;
  tradesToday: number;
  strategyTradesToday: Record<string, number>;
  /** Global chronological loss streak, not reset at UTC rollover. */
  consecutiveLosses: number;
  dailyPnl: number;
  peakDailyPnl: number;
  /** Baseline: prior days only, with dailyPnl separate. Snapshot: totals including today. */
  historicalPnl: Record<string, number>;
}

export interface DailyRiskState extends LegacyRiskBaseline {
  /**
   * 1: aggregate import only; history must include dayKey and equal dailyPnl there.
   * 2: replayable snapshot; requires outcomes + legacyBaseline (prior-day history only).
   * Absent: legacy aggregates exclude today (older history may be late-only), or
   * published d341225 evidence snapshots. Unknown versions are rejected.
   */
  version?: 1 | 2;
  /** All known closed identities, retained across rollover. */
  closedTradeIds: string[];
  /** Legacy timestamp keys, retained for existing persistence consumers. */
  appliedKeys: string[];
  /** Latest accepted evidence per tradeId, sufficient to replay and correct totals. */
  outcomes?: TradeOutcome[];
  /** Immutable economic prefix imported from states without outcome evidence. */
  legacyBaseline?: LegacyRiskBaseline;
}

export interface RiskLedgerEntry {
  tradeId: string;
  event: 'TRADE_CLOSED' | 'RISK_APPLIED';
  dayKey: string;
  timestampMs: number;
  idempotencyKey: string;
}

/**
 * Serializable in-memory ledger, not a durable journal or runtime integration.
 * Evidence is replayed by (closedAtMs, tradeId), never reception order.
 * Legacy aggregates are preserved, but missing old PnL/events cannot be recovered.
 * Their peak is retained as a prefix bound. Evidence on/before the baseline day
 * cannot reduce its known streak; later days extend or reset that prefix normally.
 */
export class RiskLedger {
  private state: DailyRiskState;

  constructor(initial: Partial<DailyRiskState> = {}) {
    if (initial.version !== undefined && initial.version !== 1 && initial.version !== 2) {
      throw new RangeError('Unsupported risk state version');
    }
    const hasEvidence = initial.outcomes !== undefined || initial.legacyBaseline !== undefined;
    if (initial.version === 1 && hasEvidence) {
      throw new RangeError('Version 1 requires aggregates without outcome evidence');
    }
    const sourceBaseline = initial.legacyBaseline ?? {
      dayKey: initial.dayKey ?? dayKeyFromDate(Date.now()),
      tradesToday: initial.tradesToday ?? 0,
      strategyTradesToday: initial.strategyTradesToday ?? {},
      consecutiveLosses: initial.consecutiveLosses ?? 0,
      dailyPnl: initial.dailyPnl ?? 0,
      peakDailyPnl: initial.peakDailyPnl ?? 0,
      historicalPnl: initial.historicalPnl ?? {},
    };
    // Evidence-bearing snapshots must carry their baseline, not reimport totals.
    if (
      (hasEvidence || initial.version === 2) &&
      (!Array.isArray(initial.outcomes) || !initial.legacyBaseline)
    ) {
      throw new RangeError('Outcome snapshots require an evidence array and legacyBaseline');
    }
    validateBaseline(sourceBaseline);
    const baseline = copyBaseline(sourceBaseline);
    const hasCurrentHistory = Object.prototype.hasOwnProperty.call(
      baseline.historicalPnl,
      baseline.dayKey,
    );
    if (initial.version === 1) {
      if (
        !hasCurrentHistory ||
        initial.dailyPnl === undefined ||
        baseline.historicalPnl[baseline.dayKey] !== baseline.dailyPnl
      ) {
        throw new RangeError('Version 1 history must include today and match dailyPnl');
      }
    } else if (hasCurrentHistory) {
      // d341225 could retain a harmless zero, but nonzero values double-counted PnL.
      if (!hasEvidence || initial.version === 2 || baseline.historicalPnl[baseline.dayKey] !== 0) {
        throw new RangeError('Ambiguous current-day baseline history');
      }
    }
    delete baseline.historicalPnl[baseline.dayKey];
    if (initial.legacyBaseline) {
      validateBaseline({ ...baseline, ...initial });
    }
    const dayKey = initial.dayKey ?? baseline.dayKey;
    validateDay(dayKey);
    if (dayKey < baseline.dayKey) throw new RangeError('Day precedes baseline');
    const outcomes = (initial.outcomes ?? []).map((outcome) => {
      validateOutcome(outcome);
      return { ...outcome, revision: outcome.revision ?? 1 };
    });
    if (new Set(outcomes.map((outcome) => outcome.tradeId)).size !== outcomes.length) {
      throw new RangeError('Duplicate outcome identity');
    }
    const appliedKeys = [...(initial.appliedKeys ?? [])];
    appliedKeys.forEach(parseAppliedKey);
    const closedTradeIds = [...(initial.closedTradeIds ?? [])];
    closedTradeIds.forEach(validateId);
    for (const outcome of outcomes) {
      if (dayKeyFromDate(outcome.closedAtMs) > dayKey) {
        throw new RangeError('Outcome exceeds snapshot day');
      }
      appliedKeys.push(`close:${outcome.tradeId}:${outcome.closedAtMs}`);
      closedTradeIds.push(outcome.tradeId);
    }
    const restored = rebuild({
      ...baseline,
      dayKey,
      outcomes,
      legacyBaseline: copyBaseline(baseline),
      appliedKeys: [...new Set(appliedKeys)],
      closedTradeIds: [...new Set(closedTradeIds)],
    });
    if (initial.legacyBaseline) {
      for (const field of [
        'dailyPnl',
        'peakDailyPnl',
        'tradesToday',
        'consecutiveLosses',
      ] as const) {
        if (initial[field] !== restored[field])
          throw new RangeError('Snapshot totals do not match evidence');
      }
      for (const field of ['historicalPnl', 'strategyTradesToday'] as const) {
        const saved = initial[field];
        const computed = restored[field];
        if (
          !saved ||
          Object.keys(saved).length !== Object.keys(computed).length ||
          Object.entries(computed).some(
            ([key, value]) =>
              !Object.prototype.hasOwnProperty.call(saved, key) || saved[key] !== value,
          )
        ) {
          throw new RangeError('Snapshot maps do not match evidence');
        }
      }
    }
    this.state = restored;
  }

  getState(): DailyRiskState {
    return {
      version: 2,
      ...copyBaseline(this.state),
      appliedKeys: [...this.state.appliedKeys],
      closedTradeIds: [...this.state.closedTradeIds],
      outcomes: this.state.outcomes!.map((outcome) => ({ ...outcome })),
      legacyBaseline: copyBaseline(this.state.legacyBaseline!),
    };
  }

  /**
   * Returns false for invalid/unverified input, duplicates, stale revisions,
   * unsupported legacy corrections or overflow, without any state mutation.
   * Changed payloads/timestamps require a higher revision for the same tradeId.
   * Corrections require previous outcome evidence; keys alone are insufficient.
   * netPnl is the authoritative verified economic value (not recomputed here).
   */
  applyTradeClose(outcome: TradeOutcome): boolean {
    try {
      validateOutcome(outcome);
      const revision = outcome.revision ?? 1;
      const previous = this.state.outcomes!.find((item) => item.tradeId === outcome.tradeId);
      if (previous) {
        if (revision <= (previous.revision ?? 1)) return false;
      } else {
        if (revision !== 1 || this.state.closedTradeIds.includes(outcome.tradeId)) return false;
        if (this.state.appliedKeys.some((key) => parseAppliedKey(key) === outcome.tradeId)) {
          return false;
        }
      }
      const candidate = this.getState();
      candidate.outcomes = candidate.outcomes!.filter((item) => item.tradeId !== outcome.tradeId);
      candidate.outcomes.push({ ...outcome, revision });
      const tradeDay = dayKeyFromDate(outcome.closedAtMs);
      if (tradeDay > candidate.dayKey) candidate.dayKey = tradeDay;
      candidate.appliedKeys = [
        ...new Set([...candidate.appliedKeys, `close:${outcome.tradeId}:${outcome.closedAtMs}`]),
      ];
      if (!previous) candidate.closedTradeIds.push(outcome.tradeId);
      this.state = rebuild(candidate);
      return true;
    } catch (error) {
      if (error instanceof RangeError) return false;
      throw error;
    }
  }

  /** Timestamp-specific compatibility query; application deduplicates by tradeId. */
  isApplied(tradeId: string, closedAtMs: number): boolean {
    validateId(tradeId);
    dayKeyFromDate(closedAtMs);
    return this.state.appliedKeys.includes(`close:${tradeId}:${closedAtMs}`);
  }

  getAppliedKeys(): string[] {
    return [...this.state.appliedKeys];
  }

  /** Total known economic PnL for a UTC day, including ordinary and late closes.
   * Includes the current day. Legacy history only contains what was exported.
   */
  getHistoricalPnl(dayKey: string): number {
    validateDay(dayKey);
    return Object.prototype.hasOwnProperty.call(this.state.historicalPnl, dayKey)
      ? this.state.historicalPnl[dayKey]
      : 0;
  }

  /** Imports legacy deduplication evidence only, atomically; does not invent events. */
  restoreApplied(idempotencyKeys: string[]): void {
    idempotencyKeys.forEach(parseAppliedKey);
    this.state.appliedKeys = [...new Set([...this.state.appliedKeys, ...idempotencyKeys])];
  }
}

function copyBaseline(state: LegacyRiskBaseline): LegacyRiskBaseline {
  return {
    dayKey: state.dayKey,
    tradesToday: state.tradesToday,
    strategyTradesToday: { ...state.strategyTradesToday },
    consecutiveLosses: state.consecutiveLosses,
    dailyPnl: state.dailyPnl,
    peakDailyPnl: state.peakDailyPnl,
    historicalPnl: { ...state.historicalPnl },
  };
}

function rebuild(state: DailyRiskState): DailyRiskState {
  const baseline = state.legacyBaseline!;
  const sameDay = baseline.dayKey === state.dayKey;
  state.tradesToday = sameDay ? baseline.tradesToday : 0;
  state.strategyTradesToday = sameDay ? { ...baseline.strategyTradesToday } : {};
  state.dailyPnl = sameDay ? baseline.dailyPnl : 0;
  state.peakDailyPnl = sameDay ? baseline.peakDailyPnl : 0;
  state.consecutiveLosses = baseline.consecutiveLosses;
  state.historicalPnl = { ...baseline.historicalPnl };
  state.historicalPnl[baseline.dayKey] = baseline.dailyPnl;
  const chronological = [...state.outcomes!].sort(
    (a, b) =>
      a.closedAtMs - b.closedAtMs || (a.tradeId < b.tradeId ? -1 : a.tradeId > b.tradeId ? 1 : 0),
  );
  let earlyEvidenceStreak = 0;
  for (const outcome of chronological) {
    const day = dayKeyFromDate(outcome.closedAtMs);
    state.historicalPnl[day] = add(state.historicalPnl[day] ?? 0, outcome.netPnl);
    if (day <= baseline.dayKey) {
      earlyEvidenceStreak = outcome.netPnl < 0 ? addCount(earlyEvidenceStreak, 1) : 0;
      state.consecutiveLosses = Math.max(baseline.consecutiveLosses, earlyEvidenceStreak);
    } else {
      state.consecutiveLosses = outcome.netPnl < 0 ? addCount(state.consecutiveLosses, 1) : 0;
    }
    if (day !== state.dayKey) continue;
    state.dailyPnl = add(state.dailyPnl, outcome.netPnl);
    state.peakDailyPnl = Math.max(state.peakDailyPnl, state.dailyPnl);
    state.tradesToday = addCount(state.tradesToday, 1);
    const count = Object.prototype.hasOwnProperty.call(
      state.strategyTradesToday,
      outcome.strategyId,
    )
      ? state.strategyTradesToday[outcome.strategyId]
      : 0;
    Object.defineProperty(state.strategyTradesToday, outcome.strategyId, {
      value: addCount(count, 1),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return state;
}

function validateId(value: string): void {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f\x7f]/.test(value)) {
    throw new RangeError('Invalid identifier');
  }
}

function dayKeyFromDate(ms: number): string {
  // Nonnegative integer Unix milliseconds, restricted to four-digit UTC years.
  if (!Number.isSafeInteger(ms) || ms < 0 || ms > 253402300799999) {
    throw new RangeError('Invalid timestamp');
  }
  return new Date(ms).toISOString().slice(0, 10);
}

function validateDay(day: string): void {
  if (
    typeof day !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
    dayKeyFromDate(Date.parse(`${day}T00:00:00.000Z`)) !== day
  ) {
    throw new RangeError('Invalid day');
  }
}

function finite(value: number): void {
  if (!Number.isFinite(value)) throw new RangeError('Nonfinite number');
}

function add(a: number, b: number): number {
  const result = a + b;
  finite(result);
  return result;
}

function addCount(a: number, b: number): number {
  const result = a + b;
  if (!Number.isSafeInteger(result) || result < 0) throw new RangeError('Invalid count');
  return result;
}

function validateOutcome(outcome: TradeOutcome): void {
  if (!outcome || outcome.verified !== true) throw new RangeError('Unverified outcome');
  [outcome.tradeId, outcome.symbol, outcome.strategyId].forEach(validateId);
  if (outcome.side !== 'LONG' && outcome.side !== 'SHORT') throw new RangeError('Invalid side');
  dayKeyFromDate(outcome.closedAtMs);
  if (
    outcome.revision !== undefined &&
    (!Number.isSafeInteger(outcome.revision) || outcome.revision < 1)
  ) {
    throw new RangeError('Invalid revision');
  }
  [outcome.entryPrice, outcome.exitPrice, outcome.quantity].forEach((value) => {
    finite(value);
    if (value <= 0) throw new RangeError('Nonpositive price or quantity');
  });
  [outcome.grossPnl, outcome.commissions, outcome.funding, outcome.netPnl].forEach(finite);
}

function parseAppliedKey(key: string): string {
  if (typeof key !== 'string') throw new RangeError('Invalid applied key');
  const match = /^close:(.+):(\d+)$/.exec(key);
  if (!match) throw new RangeError('Invalid applied key');
  validateId(match[1]);
  dayKeyFromDate(Number(match[2]));
  return match[1];
}

function validateBaseline(baseline: LegacyRiskBaseline): void {
  validateDay(baseline.dayKey);
  addCount(baseline.tradesToday, 0);
  addCount(baseline.consecutiveLosses, 0);
  finite(baseline.dailyPnl);
  finite(baseline.peakDailyPnl);
  if (baseline.peakDailyPnl < 0) throw new RangeError('Negative peak');
  for (const [id, count] of Object.entries(baseline.strategyTradesToday)) {
    validateId(id);
    addCount(count, 0);
  }
  for (const [day, pnl] of Object.entries(baseline.historicalPnl)) {
    validateDay(day);
    finite(pnl);
    if (day > baseline.dayKey) throw new RangeError('History exceeds baseline day');
  }
}
