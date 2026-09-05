import { describe, expect, it } from 'vitest';
import { RiskLedger, TradeOutcome } from './RiskLedger';

function dayKeyFromDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function todayMs(): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12, 0, 0);
}

function makeOutcome(overrides: Partial<TradeOutcome> = {}): TradeOutcome {
  return {
    tradeId: 'T1',
    symbol: 'XRPUSDT',
    side: 'LONG',
    strategyId: 'MICRO_BURST_V1',
    entryPrice: 1.0,
    exitPrice: 1.1,
    quantity: 100,
    grossPnl: 10,
    commissions: 0.5,
    funding: 0.1,
    netPnl: 9.4,
    closedAtMs: todayMs(),
    verified: true,
    ...overrides,
  };
}

describe('RiskLedger', () => {
  it('applies trade close and updates state', () => {
    const ledger = new RiskLedger();
    const applied = ledger.applyTradeClose(makeOutcome());
    expect(applied).toBe(true);

    const state = ledger.getState();
    expect(state.tradesToday).toBe(1);
    expect(state.dailyPnl).toBeCloseTo(9.4);
    expect(state.consecutiveLosses).toBe(0);
    expect(state.strategyTradesToday['MICRO_BURST_V1']).toBe(1);
  });

  it('rejects unverified outcomes without applying', () => {
    const ledger = new RiskLedger();
    const applied = ledger.applyTradeClose(makeOutcome({ verified: false }));
    expect(applied).toBe(false);

    const state = ledger.getState();
    expect(state.tradesToday).toBe(0);
    expect(state.dailyPnl).toBe(0);
  });

  it('returns false when applying duplicate close', () => {
    const ledger = new RiskLedger();
    const outcome = makeOutcome();
    expect(ledger.applyTradeClose(outcome)).toBe(true);
    expect(ledger.applyTradeClose(outcome)).toBe(false);

    const state = ledger.getState();
    expect(state.tradesToday).toBe(1); // Not double-counted.
  });

  it('tracks consecutive losses', () => {
    const ledger = new RiskLedger();
    ledger.applyTradeClose(makeOutcome({ tradeId: 'T1', netPnl: -5 }));
    expect(ledger.getState().consecutiveLosses).toBe(1);
    ledger.applyTradeClose(makeOutcome({ tradeId: 'T2', netPnl: -3 }));
    expect(ledger.getState().consecutiveLosses).toBe(2);
    ledger.applyTradeClose(makeOutcome({ tradeId: 'T3', netPnl: 10 }));
    expect(ledger.getState().consecutiveLosses).toBe(0);
  });

  it('tracks peak daily PnL', () => {
    const ledger = new RiskLedger();
    ledger.applyTradeClose(makeOutcome({ tradeId: 'T1', netPnl: 10 }));
    expect(ledger.getState().peakDailyPnl).toBeCloseTo(10);
    ledger.applyTradeClose(makeOutcome({ tradeId: 'T2', netPnl: -5 }));
    expect(ledger.getState().peakDailyPnl).toBeCloseTo(10); // Peak unchanged.
    ledger.applyTradeClose(makeOutcome({ tradeId: 'T3', netPnl: 20 }));
    expect(ledger.getState().peakDailyPnl).toBeCloseTo(25); // 10 - 5 + 20 = 25.
  });

  it('rolls over day forward but not backward', () => {
    // Use timestamps that are clearly in sequence.
    const day1Ms = 1_757_000_000_000; // Some day
    const day2Ms = day1Ms + 86_400_000; // Next day
    const day0Ms = day1Ms - 1000; // Just before day1

    const ledger = new RiskLedger({ dayKey: dayKeyFromDate(day1Ms) });
    ledger.applyTradeClose(makeOutcome({ tradeId: 'T1', netPnl: 10, closedAtMs: day1Ms }));
    expect(ledger.getState().tradesToday).toBe(1);

    // Apply trade on next day: rolls forward.
    const nextDay = ledger.applyTradeClose(
      makeOutcome({ tradeId: 'T2', netPnl: 5, closedAtMs: day2Ms }),
    );
    expect(nextDay).toBe(true);
    const state = ledger.getState();
    expect(state.dayKey).toBe(dayKeyFromDate(day2Ms));
    expect(state.tradesToday).toBe(1); // Reset.
    expect(state.dailyPnl).toBeCloseTo(5); // Reset.
    expect(state.consecutiveLosses).toBe(0); // Reset.

    // Apply late trade from previous day: does NOT roll backward.
    const lateTrade = ledger.applyTradeClose(
      makeOutcome({ tradeId: 'T3', netPnl: 3, closedAtMs: day0Ms }),
    );
    expect(lateTrade).toBe(true);
    const stateAfterLate = ledger.getState();
    // Day key stays on day2 (forward-only rollover).
    expect(stateAfterLate.dayKey).toBe(dayKeyFromDate(day2Ms));
    // Late trade PnL is NOT added to current day's PnL (belongs to its own day).
    expect(stateAfterLate.dailyPnl).toBeCloseTo(5);
    // But the trade is tracked for idempotency.
    expect(stateAfterLate.closedTradeIds).toContain('T3');
  });

  it('isApplied checks idempotency', () => {
    const ledger = new RiskLedger();
    expect(ledger.isApplied('T1', 1000)).toBe(false);
    ledger.applyTradeClose(makeOutcome({ tradeId: 'T1', closedAtMs: 1000 }));
    expect(ledger.isApplied('T1', 1000)).toBe(true);
    expect(ledger.isApplied('T1', 2000)).toBe(false); // Different timestamp.
  });

  it('restoreApplied adds keys without triggering state updates', () => {
    const ledger = new RiskLedger();
    ledger.restoreApplied(['close:T1:1000', 'close:T2:2000']);
    expect(ledger.isApplied('T1', 1000)).toBe(true);
    expect(ledger.isApplied('T2', 2000)).toBe(true);
    expect(ledger.getState().tradesToday).toBe(0); // No state change from restore.
  });

  it('persists applied keys in state and restores on construction', () => {
    const ledger1 = new RiskLedger();
    ledger1.applyTradeClose(makeOutcome({ tradeId: 'T1', closedAtMs: 1000 }));
    ledger1.applyTradeClose(makeOutcome({ tradeId: 'T2', closedAtMs: 2000 }));

    // Get state with applied keys.
    const state = ledger1.getState();
    expect(state.appliedKeys).toHaveLength(2);
    expect(state.appliedKeys).toContain('close:T1:1000');
    expect(state.appliedKeys).toContain('close:T2:2000');

    // Reconstruct with only appliedKeys (new day, fresh counters).
    const ledger2 = new RiskLedger({ appliedKeys: state.appliedKeys });
    expect(ledger2.isApplied('T1', 1000)).toBe(true);
    expect(ledger2.isApplied('T2', 2000)).toBe(true);
    // Re-applying same trades returns false (idempotent).
    expect(ledger2.applyTradeClose(makeOutcome({ tradeId: 'T1', closedAtMs: 1000 }))).toBe(false);
    // Fresh counters: no new trades counted.
    expect(ledger2.getState().tradesToday).toBe(0);
  });

  it('returns independent state copies including appliedKeys', () => {
    const ledger = new RiskLedger();
    ledger.applyTradeClose(makeOutcome({ tradeId: 'T1', netPnl: 10 }));
    const s1 = ledger.getState();
    const s2 = ledger.getState();
    s1.tradesToday = 999;
    s1.appliedKeys.push('fake');
    expect(ledger.getState().tradesToday).toBe(1);
    expect(ledger.getState().appliedKeys).toHaveLength(1);
  });

  it('tracks closed trade ids', () => {
    const ledger = new RiskLedger();
    ledger.applyTradeClose(makeOutcome({ tradeId: 'T1' }));
    ledger.applyTradeClose(makeOutcome({ tradeId: 'T2' }));
    expect(ledger.getState().closedTradeIds).toEqual(['T1', 'T2']);
  });

  it('initializes with provided state', () => {
    const ledger = new RiskLedger({
      dayKey: '2026-09-05',
      tradesToday: 5,
      consecutiveLosses: 3,
      dailyPnl: -50,
      strategyTradesToday: { MICRO_BURST_V1: 3, AEGIS_TURBO: 2 },
    });
    const state = ledger.getState();
    expect(state.dayKey).toBe('2026-09-05');
    expect(state.tradesToday).toBe(5);
    expect(state.consecutiveLosses).toBe(3);
    expect(state.dailyPnl).toBe(-50);
  });

  it('returns independent state copies', () => {
    const ledger = new RiskLedger();
    ledger.applyTradeClose(makeOutcome({ tradeId: 'T1', netPnl: 10 }));
    const s1 = ledger.getState();
    const s2 = ledger.getState();
    s1.tradesToday = 999;
    expect(ledger.getState().tradesToday).toBe(1); // Not affected.
  });

  it('late close does NOT add to dailyPnl', () => {
    // Create ledger on day2, apply a day1 trade.
    const day1Ms = 1_757_000_000_000;
    const day2Ms = day1Ms + 86_400_000;
    const ledger = new RiskLedger({ dayKey: dayKeyFromDate(day2Ms) });
    // Apply today's trade: pnl = 10.
    ledger.applyTradeClose(makeOutcome({ tradeId: 'T1', netPnl: 10, closedAtMs: day2Ms }));
    expect(ledger.getState().dailyPnl).toBeCloseTo(10);

    // Apply yesterday's loss: should NOT affect dailyPnl.
    ledger.applyTradeClose(makeOutcome({ tradeId: 'T2', netPnl: -25, closedAtMs: day1Ms }));
    const state = ledger.getState();
    expect(state.dailyPnl).toBeCloseTo(10); // Unchanged by yesterday's loss.
    expect(state.tradesToday).toBe(1); // Late trade not counted.
    expect(state.consecutiveLosses).toBe(0); // Late loss not counted.
    expect(state.closedTradeIds).toEqual(['T1', 'T2']); // But tracked for idempotency.
  });

  it('late close records PnL in historicalPnl by day', () => {
    const day1Ms = 1_757_000_000_000;
    const day2Ms = day1Ms + 86_400_000;
    const ledger = new RiskLedger({ dayKey: dayKeyFromDate(day2Ms) });
    ledger.applyTradeClose(makeOutcome({ tradeId: 'T1', netPnl: 10, closedAtMs: day2Ms }));
    ledger.applyTradeClose(makeOutcome({ tradeId: 'T2', netPnl: -25, closedAtMs: day1Ms }));
    ledger.applyTradeClose(makeOutcome({ tradeId: 'T3', netPnl: -5, closedAtMs: day1Ms }));

    const state = ledger.getState();
    // Today's PnL: only T1.
    expect(state.dailyPnl).toBeCloseTo(10);
    // Yesterday's cumulative: -25 + -5 = -30.
    expect(state.historicalPnl[dayKeyFromDate(day1Ms)]).toBeCloseTo(-30);
    // getHistoricalPnl accessor.
    expect(ledger.getHistoricalPnl(dayKeyFromDate(day1Ms))).toBeCloseTo(-30);
    expect(ledger.getHistoricalPnl('2099-01-01')).toBe(0);
  });

  it('historicalPnl survives reconstruction', () => {
    const day1Ms = 1_757_000_000_000;
    const day2Ms = day1Ms + 86_400_000;
    const ledger1 = new RiskLedger({ dayKey: dayKeyFromDate(day2Ms) });
    ledger1.applyTradeClose(makeOutcome({ tradeId: 'T1', netPnl: 10, closedAtMs: day2Ms }));
    ledger1.applyTradeClose(makeOutcome({ tradeId: 'T2', netPnl: -25, closedAtMs: day1Ms }));

    // Reconstruct from state.
    const state = ledger1.getState();
    const ledger2 = new RiskLedger(state);
    expect(ledger2.getHistoricalPnl(dayKeyFromDate(day1Ms))).toBeCloseTo(-25);
    expect(ledger2.getState().dailyPnl).toBeCloseTo(10);
    // Re-applying same trades is idempotent.
    expect(ledger2.applyTradeClose(makeOutcome({ tradeId: 'T2', netPnl: -25, closedAtMs: day1Ms }))).toBe(false);
    expect(ledger2.getHistoricalPnl(dayKeyFromDate(day1Ms))).toBeCloseTo(-25);
  });
});
