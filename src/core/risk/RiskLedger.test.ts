import { describe, expect, it } from 'vitest';
import { RiskLedger, TradeOutcome } from './RiskLedger';

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
    closedAtMs: 1_700_000_000_000,
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

  it('rolls over day and resets counters', () => {
    const ledger = new RiskLedger({ dayKey: '2026-09-04' });
    ledger.applyTradeClose(makeOutcome({ tradeId: 'T1', netPnl: 10, closedAtMs: 1_756_934_400_000 }));
    expect(ledger.getState().tradesToday).toBe(1);

    // Apply trade on next day (+1 day in ms).
    const nextDay = ledger.applyTradeClose(
      makeOutcome({ tradeId: 'T2', netPnl: 5, closedAtMs: 1_756_934_400_000 + 86_400_000 }),
    );
    expect(nextDay).toBe(true);
    const state = ledger.getState();
    expect(state.dayKey).not.toBe('2026-09-04'); // Day rolled over.
    expect(state.tradesToday).toBe(1); // Reset.
    expect(state.dailyPnl).toBeCloseTo(5); // Reset.
    expect(state.consecutiveLosses).toBe(0); // Reset.
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
});
