import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { MicroBurstOutcomeJournal } from '../../../app/micro-burst/MicroBurstOutcomeJournal';
import { ProspectiveOutcomeRecord } from '../micro-burst/MicroBurstOutcomeTypes';

const TEST_DIR = path.join(__dirname, '__test_outcome_journal__');

function makeRecord(overrides: Partial<ProspectiveOutcomeRecord> = {}): ProspectiveOutcomeRecord {
  return {
    shadowSignalId: `shadow-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    episodeId: 'episode-1',
    symbol: 'BTCUSDT',
    side: 'LONG',
    signalAtMs: 1_000_000,
    entryPriceModels: [{ model: 'SIGNAL_PRICE', entryPrice: 79000 }],
    structuralStopPrice: 78500,
    destinationPrice: 79500,
    support: 78800,
    resistance: 79600,
    roomToTargetBps: 63,
    riskToInvalidationBps: 63,
    rewardRisk: 1.0,
    confidence: 0.8,
    leverageTier: 'HIGH_CONFIRMATION',
    leverage: 40,
    microRegime: 'RANGING',
    momentum: { direction: 'LONG', strength: 0.7, continuationScore: 0.6 },
    book: { status: 'HEALTHY', ageMs: 100, imbalance: 0.6, imbalanceSlope: 0.02, temporalAbsorption: false, temporalSweep: false },
    tradeFlow: { buyTakerVolume: 100, sellTakerVolume: 80, netTakerFlow: 20, sampleCount: 50 },
    btc: { status: 'HEALTHY', ageMs: 50, ret1m: 0.001, ret3m: 0.002, ret5m: 0.003, acceleration: -0.001, direction: 'LONG', conflict: false },
    horizons: {},
    barrierOutcome: 'NEITHER',
    dynamicExitOutcome: null,
    grossBps: 10,
    costScenarios: { cost_0: 10, cost_14: -4 },
    completedAtMs: 2_000_000,
    strategyVersion: '0.4.0-prospective-validation',
    codeCommitSha: 'UNCOMMITTED',
    configHash: 'default',
    ...overrides,
  };
}

describe('MicroBurstOutcomeJournal', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('appends records to JSONL file', () => {
    const journal = new MicroBurstOutcomeJournal(TEST_DIR);
    const record = makeRecord({ shadowSignalId: 'test-001' });
    journal.append(record);

    expect(journal.getEntryCount()).toBe(1);
    expect(journal.getWrittenIds().has('test-001')).toBe(true);
  });

  it('does not duplicate records with same shadowSignalId', () => {
    const journal = new MicroBurstOutcomeJournal(TEST_DIR);
    const record = makeRecord({ shadowSignalId: 'test-001' });
    journal.append(record);
    journal.append(record); // duplicate

    expect(journal.getEntryCount()).toBe(1);
  });

  it('writes valid JSONL', () => {
    const journal = new MicroBurstOutcomeJournal(TEST_DIR);
    journal.append(makeRecord({ shadowSignalId: 'test-001' }));

    const records = journal.loadAll();
    expect(records).toHaveLength(1);
    expect(records[0].shadowSignalId).toBe('test-001');
  });

  it('creates directory if it does not exist', () => {
    expect(fs.existsSync(TEST_DIR)).toBe(false);
    const journal = new MicroBurstOutcomeJournal(TEST_DIR);
    journal.append(makeRecord());
    expect(fs.existsSync(TEST_DIR)).toBe(true);
  });

  it('flush resets state', () => {
    const journal = new MicroBurstOutcomeJournal(TEST_DIR);
    journal.append(makeRecord());
    journal.flush();
    expect(journal.getEntryCount()).toBe(0);
    expect(journal.getCurrentFilePath()).toBeNull();
  });

  it('entry contains no API credentials', () => {
    const journal = new MicroBurstOutcomeJournal(TEST_DIR);
    journal.append(makeRecord());
    const records = journal.loadAll();
    const json = JSON.stringify(records[0]);
    expect(json).not.toContain('api_key');
    expect(json).not.toContain('secret');
    expect(json).not.toContain('password');
  });

  it('preserves signal immutability — journal entry matches frozen snapshot', () => {
    const journal = new MicroBurstOutcomeJournal(TEST_DIR);
    const record = makeRecord({
      shadowSignalId: 'immutable-test',
      structuralStopPrice: 78500,
    });
    journal.append(record);

    const loaded = journal.loadAll();
    expect(loaded[0].structuralStopPrice).toBe(78500);
  });
});
