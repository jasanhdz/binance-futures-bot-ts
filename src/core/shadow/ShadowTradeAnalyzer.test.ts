import { describe, expect, it } from 'vitest';
import { analyzeShadow } from './ShadowTradeAnalyzer';
import { shadowPositionKey } from './ShadowPositionKey';
import { ShadowPosition, ShadowTradeEvent } from './ShadowTradingTypes';

const position = (strategyId: 'AEGIS_TURBO' | 'MOMENTUM_RIDE'): ShadowPosition => ({
  schemaVersion: 2,
  key: shadowPositionKey(strategyId, 'BTCUSDT'),
  strategyId,
  strategyVersion: 'v1',
  symbol: 'BTCUSDT',
  side: 'LONG',
  tradeId: `${strategyId}-1`,
  parentDecisionId: 'decision-1',
  decisionAtMs: 1,
  decisionReceivedAtMs: 1,
  openedAtMs: 1,
  openedReceivedAtMs: 1,
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
  closedReceivedAtMs: 2,
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

  it('deduplicates snapshots and separates uncertainty categories', () => {
    const uncertain = {
      ...position('AEGIS_TURBO'),
      tradeId: 'uncertain',
      state: 'DATA_UNCERTAIN' as const,
    };
    const events: ShadowTradeEvent[] = [
      {
        schemaVersion: 1,
        event: 'UNFILLED_DATA_UNCERTAIN',
        eventAtMs: 3,
        strategyId: 'AEGIS_TURBO',
        symbol: 'BTCUSDT',
        state: 'DATA_UNCERTAIN',
        parentDecisionId: 'candidate-1',
      },
      {
        schemaVersion: 1,
        event: 'UNFILLED_DATA_UNCERTAIN',
        eventAtMs: 4,
        strategyId: 'AEGIS_TURBO',
        symbol: 'BTCUSDT',
        state: 'DATA_UNCERTAIN',
        parentDecisionId: 'candidate-1',
      },
      {
        schemaVersion: 1,
        event: 'RECOVERY_BLOCKED',
        eventAtMs: 5,
        strategyId: 'AEGIS_TURBO',
        symbol: 'BTCUSDT',
        state: 'RECOVERY_BLOCKED',
      },
      {
        schemaVersion: 1,
        event: 'RECOVERY_BLOCKED',
        eventAtMs: 6,
        strategyId: 'AEGIS_TURBO',
        symbol: 'BTCUSDT',
        state: 'RECOVERY_BLOCKED',
      },
    ];
    const report = analyzeShadow([uncertain, uncertain], events, { strategyId: 'AEGIS_TURBO' });
    expect(report.completedTrades).toBe(0);
    expect(report.dataUncertainTrades).toBe(1);
    expect(report.unfilledDataUncertainCandidates).toBe(1);
    expect(report.recoveryBlockedKeys).toBe(1);
    expect(report.dataUncertain).toBe(1);
  });
});
