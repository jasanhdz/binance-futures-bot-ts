import { describe, expect, it } from 'vitest';
import { analyzeShadow } from './ShadowTradeAnalyzer';
import { shadowPositionKey } from './ShadowPositionKey';
import { ShadowPosition, ShadowTradeEvent } from './ShadowTradingTypes';

const position = (strategyId: 'AEGIS_TURBO' | 'MOMENTUM_RIDE'): ShadowPosition => ({
  schemaVersion: 1,
  key: shadowPositionKey(strategyId, 'BTCUSDT'),
  strategyId,
  strategyVersion: 'v1',
  symbol: 'BTCUSDT',
  side: 'LONG',
  tradeId: `${strategyId}-1`,
  parentDecisionId: 'decision-1',
  openedAtMs: 1,
  entryDecisionPrice: 100,
  entryExecutablePrice: 101,
  entryPrice: 101,
  state: 'CLOSED',
  lastObservedAtMs: 2,
  peakPrice: 103,
  troughPrice: 99,
  mfeBps: 198,
  maeBps: 198,
  closedAtMs: 2,
  exitExecutablePrice: 102,
  exitReason: 'TARGET',
  grossBps: 99,
  netBpsByCostScenario: { cost_0: 99, cost_10: 89 },
  provenance: { strategyVersion: 'v1', codeCommitSha: 'sha' },
});

describe('analyzeShadow', () => {
  it('filters by strategy and preserves independent scenario metrics', () => {
    const events: ShadowTradeEvent[] = [
      {
        schemaVersion: 1,
        event: 'ENTRY_SUPPRESSED',
        eventAtMs: 3,
        strategyId: 'AEGIS_TURBO',
        symbol: 'BTCUSDT',
        state: 'OPEN_SHADOW',
        tradeId: 'AEGIS_TURBO-1',
      },
    ];
    const report = analyzeShadow([position('AEGIS_TURBO'), position('MOMENTUM_RIDE')], events, {
      strategyId: 'AEGIS_TURBO',
    });
    expect(report.completedTrades).toBe(1);
    expect(report.grossBps).toEqual([99]);
    expect(report.netBpsByScenario).toEqual({ cost_0: [99], cost_10: [89] });
    expect(report.suppressionCount).toBe(1);
  });
});
