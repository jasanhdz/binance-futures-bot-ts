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
    expect(state.consecutiveLosses).toBe(0); // Latest chronological close is a win.

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
    expect(state.consecutiveLosses).toBe(0); // Today's later win ends the global streak.
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
    expect(
      ledger2.applyTradeClose(makeOutcome({ tradeId: 'T2', netPnl: -25, closedAtMs: day1Ms })),
    ).toBe(false);
    expect(ledger2.getHistoricalPnl(dayKeyFromDate(day1Ms))).toBeCloseTo(-25);
  });
});

describe('RiskLedger evidence and recovery contracts', () => {
  const yesterday = Date.UTC(2026, 8, 4, 12);
  const today = yesterday + 86_400_000;
  const yesterdayKey = dayKeyFromDate(yesterday);
  const todayKey = dayKeyFromDate(today);
  const restart = (ledger: RiskLedger): RiskLedger =>
    new RiskLedger(JSON.parse(JSON.stringify(ledger.getState())));

  it.each([0, 5, -5])(
    'rejects unversioned current-day aggregate history even when equal (%s)',
    (pnl) => {
      expect(
        () =>
          new RiskLedger({
            dayKey: todayKey,
            dailyPnl: pnl,
            historicalPnl: { [todayKey]: pnl },
          }),
      ).toThrow('Ambiguous current-day baseline history');
    },
  );

  it('imports explicit total history once and preserves rollover and late closes after restart', () => {
    const input = {
      version: 1 as const,
      dayKey: yesterdayKey,
      dailyPnl: 5,
      peakDailyPnl: 5,
      historicalPnl: { '2026-09-03': -7, [yesterdayKey]: 5 },
    };
    let ledger = new RiskLedger(input);
    expect(ledger.getHistoricalPnl(yesterdayKey)).toBe(5);
    expect(ledger.getState()).toMatchObject({ version: 2, dailyPnl: 5 });
    expect(ledger.getState().legacyBaseline!.historicalPnl).toEqual({ '2026-09-03': -7 });
    expect(input.historicalPnl[yesterdayKey]).toBe(5);
    const imported = ledger.getState();
    ledger = restart(ledger);
    expect(ledger.getState()).toEqual(imported);
    expect(
      ledger.applyTradeClose(makeOutcome({ tradeId: 'next', closedAtMs: today, netPnl: 3 })),
    ).toBe(true);
    ledger = restart(ledger);
    const late = makeOutcome({ tradeId: 'late', closedAtMs: yesterday + 1, netPnl: -2 });
    expect(ledger.applyTradeClose(late)).toBe(true);
    ledger = restart(ledger);
    expect(ledger.getHistoricalPnl(yesterdayKey)).toBe(3);
    expect(ledger.getHistoricalPnl('2026-09-03')).toBe(-7);
    expect(ledger.getState()).toMatchObject({ dailyPnl: 3, tradesToday: 1 });
    expect(ledger.applyTradeClose(late)).toBe(false);
  });

  it('rejects conflicting or incomplete explicit total imports', () => {
    for (const historicalPnl of [{ [todayKey]: 10 }, { [yesterdayKey]: 5 }]) {
      expect(
        () => new RiskLedger({ version: 1, dayKey: todayKey, dailyPnl: 5, historicalPnl }),
      ).toThrow('Version 1 history must include today and match dailyPnl');
    }
    expect(
      () =>
        new RiskLedger({
          version: 1,
          dayKey: todayKey,
          historicalPnl: { [todayKey]: 0 },
        }),
    ).toThrow(RangeError);
  });

  it('accepts prior-day-only legacy history without inventing missing ordinary PnL', () => {
    const ledger = new RiskLedger({
      dayKey: todayKey,
      dailyPnl: 5,
      historicalPnl: { [yesterdayKey]: -2 },
    });
    expect(ledger.getState().historicalPnl).toEqual({ [yesterdayKey]: -2, [todayKey]: 5 });
    expect(restart(ledger).getState()).toEqual(ledger.getState());
  });

  it.each<Record<string, number>>([{}, { '2026-09-05': 0 }])(
    'restores published unversioned evidence with baseline history %j',
    (history) => {
      // Literal d341225 snapshot: baseline 5 plus one evidenced close of 2.
      const snapshot = {
        dayKey: todayKey,
        tradesToday: 2,
        strategyTradesToday: { MICRO_BURST_V1: 2 },
        consecutiveLosses: 0,
        dailyPnl: 7,
        peakDailyPnl: 7,
        historicalPnl: { [yesterdayKey]: -3, [todayKey]: 7 },
        closedTradeIds: ['old', 'T1'],
        appliedKeys: [`close:old:${today - 1}`, `close:T1:${today}`],
        outcomes: [makeOutcome({ closedAtMs: today, netPnl: 2, revision: 1 })],
        legacyBaseline: {
          dayKey: todayKey,
          tradesToday: 1,
          strategyTradesToday: { MICRO_BURST_V1: 1 },
          consecutiveLosses: 0,
          dailyPnl: 5,
          peakDailyPnl: 5,
          historicalPnl: { [yesterdayKey]: -3, ...history },
        },
      };
      const ledger = new RiskLedger(snapshot);
      expect(ledger.getState()).toMatchObject({ version: 2, dailyPnl: 7 });
      expect(ledger.getHistoricalPnl(todayKey)).toBe(7);
      expect(ledger.getState().legacyBaseline!.historicalPnl).toEqual({ [yesterdayKey]: -3 });
      expect(restart(ledger).getState()).toEqual(ledger.getState());
      expect(ledger.applyTradeClose(snapshot.outcomes[0])).toBe(false);
      // Even totals consistent with the old double-counting bug must not be preserved.
      snapshot.legacyBaseline.historicalPnl[todayKey] = 5;
      snapshot.historicalPnl[todayKey] = 12;
      expect(() => new RiskLedger(snapshot)).toThrow('Ambiguous current-day baseline history');
    },
  );

  it('validates versions, evidence pairing and the modern baseline contract', () => {
    const snapshot = new RiskLedger({ dayKey: todayKey }).getState();
    for (const version of [0, 3, '2', null]) {
      expect(() => new RiskLedger({ ...snapshot, version: version as 2 })).toThrow(
        'Unsupported risk state version',
      );
    }
    for (const version of [undefined, 2] as const) {
      expect(() => new RiskLedger({ ...snapshot, version, outcomes: undefined })).toThrow(
        RangeError,
      );
      expect(() => new RiskLedger({ ...snapshot, version, legacyBaseline: undefined })).toThrow(
        RangeError,
      );
    }
    expect(() => new RiskLedger({ version: 2 })).toThrow(RangeError);
    expect(() => new RiskLedger({ ...snapshot, version: 1 })).toThrow(RangeError);
    snapshot.legacyBaseline!.historicalPnl[todayKey] = 0;
    expect(() => new RiskLedger(snapshot)).toThrow('Ambiguous current-day baseline history');
  });

  it('archives ordinary PnL at rollover and adds late economics exactly once after JSON restart', () => {
    let ledger = new RiskLedger({ dayKey: yesterdayKey });
    const ordinary = makeOutcome({ tradeId: 'ordinary', closedAtMs: yesterday, netPnl: 10 });
    const current = makeOutcome({ tradeId: 'current', closedAtMs: today, netPnl: 5 });
    const late = makeOutcome({ tradeId: 'late', closedAtMs: yesterday + 1, netPnl: -25 });
    expect(ledger.applyTradeClose(ordinary)).toBe(true);
    expect(ledger.applyTradeClose(current)).toBe(true);
    expect(ledger.getHistoricalPnl(yesterdayKey)).toBe(10);
    ledger = restart(ledger);
    expect(ledger.applyTradeClose(late)).toBe(true);
    expect(ledger.getHistoricalPnl(yesterdayKey)).toBe(-15);
    expect(ledger.getHistoricalPnl(todayKey)).toBe(5);
    expect(ledger.getState()).toMatchObject({ dailyPnl: 5, tradesToday: 1 });
    const before = ledger.getState();
    ledger = restart(ledger);
    for (const outcome of [ordinary, current, late]) {
      expect(ledger.applyTradeClose(outcome)).toBe(false);
    }
    expect(ledger.getState()).toEqual(before);
  });

  it('isolates input outcomes, snapshots and constructor maps/evidence', () => {
    const ledger = new RiskLedger({ dayKey: todayKey });
    const outcome = makeOutcome({ closedAtMs: today });
    ledger.applyTradeClose(outcome);
    const expected = ledger.getState();
    outcome.netPnl = 999;
    const snapshot = ledger.getState();
    const recovered = new RiskLedger(snapshot);
    snapshot.strategyTradesToday.MICRO_BURST_V1 = 999;
    snapshot.historicalPnl[todayKey] = 999;
    snapshot.appliedKeys.length = 0;
    snapshot.closedTradeIds.length = 0;
    snapshot.outcomes![0].netPnl = 999;
    snapshot.legacyBaseline!.strategyTradesToday.injected = 999;
    snapshot.legacyBaseline!.historicalPnl[yesterdayKey] = 999;
    expect(ledger.getState()).toEqual(expected);
    expect(recovered.getState()).toEqual(expected);
    expect(recovered.applyTradeClose(makeOutcome({ closedAtMs: today }))).toBe(false);

    const legacy = {
      dayKey: todayKey,
      strategyTradesToday: { strategy: 2 },
      historicalPnl: { [yesterdayKey]: 7 },
      appliedKeys: ['close:old:1000'],
    };
    const imported = new RiskLedger(legacy);
    const before = imported.getState();
    legacy.strategyTradesToday.strategy = 99;
    legacy.historicalPnl[yesterdayKey] = 99;
    legacy.appliedKeys.length = 0;
    expect(imported.getState()).toEqual(before);
  });

  it('replays same-day late events chronologically for peaks and streaks', () => {
    const events = [
      makeOutcome({ tradeId: 'A', closedAtMs: today, netPnl: -20 }),
      makeOutcome({ tradeId: 'B', closedAtMs: today + 1, netPnl: 10 }),
      makeOutcome({ tradeId: 'C', closedAtMs: today + 2, netPnl: -5 }),
    ];
    for (const order of [
      [1, 2, 0],
      [2, 0, 1],
      [0, 1, 2],
    ]) {
      let ledger = new RiskLedger({ dayKey: todayKey });
      for (const index of order) {
        ledger.applyTradeClose(events[index]);
        ledger = restart(ledger);
      }
      expect(ledger.getState()).toMatchObject({
        dailyPnl: -15,
        peakDailyPnl: 0,
        consecutiveLosses: 1,
        tradesToday: 3,
      });
    }
  });

  it('breaks timestamp ties by tradeId and carries the global streak across rollover', () => {
    const ledger = new RiskLedger({ dayKey: yesterdayKey });
    ledger.applyTradeClose(makeOutcome({ tradeId: 'B', closedAtMs: yesterday, netPnl: -4 }));
    ledger.applyTradeClose(makeOutcome({ tradeId: 'A', closedAtMs: yesterday, netPnl: 10 }));
    expect(ledger.getState()).toMatchObject({ peakDailyPnl: 10, consecutiveLosses: 1 });
    ledger.applyTradeClose(makeOutcome({ tradeId: 'C', closedAtMs: today, netPnl: -2 }));
    expect(ledger.getState()).toMatchObject({
      dailyPnl: -2,
      tradesToday: 1,
      peakDailyPnl: 0,
      consecutiveLosses: 2,
    });
    expect(restart(ledger).getState()).toEqual(ledger.getState());
  });

  it('rebuilds cross-midnight streaks for late evidence and corrections without changing daily counters', () => {
    const midnight = Date.UTC(2026, 8, 5);
    let ledger = new RiskLedger({ dayKey: yesterdayKey });
    const first = makeOutcome({ tradeId: 'first', closedAtMs: midnight - 3, netPnl: -4 });
    const current = makeOutcome({ tradeId: 'current', closedAtMs: midnight, netPnl: -2 });
    ledger.applyTradeClose(first);
    ledger.applyTradeClose(current);
    expect(ledger.getState().consecutiveLosses).toBe(2);
    const lateLoss = makeOutcome({ tradeId: 'late-loss', closedAtMs: midnight - 1, netPnl: -3 });
    ledger.applyTradeClose(lateLoss);
    expect(ledger.getState().consecutiveLosses).toBe(3);
    ledger = restart(ledger);
    const lateWin = makeOutcome({ tradeId: 'late-win', closedAtMs: midnight - 2, netPnl: 10 });
    ledger.applyTradeClose(lateWin);
    expect(ledger.getState().consecutiveLosses).toBe(2);
    expect(ledger.applyTradeClose({ ...lateLoss, revision: 2, netPnl: 0 })).toBe(true);
    expect(ledger.getState()).toMatchObject({
      dayKey: todayKey,
      dailyPnl: -2,
      peakDailyPnl: 0,
      tradesToday: 1,
      consecutiveLosses: 1,
    });
    const expected = ledger.getState();
    ledger = restart(ledger);
    for (const outcome of [first, current, lateWin, { ...lateLoss, revision: 2, netPnl: 0 }]) {
      expect(ledger.applyTradeClose(outcome)).toBe(false);
    }
    expect(ledger.getState()).toEqual(expected);
  });

  it('preserves a legacy streak under early evidence and extends it on later days', () => {
    let ledger = new RiskLedger({ dayKey: yesterdayKey, consecutiveLosses: 7, dailyPnl: -10 });
    ledger = new RiskLedger({ ...ledger.getState(), dayKey: todayKey, dailyPnl: 0 });
    expect(ledger.getState()).toMatchObject({ consecutiveLosses: 7, dailyPnl: 0 });
    expect(restart(ledger).getState()).toEqual(ledger.getState());
    ledger.applyTradeClose(makeOutcome({ tradeId: 'past', closedAtMs: yesterday, netPnl: -2 }));
    expect(ledger.getState()).toMatchObject({ consecutiveLosses: 7, dailyPnl: 0, tradesToday: 0 });
    ledger.applyTradeClose(makeOutcome({ tradeId: 'current', closedAtMs: today, netPnl: -3 }));
    expect(ledger.getState().consecutiveLosses).toBe(8);
    const expected = ledger.getState();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      ledger = restart(ledger);
      expect(ledger.getState()).toEqual(expected);
      expect(ledger.getHistoricalPnl(yesterdayKey)).toBe(-12);
      expect(ledger.getHistoricalPnl(todayKey)).toBe(-3);
      expect(ledger.getState().legacyBaseline!.consecutiveLosses).toBe(7);
    }
  });

  it('requires explicit higher revisions and replaces economics, dates and strategies without double counting', () => {
    let ledger = new RiskLedger({ dayKey: yesterdayKey });
    const original = makeOutcome({ tradeId: 'stable:identity', closedAtMs: yesterday, netPnl: 10 });
    ledger.applyTradeClose(original);
    ledger.applyTradeClose(makeOutcome({ tradeId: 'other', closedAtMs: today, netPnl: 5 }));
    const correction = { ...original, closedAtMs: today + 1, netPnl: -25, strategyId: 'corrected' };
    const before = ledger.getState();
    expect(ledger.applyTradeClose(correction)).toBe(false);
    expect(ledger.applyTradeClose({ ...correction, revision: 1 })).toBe(false);
    expect(ledger.getState()).toEqual(before);
    expect(ledger.applyTradeClose({ ...correction, revision: 2 })).toBe(true);
    expect(ledger.getHistoricalPnl(yesterdayKey)).toBe(0);
    expect(ledger.getState()).toMatchObject({
      dailyPnl: -20,
      tradesToday: 2,
      peakDailyPnl: 5,
      consecutiveLosses: 1,
      strategyTradesToday: { MICRO_BURST_V1: 1, corrected: 1 },
    });
    expect(ledger.getState().closedTradeIds).toEqual(['stable:identity', 'other']);
    ledger = restart(ledger);
    expect(ledger.applyTradeClose(original)).toBe(false);
    expect(ledger.applyTradeClose({ ...correction, revision: 2 })).toBe(false);
    expect(ledger.applyTradeClose({ ...original, revision: 3 })).toBe(true);
    expect(ledger.getHistoricalPnl(yesterdayKey)).toBe(10);
    expect(ledger.getState()).toMatchObject({ dailyPnl: 5, tradesToday: 1, consecutiveLosses: 0 });
    expect(ledger.getState().outcomes).toHaveLength(2);
  });

  it('does not clear legacy losses on an unorderable gain, but a later-day gain resets them', () => {
    const ledger = new RiskLedger({ dayKey: yesterdayKey, consecutiveLosses: 7 });
    ledger.applyTradeClose(
      makeOutcome({ tradeId: 'early-win', closedAtMs: yesterday, netPnl: 10 }),
    );
    expect(ledger.getState().consecutiveLosses).toBe(7);
    ledger.applyTradeClose(makeOutcome({ tradeId: 'later-loss', closedAtMs: today, netPnl: -1 }));
    expect(ledger.getState().consecutiveLosses).toBe(8);
    ledger.applyTradeClose(makeOutcome({ tradeId: 'later-win', closedAtMs: today + 1, netPnl: 2 }));
    expect(ledger.getState().consecutiveLosses).toBe(0);
    expect(restart(ledger).getState()).toEqual(ledger.getState());
  });

  it('preserves legacy baselines/keys without inventing evidence or extending unknown streaks', () => {
    let ledger = new RiskLedger({
      dayKey: yesterdayKey,
      dailyPnl: 10,
      peakDailyPnl: 15,
      tradesToday: 3,
      consecutiveLosses: 3,
      strategyTradesToday: { old: 3 },
      historicalPnl: { '2026-09-03': -7 },
      appliedKeys: ['close:old:1000'],
    });
    expect(ledger.applyTradeClose(makeOutcome({ tradeId: 'old', closedAtMs: yesterday }))).toBe(
      false,
    );
    expect(ledger.applyTradeClose(makeOutcome({ tradeId: 'old', revision: 2 }))).toBe(false);
    expect(ledger.applyTradeClose(makeOutcome({ tradeId: 'unknown', revision: 2 }))).toBe(false);
    ledger.applyTradeClose(makeOutcome({ closedAtMs: yesterday + 1, netPnl: -2 }));
    expect(ledger.getState()).toMatchObject({
      dailyPnl: 8,
      peakDailyPnl: 15,
      consecutiveLosses: 3,
    });
    ledger = restart(ledger);
    ledger.applyTradeClose(makeOutcome({ tradeId: 'next', closedAtMs: today, netPnl: 5 }));
    ledger.applyTradeClose(
      makeOutcome({ tradeId: 'late', closedAtMs: yesterday + 2, netPnl: -25 }),
    );
    ledger = restart(ledger);
    expect(ledger.getHistoricalPnl(yesterdayKey)).toBe(-17);
    expect(ledger.getHistoricalPnl('2026-09-03')).toBe(-7);
    expect(ledger.getState().legacyBaseline!.consecutiveLosses).toBe(3);
    expect(ledger.getAppliedKeys()).toContain('close:old:1000');
  });

  it.each([NaN, Infinity, -Infinity, -1, 0.5, 253402300800000, Number.MAX_VALUE])(
    'rejects invalid timestamp %s atomically',
    (closedAtMs) => {
      const ledger = new RiskLedger({ dayKey: todayKey });
      const before = ledger.getState();
      expect(ledger.applyTradeClose(makeOutcome({ closedAtMs }))).toBe(false);
      expect(ledger.getState()).toEqual(before);
      expect(() => ledger.isApplied('T1', closedAtMs)).toThrow(RangeError);
    },
  );

  it.each<Partial<TradeOutcome>>([
    { tradeId: '' },
    { tradeId: ' ' },
    { tradeId: 'bad\nidentity' },
    { tradeId: NaN as unknown as string },
    { strategyId: '' },
    { symbol: '' },
    { side: 'INVALID' as 'LONG' },
    { entryPrice: 0 },
    { exitPrice: -1 },
    { quantity: 0 },
    { quantity: Infinity },
    { entryPrice: NaN },
    { exitPrice: Infinity },
    { grossPnl: NaN },
    { commissions: Infinity },
    { funding: -Infinity },
    { netPnl: NaN },
    { revision: 0 },
    { revision: -1 },
    { revision: 1.5 },
    { revision: NaN },
    { revision: Number.MAX_SAFE_INTEGER + 1 },
    { verified: false },
  ])('rejects invalid evidence %j without mutation', (overrides) => {
    const ledger = new RiskLedger({ dayKey: todayKey });
    const before = ledger.getState();
    expect(ledger.applyTradeClose(makeOutcome({ closedAtMs: today, ...overrides }))).toBe(false);
    expect(ledger.getState()).toEqual(before);
  });

  it('accepts timestamp range endpoints and prototype-like identifiers safely', () => {
    const ledger = new RiskLedger({ dayKey: '1970-01-01' });
    expect(
      ledger.applyTradeClose(
        makeOutcome({ tradeId: '__proto__', strategyId: '__proto__', closedAtMs: 0 }),
      ),
    ).toBe(true);
    expect(ledger.getState().strategyTradesToday['__proto__']).toBe(1);
    expect(
      ledger.applyTradeClose(makeOutcome({ tradeId: 'last', closedAtMs: 253402300799999 })),
    ).toBe(true);
    expect(restart(ledger).getState()).toEqual(ledger.getState());
  });

  it('rejects overflow in daily/history/revisions and rollover before committing any state', () => {
    for (const dayKey of [yesterdayKey, todayKey]) {
      const ledger = new RiskLedger({ dayKey });
      const first = makeOutcome({ closedAtMs: yesterday, netPnl: Number.MAX_VALUE });
      expect(ledger.applyTradeClose(first)).toBe(true);
      const before = ledger.getState();
      expect(ledger.applyTradeClose({ ...first, tradeId: 'overflow' })).toBe(false);
      expect(ledger.getState()).toEqual(before);
    }
    const ledger = new RiskLedger({ dayKey: yesterdayKey });
    ledger.applyTradeClose(
      makeOutcome({ tradeId: 'A', closedAtMs: yesterday, netPnl: Number.MAX_VALUE }),
    );
    ledger.applyTradeClose(makeOutcome({ tradeId: 'B', closedAtMs: yesterday + 1, netPnl: -1 }));
    const before = ledger.getState();
    expect(
      ledger.applyTradeClose(
        makeOutcome({
          tradeId: 'B',
          revision: 2,
          closedAtMs: yesterday + 1,
          netPnl: Number.MAX_VALUE,
        }),
      ),
    ).toBe(false);
    expect(ledger.getState()).toEqual(before);
    expect(
      ledger.applyTradeClose(
        makeOutcome({ tradeId: 'future', closedAtMs: today, netPnl: Infinity }),
      ),
    ).toBe(false);
    expect(ledger.getState()).toEqual(before);
    expect(
      ledger.applyTradeClose(
        makeOutcome({ tradeId: 'B', revision: 2, closedAtMs: yesterday + 1, netPnl: -2 }),
      ),
    ).toBe(true);
    const countLedger = new RiskLedger({ dayKey: todayKey, tradesToday: Number.MAX_SAFE_INTEGER });
    const countBefore = countLedger.getState();
    expect(countLedger.applyTradeClose(makeOutcome({ closedAtMs: today }))).toBe(false);
    expect(countLedger.getState()).toEqual(countBefore);
  });

  it('validates imports and restores keys atomically', () => {
    expect(() => new RiskLedger({ dailyPnl: NaN })).toThrow(RangeError);
    expect(() => new RiskLedger({ dayKey: '2026-02-30' })).toThrow(RangeError);
    expect(() => new RiskLedger({ historicalPnl: { [yesterdayKey]: Infinity } })).toThrow(
      RangeError,
    );
    expect(() => new RiskLedger({ strategyTradesToday: { bad: NaN } })).toThrow(RangeError);
    const ledger = new RiskLedger({ dayKey: todayKey });
    const before = ledger.getState();
    expect(() => ledger.restoreApplied(['close:valid:1000', 'close:bad:NaN'])).toThrow(RangeError);
    expect(ledger.getState()).toEqual(before);
    const snapshot = ledger.getState();
    snapshot.outcomes!.push(makeOutcome({ closedAtMs: NaN }));
    expect(() => new RiskLedger(snapshot)).toThrow(RangeError);
    const duplicateEvidence = ledger.getState();
    duplicateEvidence.outcomes = [
      makeOutcome({ closedAtMs: today }),
      makeOutcome({ closedAtMs: today + 1 }),
    ];
    expect(() => new RiskLedger(duplicateEvidence)).toThrow(RangeError);
    expect(() => new RiskLedger({ outcomes: [] })).toThrow(RangeError);
    const evidenceSnapshot = ledger.getState();
    for (const invalid of [null, undefined, {}, '']) {
      expect(
        () =>
          new RiskLedger({
            ...evidenceSnapshot,
            outcomes: invalid as unknown as TradeOutcome[],
          }),
      ).toThrow(RangeError);
    }
    const contaminatedSnapshot = ledger.getState();
    contaminatedSnapshot.dailyPnl = NaN;
    expect(() => new RiskLedger(contaminatedSnapshot)).toThrow(RangeError);
    expect(
      () =>
        new RiskLedger({
          dayKey: todayKey,
          dailyPnl: Number.MAX_VALUE,
          historicalPnl: { [todayKey]: Number.MAX_VALUE },
        }),
    ).toThrow(RangeError);
  });

  it('rejects missing or edited evidence instead of erasing economics while retaining applied keys', () => {
    const ledger = new RiskLedger({ dayKey: todayKey });
    const loss = makeOutcome({ closedAtMs: today, netPnl: -25 });
    ledger.applyTradeClose(loss);
    const snapshot = ledger.getState();
    expect(() => new RiskLedger({ ...snapshot, outcomes: [] })).toThrow(RangeError);
    expect(() => new RiskLedger({ ...snapshot, outcomes: [{ ...loss, netPnl: -1 }] })).toThrow(
      RangeError,
    );
    expect(() => new RiskLedger({ ...snapshot, dailyPnl: 0 })).toThrow(RangeError);
    expect(restart(ledger).getState()).toEqual(snapshot);
  });
});
