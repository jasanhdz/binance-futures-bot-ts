import { describe, expect, it } from 'vitest';
import { analyzeMicroBurstPaperTrades } from './MicroBurstPaperTradeAnalyzer';
import { MicroBurstPaperPosition } from '../../domain/strategies/micro-burst/MicroBurstPaperTrading';

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
    trailingActivated: false,
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
});
