import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ShadowTradingEngine } from './ShadowTradingEngine';
import { FileShadowTradeJournal } from './ShadowTradeJournal';
import { ShadowStrategyPolicy } from './ShadowTradingTypes';
import { shadowPositionKey } from './ShadowPositionKey';

const roots: string[] = [];
const quote = { bestBid: 99, bestAsk: 101, observedAtMs: 2, status: 'HEALTHY' as const };
const intent = {
  strategyId: 'MOMENTUM_RIDE' as const,
  strategyVersion: 'v1',
  symbol: 'BTCUSDT',
  side: 'LONG' as const,
  decisionAtMs: 86_400_000,
  decisionReceivedAtMs: 86_400_000,
  referencePrice: 100,
  structuralStop: 90,
  destination: 110,
  parentDecisionId: 'day-one',
  provenance: { strategyVersion: 'v1', codeCommitSha: 'sha' },
};

function root(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-journal-'));
  roots.push(value);
  return value;
}

afterEach(() => {
  for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true });
});

describe('FileShadowTradeJournal', () => {
  it('retains the latest CLOSED record across restart and daily files', () => {
    const dir = root();
    const journal = new FileShadowTradeJournal(path.join(dir, 'trades'), path.join(dir, 'events'));
    const close: ShadowStrategyPolicy = {
      strategyId: 'MOMENTUM_RIDE',
      evaluateLifecycle: () => ({ action: 'CLOSE', reason: 'TARGET' }),
    };
    const engine = new ShadowTradingEngine(journal, new Map([['MOMENTUM_RIDE', close]]));
    expect(
      engine.open(intent, { ...quote, observedAtMs: intent.decisionReceivedAtMs }).status,
    ).toBe('OPENED');
    engine.manage(
      { strategyId: 'MOMENTUM_RIDE', symbol: 'BTCUSDT' },
      {
        exchangeTimeMs: 172_800_001,
        receivedAtMs: 172_800_001,
        currentPrice: 101,
        quote: { ...quote, observedAtMs: 172_800_001 },
        marketDataQuality: 'HEALTHY',
      },
    );
    const restarted = new FileShadowTradeJournal(
      path.join(dir, 'trades'),
      path.join(dir, 'events'),
    );
    expect(restarted.loadAllPositions()).toHaveLength(1);
    expect(restarted.loadAllPositions()[0].state).toBe('CLOSED');
    expect(restarted.loadOpenPositions()).toHaveLength(0);
  });

  it('isolates duplicate open records by canonical key', () => {
    const dir = root();
    const journal = new FileShadowTradeJournal(path.join(dir, 'trades'), path.join(dir, 'events'));
    const first = { ...intent, parentDecisionId: 'one' };
    const second = { ...intent, parentDecisionId: 'two' };
    const policy: ShadowStrategyPolicy = {
      strategyId: 'MOMENTUM_RIDE',
      evaluateLifecycle: () => ({ action: 'HOLD' }),
    };
    const engine = new ShadowTradingEngine(journal, new Map([['MOMENTUM_RIDE', policy]]));
    engine.open(first, { ...quote, observedAtMs: first.decisionReceivedAtMs });
    engine.open(
      { ...second, symbol: 'ETHUSDT' },
      { ...quote, observedAtMs: second.decisionReceivedAtMs },
    );
    journal.appendPosition({ ...journal.loadAllPositions()[0], tradeId: 'duplicate' });
    const recovered = new ShadowTradingEngine(journal, new Map([['MOMENTUM_RIDE', policy]]));
    expect(
      recovered.open(first, { ...quote, observedAtMs: first.decisionReceivedAtMs }).status,
    ).toBe('RECOVERY_BLOCKED');
    expect(
      recovered.open(
        { ...second, symbol: 'ETHUSDT' },
        { ...quote, observedAtMs: second.decisionReceivedAtMs },
      ).status,
    ).toBe('SUPPRESSED');
    expect(shadowPositionKey('MOMENTUM_RIDE', 'ETHUSDT').symbol).toBe('ETHUSDT');
  });
});
