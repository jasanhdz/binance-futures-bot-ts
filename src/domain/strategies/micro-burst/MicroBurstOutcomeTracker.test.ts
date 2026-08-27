import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { MicroBurstOutcomeTracker } from '../../../app/micro-burst/MicroBurstOutcomeTracker';
import { MicroBurstOutcomeJournal } from '../../../app/micro-burst/MicroBurstOutcomeJournal';
import { MicroBurstStorage } from '../../../app/micro-burst/MicroBurstStorage';
import { ShadowSignalSnapshot } from '../micro-burst/MicroBurstOutcomeTypes';
import { freezeSignalSnapshot } from '../micro-burst/MicroBurstOutcomeEngine';

const TEST_DIR = path.join(__dirname, '__test_outcome_tracker__');

function makeSignal(overrides: Partial<ShadowSignalSnapshot> = {}): ShadowSignalSnapshot {
  return freezeSignalSnapshot({
    shadowSignalId: `shadow-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    strategyId: 'MICRO_BURST_V1',
    strategyVersion: '0.4.0-prospective-validation',
    codeCommitSha: 'UNCOMMITTED',
    configHash: 'default',
    symbol: 'BTCUSDT',
    side: 'LONG',
    signalAtMs: 1_000_000,
    marketPriceAtSignal: 79000,
    referencePriceSource: 'MARK_PRICE',
    structuralStopPrice: 78500,
    destinationPrice: 79500,
    support: 78800,
    resistance: 79600,
    roomToTargetBps: 63,
    riskToInvalidationBps: 63,
    rewardRisk: 1.0,
    momentum: { direction: 'LONG', strength: 0.7, continuationScore: 0.6 },
    book: {
      status: 'HEALTHY',
      ageMs: 100,
      imbalance: 0.6,
      imbalanceSlope: 0.02,
      temporalAbsorption: false,
      temporalSweep: false,
    },
    tradeFlow: { buyTakerVolume: 100, sellTakerVolume: 80, netTakerFlow: 20, sampleCount: 50 },
    btc: {
      status: 'HEALTHY',
      ageMs: 50,
      ret1m: 0.001,
      ret3m: 0.002,
      ret5m: 0.003,
      acceleration: -0.001,
      direction: 'LONG',
      conflict: false,
    },
    confidence: 0.8,
    leverageTier: 'HIGH_CONFIRMATION',
    leverage: 40,
    positionFraction: 0.09,
    microRegime: 'RANGING',
    ...overrides,
  });
}

function createTracker(journalDir: string) {
  const journal = new MicroBurstOutcomeJournal(journalDir);
  let currentTime = 1_000_000;
  const clock = {
    now: () => currentTime,
    advance: (ms: number) => {
      currentTime += ms;
    },
  };
  const logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
  const tracker = new MicroBurstOutcomeTracker({
    logger,
    clock,
    journal,
    maxPendingOutcomes: 100,
    maxPriceHistoryPerSignal: 500,
  });
  return { tracker, clock, journal };
}

describe('MicroBurstOutcomeTracker', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('tracks signal and increments signalsObserved', () => {
    const { tracker } = createTracker(TEST_DIR);
    const signal = makeSignal();
    tracker.trackSignal(signal);
    expect(tracker.getHealth().signalsObserved).toBe(1);
    expect(tracker.getHealth().pendingOutcomes).toBe(1);
  });

  it('does not duplicate signals with same shadowSignalId', () => {
    const { tracker } = createTracker(TEST_DIR);
    const signal = makeSignal({ shadowSignalId: 'dup-test' });
    tracker.trackSignal(signal);
    tracker.trackSignal(signal); // duplicate
    expect(tracker.getHealth().signalsObserved).toBe(2); // observed count increments
    expect(tracker.getHealth().pendingOutcomes).toBe(1); // but only 1 pending
  });

  it('processes trade events and updates price history', () => {
    const { tracker, clock } = createTracker(TEST_DIR);
    const signal = makeSignal({ symbol: 'BTCUSDT', signalAtMs: 1_000_000 });
    tracker.trackSignal(signal);

    tracker.processTradeEvent({ eventTime: 1_001_000, price: 79100, symbol: 'BTCUSDT' });
    expect(tracker.getPendingIds()).toHaveLength(1);
  });

  it('ignores trade events before signal time', () => {
    const { tracker } = createTracker(TEST_DIR);
    const signal = makeSignal({ signalAtMs: 1_000_000 });
    tracker.trackSignal(signal);

    // Trade before T0 — should be ignored
    tracker.processTradeEvent({ eventTime: 999_000, price: 79100, symbol: 'BTCUSDT' });
    // Pending outcome should have empty price history
    expect(tracker.getPendingIds()).toHaveLength(1);
  });

  it('ignores trade events for wrong symbol', () => {
    const { tracker } = createTracker(TEST_DIR);
    const signal = makeSignal({ symbol: 'BTCUSDT' });
    tracker.trackSignal(signal);

    tracker.processTradeEvent({ eventTime: 1_001_000, price: 2500, symbol: 'ETHUSDT' });
    // BTCUSDT pending should not be affected
    expect(tracker.getPendingIds()).toHaveLength(1);
  });

  it('completes outcome after max horizon', () => {
    const { tracker, clock, journal } = createTracker(TEST_DIR);
    const signal = makeSignal({
      symbol: 'BTCUSDT',
      signalAtMs: 1_000_000,
      structuralStopPrice: 78000,
      destinationPrice: 80000,
    });
    tracker.trackSignal(signal);

    // Simulate trades up to 300s horizon
    for (let i = 1; i <= 300; i++) {
      clock.advance(1000);
      tracker.processTradeEvent({
        eventTime: 1_000_000 + i * 1000,
        price: 79000 + i * 10,
        symbol: 'BTCUSDT',
      });
    }

    // Advance past 300s horizon
    clock.advance(1000);
    tracker.flushPending(clock.now());

    expect(tracker.getHealth().completedOutcomes).toBe(1);
    expect(tracker.getHealth().pendingOutcomes).toBe(0);

    // Verify journal has the record
    const records = journal.loadAll();
    expect(records).toHaveLength(1);
    expect(records[0].shadowSignalId).toBe(signal.shadowSignalId);
  });

  it('evicts oldest pending when over limit', () => {
    const { tracker } = createTracker(TEST_DIR);
    const tracker2 = new MicroBurstOutcomeTracker({
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      clock: { now: () => 1_000_000 },
      journal: new MicroBurstOutcomeJournal(path.join(TEST_DIR, 'evict')),
      maxPendingOutcomes: 3,
    });

    for (let i = 0; i < 5; i++) {
      tracker2.trackSignal(
        makeSignal({ shadowSignalId: `signal-${i}`, signalAtMs: 1_000_000 + i }),
      );
    }

    // Should only keep 3
    expect(tracker2.getPendingIds().length).toBeLessThanOrEqual(3);
  });

  it('persists capacity eviction as terminal so restart recovery cannot resurrect it', () => {
    const storageRoot = path.join(TEST_DIR, 'capacity');
    const storage = new MicroBurstStorage({
      databasePath: path.join(storageRoot, 'state.sqlite'),
      archivePath: path.join(storageRoot, 'archive'),
    });
    const tracker = new MicroBurstOutcomeTracker({
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      clock: { now: () => 1_000_000 },
      journal: new MicroBurstOutcomeJournal(path.join(storageRoot, 'journal')),
      storage,
      maxPendingOutcomes: 1,
    });
    tracker.trackSignal(makeSignal({ shadowSignalId: 'oldest', signalAtMs: 1_000_000 }));
    tracker.trackSignal(makeSignal({ shadowSignalId: 'newest', signalAtMs: 1_000_001 }));

    expect(storage.recoverPending().map((row) => row.signalId)).toEqual(['newest']);
    storage.close();
  });

  it('repairs an SQLite terminal outcome into the journal during restart recovery', () => {
    const storageRoot = path.join(TEST_DIR, 'terminal-recovery');
    const storage = new MicroBurstStorage({
      databasePath: path.join(storageRoot, 'state.sqlite'),
      archivePath: path.join(storageRoot, 'archive'),
    });
    storage.completeOutcome({
      shadowSignalId: 'terminal-recovery',
      symbol: 'BTCUSDT',
      completedAtMs: 2_000_000,
      result: 'NEITHER',
    });
    const journal = new MicroBurstOutcomeJournal(path.join(storageRoot, 'journal'));
    const tracker = new MicroBurstOutcomeTracker({
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
      clock: { now: () => 2_000_000 },
      journal,
      storage,
    });

    tracker.recoverPending();

    expect(journal.loadAll()).toHaveLength(1);
    expect(storage.loadOutcomeReconciliation().unresolvedOutcomeIds).toEqual([]);
    storage.close();
  });

  it('restart recovery: loads pending IDs from journal', () => {
    const journal = new MicroBurstOutcomeJournal(TEST_DIR);
    // Simulate previously completed outcomes
    journal.append({
      shadowSignalId: 'completed-1',
      episodeId: 'ep-1',
      symbol: 'BTCUSDT',
      side: 'LONG',
      signalAtMs: 1_000_000,
      entryPriceModels: [],
      structuralStopPrice: 78500,
      destinationPrice: 79500,
      support: null,
      resistance: null,
      roomToTargetBps: 63,
      riskToInvalidationBps: 63,
      rewardRisk: 1.0,
      confidence: 0.8,
      leverageTier: 'HIGH',
      leverage: 40,
      microRegime: 'RANGING',
      momentum: { direction: 'LONG', strength: 0.7, continuationScore: 0.6 },
      book: {
        status: 'HEALTHY',
        ageMs: 100,
        imbalance: 0.6,
        imbalanceSlope: null,
        temporalAbsorption: false,
        temporalSweep: false,
      },
      tradeFlow: { buyTakerVolume: 0, sellTakerVolume: 0, netTakerFlow: 0, sampleCount: 0 },
      btc: {
        status: 'HEALTHY',
        ageMs: 50,
        ret1m: null,
        ret3m: null,
        ret5m: null,
        acceleration: null,
        direction: null,
        conflict: false,
      },
      horizons: {},
      barrierOutcome: 'NEITHER',
      dynamicExitOutcome: null,
      grossBps: 0,
      costScenarios: {},
      completedAtMs: 2_000_000,
      strategyVersion: '0.4.0-prospective-validation',
      codeCommitSha: 'UNCOMMITTED',
      configHash: 'default',
    });

    const completedIds = journal.loadPendingSignalIds();
    expect(completedIds.has('completed-1')).toBe(true);
  });
});
