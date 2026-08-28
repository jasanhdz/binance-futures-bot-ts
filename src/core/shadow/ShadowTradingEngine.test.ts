import { describe, expect, it } from 'vitest';
import { ShadowTradingEngine } from './ShadowTradingEngine';
import { ShadowJournal } from './ShadowTradeJournal';
import { ShadowPosition, ShadowStrategyPolicy, ShadowTradeEvent } from './ShadowTradingTypes';
import { shadowPositionKey } from './ShadowPositionKey';

class MemoryJournal implements ShadowJournal {
  positions: ShadowPosition[] = [];
  events: ShadowTradeEvent[] = [];
  appendPosition(position: ShadowPosition): void {
    this.positions = [...this.positions.filter((p) => p.tradeId !== position.tradeId), position];
  }
  appendEvent(event: ShadowTradeEvent): void {
    this.events.push(event);
  }
  loadOpenPositions(): ShadowPosition[] {
    return this.positions.filter((p) => p.state !== 'CLOSED');
  }
  loadAllPositions(): ShadowPosition[] {
    return this.positions;
  }
  loadAllEvents(): ShadowTradeEvent[] {
    return this.events;
  }
  getHealth(): { healthy: boolean; malformedCount: number } {
    return { healthy: true, malformedCount: 0 };
  }
  flush(): void {}
}

const provenance = { strategyVersion: 'test', codeCommitSha: 'test' };
const quote = { bestBid: 99, bestAsk: 101, observedAtMs: 1000, status: 'HEALTHY' as const };
function intent(
  strategyId: 'AEGIS_TURBO' | 'MOMENTUM_RIDE' | 'MICRO_BURST_V1',
  symbol: string,
  side: 'LONG' | 'SHORT',
) {
  return {
    strategyId,
    strategyVersion: 'test',
    symbol,
    side,
    decisionAtMs: 1000,
    decisionReceivedAtMs: 1000,
    referencePrice: 100,
    structuralStop: side === 'LONG' ? 90 : 110,
    destination: side === 'LONG' ? 110 : 90,
    parentDecisionId: `${strategyId}-${symbol}-${side}`,
    provenance,
  };
}
const holdPolicy = (strategyId: ShadowStrategyPolicy['strategyId']): ShadowStrategyPolicy => ({
  strategyId,
  evaluateLifecycle: () => ({ action: 'HOLD' }),
});

describe('ShadowTradingEngine', () => {
  it('locks only strategyId plus symbol and permits cross-strategy coexistence', () => {
    const journal = new MemoryJournal();
    const policies = new Map([
      ['AEGIS_TURBO', holdPolicy('AEGIS_TURBO')],
      ['MOMENTUM_RIDE', holdPolicy('MOMENTUM_RIDE')],
      ['MICRO_BURST_V1', holdPolicy('MICRO_BURST_V1')],
    ] as const);
    const engine = new ShadowTradingEngine(journal, policies);
    expect(engine.open(intent('AEGIS_TURBO', 'BTCUSDT', 'LONG'), quote).status).toBe('OPENED');
    expect(engine.open(intent('AEGIS_TURBO', 'BTCUSDT', 'SHORT'), quote).status).toBe('SUPPRESSED');
    expect(engine.open(intent('MOMENTUM_RIDE', 'BTCUSDT', 'SHORT'), quote).status).toBe('OPENED');
    expect(engine.open(intent('MICRO_BURST_V1', 'BTCUSDT', 'LONG'), quote).status).toBe('OPENED');
    expect(engine.open(intent('AEGIS_TURBO', 'ETHUSDT', 'LONG'), quote).status).toBe('OPENED');
    expect(engine.getOpenPositions()).toHaveLength(4);
  });

  it('restores independent positions and isolates ambiguity by key', () => {
    const journal = new MemoryJournal();
    const policies = new Map([
      ['AEGIS_TURBO', holdPolicy('AEGIS_TURBO')],
      ['MOMENTUM_RIDE', holdPolicy('MOMENTUM_RIDE')],
      ['MICRO_BURST_V1', holdPolicy('MICRO_BURST_V1')],
    ] as const);
    const first = new ShadowTradingEngine(journal, policies);
    for (const id of ['AEGIS_TURBO', 'MOMENTUM_RIDE', 'MICRO_BURST_V1'] as const)
      first.open(intent(id, 'BTCUSDT', 'LONG'), quote);
    expect(new ShadowTradingEngine(journal, policies).getOpenPositions()).toHaveLength(3);
    const duplicate = { ...journal.positions[0], tradeId: 'duplicate' };
    journal.positions.push(duplicate);
    const recovered = new ShadowTradingEngine(journal, policies);
    expect(recovered.getOpenPositions()).toHaveLength(2);
    expect(recovered.open(intent('AEGIS_TURBO', 'BTCUSDT', 'LONG'), quote).status).toBe(
      'RECOVERY_BLOCKED',
    );
    expect(recovered.open(intent('MOMENTUM_RIDE', 'BTCUSDT', 'LONG'), quote).status).toBe(
      'SUPPRESSED',
    );
    expect(shadowPositionKey('MOMENTUM_RIDE', 'btcusdt').symbol).toBe('BTCUSDT');
  });

  it('uses causal executable bid/ask prices and never calls a live boundary', () => {
    const journal = new MemoryJournal();
    const engine = new ShadowTradingEngine(
      journal,
      new Map([['MOMENTUM_RIDE', holdPolicy('MOMENTUM_RIDE')]]),
    );
    const opened = engine.open(intent('MOMENTUM_RIDE', 'BTCUSDT', 'LONG'), quote);
    expect(opened.status === 'OPENED' && opened.position.entryExecutablePrice).toBe(101);
    expect(
      engine.open(
        { ...intent('MOMENTUM_RIDE', 'ETHUSDT', 'SHORT'), decisionReceivedAtMs: 999 },
        quote,
      ).status,
    ).toBe('DATA_UNCERTAIN');
  });
});
