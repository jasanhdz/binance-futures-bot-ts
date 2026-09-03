import { describe, expect, it } from 'vitest';
import { ShadowTradingEngine } from './ShadowTradingEngine';
import { ShadowJournal } from './ShadowTradeJournal';
import {
  ShadowPolicyDecision,
  ShadowPosition,
  ShadowStrategyPolicy,
  ShadowTradeEvent,
} from './ShadowTradingTypes';
import { shadowPositionKey } from './ShadowPositionKey';

class MemoryJournal implements ShadowJournal {
  positions: ShadowPosition[] = [];
  events: ShadowTradeEvent[] = [];
  positionWrites = 0;
  appendPosition(position: ShadowPosition): void {
    this.positionWrites += 1;
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

class FailingJournal extends MemoryJournal {
  failPosition = false;
  failEvent = false;
  appendPosition(position: ShadowPosition): void {
    if (this.failPosition) throw new Error('position_write_failed');
    super.appendPosition(position);
  }
  appendEvent(event: ShadowTradeEvent): void {
    if (this.failEvent) throw new Error('event_write_failed');
    super.appendEvent(event);
  }
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
const policyDecision = (decision: ShadowPolicyDecision): ShadowStrategyPolicy => ({
  strategyId: 'MOMENTUM_RIDE',
  evaluateLifecycle: () => decision,
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

  it('does not expose an in-memory position when canonical open persistence fails', () => {
    const journal = new FailingJournal();
    journal.failPosition = true;
    const engine = new ShadowTradingEngine(
      journal,
      new Map([['MOMENTUM_RIDE', holdPolicy('MOMENTUM_RIDE')]]),
    );
    expect(engine.open(intent('MOMENTUM_RIDE', 'BTCUSDT', 'LONG'), quote).status).toBe(
      'RECOVERY_BLOCKED',
    );
    expect(engine.getOpenPositions()).toHaveLength(0);
    expect(engine.open(intent('MOMENTUM_RIDE', 'BTCUSDT', 'LONG'), quote).status).toBe(
      'RECOVERY_BLOCKED',
    );
  });

  it('keeps the canonical state when only auxiliary event persistence fails', () => {
    const journal = new FailingJournal();
    journal.failEvent = true;
    const engine = new ShadowTradingEngine(
      journal,
      new Map([['MOMENTUM_RIDE', holdPolicy('MOMENTUM_RIDE')]]),
    );
    expect(engine.open(intent('MOMENTUM_RIDE', 'BTCUSDT', 'LONG'), quote).status).toBe('OPENED');
    expect(engine.getOpenPositions()).toHaveLength(1);
    expect(engine.getAuxiliaryEventFailureCount()).toBe(1);
  });

  it('uses executable entry for positive MFE and adverse MAE on both sides', () => {
    const journal = new MemoryJournal();
    const policies = new Map([['MOMENTUM_RIDE', holdPolicy('MOMENTUM_RIDE')]] as const);
    const engine = new ShadowTradingEngine(journal, policies);
    engine.open(intent('MOMENTUM_RIDE', 'BTCUSDT', 'LONG'), quote);
    engine.manage(
      { strategyId: 'MOMENTUM_RIDE', symbol: 'BTCUSDT' },
      { exchangeTimeMs: 2, receivedAtMs: 2_000, currentPrice: 103, marketDataQuality: 'HEALTHY' },
    );
    engine.manage(
      { strategyId: 'MOMENTUM_RIDE', symbol: 'BTCUSDT' },
      { exchangeTimeMs: 3, receivedAtMs: 3_000, currentPrice: 98, marketDataQuality: 'HEALTHY' },
    );
    const long = engine.getOpenPositions()[0];
    expect(long.entryPrice).toBe(101);
    expect(long.mfeBps).toBeCloseTo((2 / 101) * 10_000);
    expect(long.maeBps).toBeCloseTo((3 / 101) * 10_000);

    const shortEngine = new ShadowTradingEngine(new MemoryJournal(), policies);
    shortEngine.open(intent('MOMENTUM_RIDE', 'ETHUSDT', 'SHORT'), quote);
    shortEngine.manage(
      { strategyId: 'MOMENTUM_RIDE', symbol: 'ETHUSDT' },
      { exchangeTimeMs: 2, receivedAtMs: 2_000, currentPrice: 96, marketDataQuality: 'HEALTHY' },
    );
    shortEngine.manage(
      { strategyId: 'MOMENTUM_RIDE', symbol: 'ETHUSDT' },
      { exchangeTimeMs: 3, receivedAtMs: 3_000, currentPrice: 102, marketDataQuality: 'HEALTHY' },
    );
    const short = shortEngine.getOpenPositions()[0];
    expect(short.mfeBps).toBeCloseTo((3 / 99) * 10_000);
    expect(short.maeBps).toBeCloseTo((3 / 99) * 10_000);
    expect(short.mfeBps).toBeGreaterThanOrEqual(0);
    expect(short.maeBps).toBeGreaterThanOrEqual(0);
  });

  it('rejects stop loosening and invalid stop requests', () => {
    const policy = (decision: ShadowPolicyDecision): ShadowStrategyPolicy => ({
      strategyId: 'MOMENTUM_RIDE',
      evaluateLifecycle: () => decision,
    });
    const longEngine = new ShadowTradingEngine(
      new MemoryJournal(),
      new Map([['MOMENTUM_RIDE', policy({ action: 'MOVE_STOP', stop: 95 })]] as const),
    );
    longEngine.open(intent('MOMENTUM_RIDE', 'BTCUSDT', 'LONG'), quote);
    const tightened = longEngine.manage(
      { strategyId: 'MOMENTUM_RIDE', symbol: 'BTCUSDT' },
      { exchangeTimeMs: 1, receivedAtMs: 1_000, currentPrice: 101, marketDataQuality: 'HEALTHY' },
    );
    expect(tightened?.stop).toBe(95);
    const looseLong = new ShadowTradingEngine(
      new MemoryJournal(),
      new Map([['MOMENTUM_RIDE', policy({ action: 'MOVE_STOP', stop: 94 })]] as const),
    );
    looseLong.open({ ...intent('MOMENTUM_RIDE', 'ETHUSDT', 'LONG'), structuralStop: 95 }, quote);
    expect(
      looseLong.manage(
        { strategyId: 'MOMENTUM_RIDE', symbol: 'ETHUSDT' },
        { exchangeTimeMs: 1, receivedAtMs: 1_000, currentPrice: 101, marketDataQuality: 'HEALTHY' },
      )?.stop,
    ).toBe(95);
    const invalid = new ShadowTradingEngine(
      new MemoryJournal(),
      new Map([['MOMENTUM_RIDE', policy({ action: 'MOVE_STOP', stop: Number.NaN })]] as const),
    );
    invalid.open(intent('MOMENTUM_RIDE', 'SOLUSDT', 'LONG'), quote);
    expect(
      invalid.manage(
        { strategyId: 'MOMENTUM_RIDE', symbol: 'SOLUSDT' },
        { exchangeTimeMs: 1, receivedAtMs: 1_000, currentPrice: 101, marketDataQuality: 'HEALTHY' },
      )?.stop,
    ).toBe(90);
  });

  it('keeps the previous canonical state when manage persistence fails', () => {
    const journal = new FailingJournal();
    const engine = new ShadowTradingEngine(
      journal,
      new Map([['MOMENTUM_RIDE', holdPolicy('MOMENTUM_RIDE')]]),
    );
    engine.open(intent('MOMENTUM_RIDE', 'BTCUSDT', 'LONG'), quote);
    journal.failPosition = true;
    const before = engine.getOpenPositions()[0];
    const after = engine.manage(
      { strategyId: 'MOMENTUM_RIDE', symbol: 'BTCUSDT' },
      { exchangeTimeMs: 2, receivedAtMs: 2_000, currentPrice: 103, marketDataQuality: 'HEALTHY' },
    );
    expect(after).toEqual(before);
    expect(engine.getOpenPositions()[0]).toEqual(before);
  });

  it('fails closed when stop or close persistence fails', () => {
    const stopJournal = new FailingJournal();
    const stopEngine = new ShadowTradingEngine(
      stopJournal,
      new Map([['MOMENTUM_RIDE', policyDecision({ action: 'MOVE_STOP', stop: 95 })]] as const),
    );
    stopEngine.open(intent('MOMENTUM_RIDE', 'BTCUSDT', 'LONG'), quote);
    stopJournal.failPosition = true;
    expect(
      stopEngine.manage(
        { strategyId: 'MOMENTUM_RIDE', symbol: 'BTCUSDT' },
        { exchangeTimeMs: 2, receivedAtMs: 2_000, currentPrice: 101, marketDataQuality: 'HEALTHY' },
      )?.stop,
    ).toBe(90);

    const closeJournal = new FailingJournal();
    const closeEngine = new ShadowTradingEngine(
      closeJournal,
      new Map([['MOMENTUM_RIDE', policyDecision({ action: 'CLOSE', reason: 'TARGET' })]] as const),
    );
    closeEngine.open(intent('MOMENTUM_RIDE', 'ETHUSDT', 'LONG'), quote);
    closeJournal.failPosition = true;
    expect(
      closeEngine.manage(
        { strategyId: 'MOMENTUM_RIDE', symbol: 'ETHUSDT' },
        {
          exchangeTimeMs: 2,
          receivedAtMs: 2_000,
          currentPrice: 101,
          quote,
          marketDataQuality: 'HEALTHY',
        },
      )?.state,
    ).toBe('OPEN_SHADOW');
    expect(closeEngine.getOpenPositions()).toHaveLength(1);
  });

  it('does not flood the journal with unchanged HOLD checkpoints', () => {
    const journal = new MemoryJournal();
    const engine = new ShadowTradingEngine(
      journal,
      new Map([['MOMENTUM_RIDE', holdPolicy('MOMENTUM_RIDE')]]),
    );
    engine.open(intent('MOMENTUM_RIDE', 'BTCUSDT', 'LONG'), quote);
    const writesAfterOpen = journal.positionWrites;
    engine.manage(
      { strategyId: 'MOMENTUM_RIDE', symbol: 'BTCUSDT' },
      { exchangeTimeMs: 2, receivedAtMs: 2_000, currentPrice: 103, marketDataQuality: 'HEALTHY' },
    );
    engine.manage(
      { strategyId: 'MOMENTUM_RIDE', symbol: 'BTCUSDT' },
      { exchangeTimeMs: 3, receivedAtMs: 3_000, currentPrice: 103, marketDataQuality: 'HEALTHY' },
    );
    expect(journal.positionWrites).toBe(writesAfterOpen + 1);
  });

  it('persists policy diagnostics on the canonical position and lifecycle event', () => {
    const journal = new MemoryJournal();
    const policy: ShadowStrategyPolicy = {
      strategyId: 'MOMENTUM_RIDE',
      evaluateLifecycle: () => ({
        action: 'MOVE_STOP',
        stop: 95,
        reason: 'PROFIT_LOCK',
        diagnostics: { exitPolicyVersion: 'EXPECTED_CONTINUATION_V2', exitPressure: 0.25 },
      }),
    };
    const engine = new ShadowTradingEngine(journal, new Map([['MOMENTUM_RIDE', policy]] as const));
    engine.open(intent('MOMENTUM_RIDE', 'BTCUSDT', 'LONG'), quote);
    const managed = engine.manage(
      { strategyId: 'MOMENTUM_RIDE', symbol: 'BTCUSDT' },
      { exchangeTimeMs: 2, receivedAtMs: 2_000, currentPrice: 101, marketDataQuality: 'HEALTHY' },
    );

    expect(managed?.latestManagementDecision).toMatchObject({
      action: 'MOVE_STOP',
      reason: 'PROFIT_LOCK',
      diagnostics: { exitPolicyVersion: 'EXPECTED_CONTINUATION_V2', exitPressure: 0.25 },
    });
    expect(journal.events[journal.events.length - 1]?.metadata).toMatchObject({
      latestManagementDecision: {
        diagnostics: { exitPolicyVersion: 'EXPECTED_CONTINUATION_V2', exitPressure: 0.25 },
      },
    });
  });
});
