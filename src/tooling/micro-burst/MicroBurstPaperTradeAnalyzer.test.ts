import { describe, expect, it } from 'vitest';
import { analyzeMicroBurstPaperTrades } from './MicroBurstPaperTradeAnalyzer';
import { MicroBurstPaperPosition } from '../../strategies/micro-burst/research/MicroBurstPaperTrading';

function trade(overrides: Partial<MicroBurstPaperPosition> = {}): MicroBurstPaperPosition {
  return {
    schemaVersion: 1,
    state: 'CLOSED',
    tradeId: 'T',
    parentSignalId: 'S',
    strategyId: 'MICRO_BURST_V1',
    strategyVersion: 'V',
    symbol: 'ETHUSDT',
    side: 'LONG',
    openedAtMs: 0,
    closedAtMs: 1000,
    entryDecisionPrice: 100,
    entryExecutablePrice: 101,
    entryPrice: 101,
    entryPriceModel: 'BEST_ASK',
    leverage: 10,
    positionFraction: 0.1,
    initialStructuralStop: 95,
    currentStop: 95,
    finalStop: 95,
    destinationPrice: 110,
    peakPrice: 105,
    troughPrice: 99,
    breakEvenArmed: true,
    lastObservedAtMs: 1000,
    cohortId: 'C',
    codeCommitSha: 'S',
    configHash: 'H',
    spreadBps: 1,
    slippageBps: 0,
    exitReason: 'TARGET',
    grossPriceReturnBps: 100,
    grossRoe: 0.1,
    mfeBps: 400,
    maeBps: 100,
    feesBps: 2,
    spreadImpactBps: 0,
    otherCostsBps: 0,
    totalCostBps: 2,
    netBps: 98,
    netRoe: 0.098,
    ...overrides,
  };
}

describe('MicroBurst paper trade analyzer', () => {
  it('deduplicates trade snapshots and reports sample size and costs', () => {
    const report = analyzeMicroBurstPaperTrades(
      [trade(), trade({ tradeId: 'T', netBps: -2, grossPriceReturnBps: -1 })],
      3,
      1,
    );
    expect(report.sampleSize).toBe(1);
    expect(report.netWinRate).toBe(0);
    expect(report.suppressedEntryCount).toBe(3);
    expect(report.incompleteCount).toBe(1);
  });

  it('derives suppression and incomplete metrics from lifecycle events', () => {
    const report = analyzeMicroBurstPaperTrades(
      [trade({ state: 'OPEN_SHADOW', tradeId: 'OPEN' })],
      0,
      0,
      [
        {
          schemaVersion: 1,
          event: 'ENTRY_SUPPRESSED_POSITION_OPEN',
          eventAtMs: 1,
          symbol: 'ETHUSDT',
          state: 'OPEN_SHADOW',
        },
        {
          schemaVersion: 1,
          event: 'UNFILLED_DATA_UNCERTAIN',
          eventAtMs: 2,
          symbol: 'BTCUSDT',
          state: 'DATA_UNCERTAIN',
        },
      ],
    );
    expect(report.suppressedEntryCount).toBe(1);
    expect(report.incompleteCount).toBe(2);
    expect(report.openCount).toBe(1);
    expect(report.scenarioMetrics.cost_30.netWinRate).toBeNull();
  });

  it('deduplicates canonical incomplete states and does not fabricate cost zeroes', () => {
    const report = analyzeMicroBurstPaperTrades([
      trade({
        state: 'DATA_UNCERTAIN',
        tradeId: 'UNCERTAIN',
        feesBps: undefined,
        netBps: undefined,
      }),
    ]);
    expect(report.dataUncertainTradeCount).toBe(1);
    expect(report.incompleteCanonicalTradeCount).toBe(1);
    expect(report.costBps.total).toBeNull();
  });
});
