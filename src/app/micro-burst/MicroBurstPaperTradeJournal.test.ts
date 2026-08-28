import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MicroBurstPaperTradeJournal } from './MicroBurstPaperTradeJournal';

const roots: string[] = [];
afterEach(() =>
  roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })),
);

function position(tradeId: string, symbol: string) {
  return {
    schemaVersion: 1 as const,
    state: 'OPEN_SHADOW' as const,
    tradeId,
    parentSignalId: tradeId,
    strategyId: 'MICRO_BURST_V1' as const,
    strategyVersion: 'V1',
    symbol,
    side: 'LONG' as const,
    openedAtMs: 1_000,
    entryDecisionPrice: 100,
    entryExecutablePrice: 101,
    entryPrice: 101,
    entryPriceModel: 'BEST_ASK' as const,
    leverage: 1,
    positionFraction: 0.1,
    initialStructuralStop: 99,
    currentStop: 99,
    destinationPrice: 110,
    peakPrice: 101,
    troughPrice: 101,
    breakEvenArmed: false,
    trailingActivated: false,
    lastObservedAtMs: 1_000,
    cohortId: 'C',
    codeCommitSha: 'S',
    configHash: 'H',
    spreadBps: 10,
    slippageBps: 0,
  };
}

describe('MicroBurstPaperTradeJournal recovery', () => {
  it('blocks duplicate durable open positions for one symbol', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'micro-burst-paper-journal-'));
    roots.push(root);
    const journal = new MicroBurstPaperTradeJournal(root);
    journal.appendPosition(position('P-1', 'ETHUSDT'));
    journal.appendPosition(position('P-2', 'ETHUSDT'));
    expect(() => journal.loadOpenPositions()).toThrow('PAPER_POSITION_AMBIGUOUS:ETHUSDT');
  });
});
