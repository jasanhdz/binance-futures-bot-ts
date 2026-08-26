import { describe, expect, it } from 'vitest';
import { StrategyRiskLedger } from './StrategyRiskLedger';

describe('StrategyRiskLedger', () => {
  it('isolates opens and losses by strategy', () => {
    const ledger = new StrategyRiskLedger();
    const now = Date.UTC(2026, 7, 26, 12);

    ledger.recordOpen('AEGIS_TURBO', now);
    ledger.recordClose('AEGIS_TURBO', 'AEGIS-TURBO-1', -1, now + 1);

    expect(ledger.snapshot('AEGIS_TURBO', now + 2)).toMatchObject({
      tradesToday: 1,
      consecutiveLosses: 1,
    });
    expect(ledger.snapshot('MOMENTUM_RIDE', now + 2)).toMatchObject({
      tradesToday: 0,
      consecutiveLosses: 0,
    });
  });

  it('restores strategy-specific streaks without inventing opens from closes', () => {
    const ledger = new StrategyRiskLedger();
    const now = Date.UTC(2026, 7, 26, 12);

    ledger.restoreClosedOutcomes([
      { tradeId: 'AEGIS-TURBO-1', closedAt: new Date(now - 2).toISOString(), pnlUsdt: -1 },
      { tradeId: 'MOMENTUM-RIDE-1', closedAt: new Date(now - 1).toISOString(), pnlUsdt: -2 },
    ], now);

    expect(ledger.snapshot('AEGIS_TURBO', now)).toMatchObject({ tradesToday: 0, consecutiveLosses: 1 });
    expect(ledger.snapshot('MOMENTUM_RIDE', now)).toMatchObject({ tradesToday: 0, consecutiveLosses: 1 });
    expect(ledger.timeSinceLastLossMs('MOMENTUM_RIDE', now)).toBe(1);
  });

  it('deduplicates reconstructed closes by trade id', () => {
    const ledger = new StrategyRiskLedger();
    const closedAt = new Date(Date.UTC(2026, 7, 26, 12)).toISOString();
    const outcome = { tradeId: 'MOMENTUM-RIDE-1', closedAt, pnlUsdt: -1 };

    ledger.restoreClosedOutcomes([outcome, outcome], Date.parse(closedAt));

    expect(ledger.snapshot('MOMENTUM_RIDE', Date.parse(closedAt)).consecutiveLosses).toBe(1);
  });
});
