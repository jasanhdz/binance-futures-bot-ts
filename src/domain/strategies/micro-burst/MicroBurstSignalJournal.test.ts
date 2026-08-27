import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { MicroBurstSignalJournal } from './MicroBurstSignalJournal';
import { MicroBurstShadowEvaluationResult } from './MicroBurstMarketDataTypes';

const TEST_JOURNAL_DIR = path.join(__dirname, '__test_journal__');

function makeResult(overrides: Partial<MicroBurstShadowEvaluationResult> = {}): MicroBurstShadowEvaluationResult {
  return {
    strategyId: 'MICRO_BURST_V1',
    strategyVersion: '0.3.0-operational-shadow',
    symbol: 'ETHUSDT',
    snapshotAtMs: 1000000,
    decision: 'ENTRY_INTENT',
    side: 'LONG',
    confidence: 0.8,
    referencePrice: 3500,
    supportPrice: 3480,
    resistancePrice: 3550,
    structuralInvalidation: 3470,
    destinationPrice: 3560,
    roomToTargetBps: 171,
    riskToInvalidationBps: 85,
    rewardRisk: 2.0,
    momentum: { direction: 'LONG', strength: 0.7, continuationScore: 0.6 },
    book: { status: 'HEALTHY', ageMs: 100, imbalance: 0.6, imbalanceSlope: 0.02 },
    btc: { status: 'HEALTHY', ageMs: 50, ret1m: 0.001, ret3m: 0.002, ret5m: 0.003, conflict: false },
    microRegime: 'RANGING',
    dataQuality: { contextValid: true, invalidReasons: [] },
    wouldEnter: true,
    liveExecution: false as const,
    shadowSignalId: 'sig-001',
    duplicateSuppressed: false,
    firstObservedAt: 1000000,
    lastObservedAt: 1000000,
    diagnostics: {},
    ...overrides,
  };
}

describe('MicroBurstSignalJournal', () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_JOURNAL_DIR)) {
      fs.rmSync(TEST_JOURNAL_DIR, { recursive: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(TEST_JOURNAL_DIR)) {
      fs.rmSync(TEST_JOURNAL_DIR, { recursive: true });
    }
  });

  it('appends unique signals to JSONL file', () => {
    const journal = new MicroBurstSignalJournal(TEST_JOURNAL_DIR);
    journal.append(makeResult());
    const filePath = journal.getCurrentFilePath();
    expect(filePath).not.toBeNull();
    expect(fs.existsSync(filePath!)).toBe(true);

    const content = fs.readFileSync(filePath!, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(1);

    const entry = JSON.parse(lines[0]);
    expect(entry.strategyId).toBe('MICRO_BURST_V1');
    expect(entry.symbol).toBe('ETHUSDT');
    expect(entry.side).toBe('LONG');
    expect(entry.wouldEnter).toBe(true);
    expect(entry.liveExecution).toBe(false);
  });

  it('does not append NO_TRADE results', () => {
    const journal = new MicroBurstSignalJournal(TEST_JOURNAL_DIR);
    journal.append(makeResult({ wouldEnter: false, decision: 'NO_TRADE' }));
    expect(journal.getEntryCount()).toBe(0);
  });

  it('does not append duplicate signals', () => {
    const journal = new MicroBurstSignalJournal(TEST_JOURNAL_DIR);
    journal.append(makeResult({ shadowSignalId: 'sig-001' }));
    journal.append(makeResult({ shadowSignalId: 'sig-001', duplicateSuppressed: true }));
    expect(journal.getEntryCount()).toBe(1);
  });

  it('rotates file after max entries', async () => {
    const journal = new MicroBurstSignalJournal(TEST_JOURNAL_DIR, 2);
    journal.append(makeResult({ shadowSignalId: 'sig-001' }));
    journal.append(makeResult({ shadowSignalId: 'sig-002' }));
    const firstPath = journal.getCurrentFilePath();
    // Ensure next rotateFile() gets a different timestamp
    await new Promise((r) => setTimeout(r, 15));
    journal.append(makeResult({ shadowSignalId: 'sig-003' }));
    const secondPath = journal.getCurrentFilePath();
    expect(firstPath).not.toBe(secondPath);
  });

  it('flush resets state', () => {
    const journal = new MicroBurstSignalJournal(TEST_JOURNAL_DIR);
    journal.append(makeResult());
    expect(journal.getEntryCount()).toBe(1);
    journal.flush();
    expect(journal.getEntryCount()).toBe(0);
    expect(journal.getCurrentFilePath()).toBeNull();
  });

  it('entry contains no API credentials', () => {
    const journal = new MicroBurstSignalJournal(TEST_JOURNAL_DIR);
    journal.append(makeResult());
    const content = fs.readFileSync(journal.getCurrentFilePath()!, 'utf-8');
    expect(content).not.toContain('api_key');
    expect(content).not.toContain('api_secret');
    expect(content).not.toContain('secret');
  });

  it('entry contains deterministic fields', () => {
    const journal = new MicroBurstSignalJournal(TEST_JOURNAL_DIR);
    journal.append(makeResult({ shadowSignalId: 'deterministic-id' }));
    const content = fs.readFileSync(journal.getCurrentFilePath()!, 'utf-8');
    const entry = JSON.parse(content.trim());
    expect(entry.shadowSignalId).toBe('deterministic-id');
    expect(entry.strategyVersion).toBe('0.3.0-operational-shadow');
    expect(typeof entry.snapshotAtMs).toBe('number');
  });

  it('entry contains aggTrade fields', () => {
    const journal = new MicroBurstSignalJournal(TEST_JOURNAL_DIR);
    journal.append(makeResult());
    const content = fs.readFileSync(journal.getCurrentFilePath()!, 'utf-8');
    const entry = JSON.parse(content.trim());
    expect(entry.aggTrade).toBeDefined();
    expect(typeof entry.aggTrade.buyTakerVolume).toBe('number');
    expect(typeof entry.aggTrade.sellTakerVolume).toBe('number');
    expect(typeof entry.aggTrade.netTakerFlow).toBe('number');
    expect(typeof entry.aggTrade.sampleCount).toBe('number');
  });

  it('entry contains btc fields', () => {
    const journal = new MicroBurstSignalJournal(TEST_JOURNAL_DIR);
    journal.append(makeResult());
    const content = fs.readFileSync(journal.getCurrentFilePath()!, 'utf-8');
    const entry = JSON.parse(content.trim());
    expect(entry.btc).toBeDefined();
    expect(entry.btc.status).toBe('HEALTHY');
    expect(typeof entry.btc.ret1m).toBe('number');
    expect(entry.btc.conflict).toBe(false);
  });

  it('restart does not corrupt file', async () => {
    const journal1 = new MicroBurstSignalJournal(TEST_JOURNAL_DIR);
    journal1.append(makeResult({ shadowSignalId: 'sig-1' }));
    const filePath1 = journal1.getCurrentFilePath();
    journal1.flush();

    // Ensure next rotateFile() gets a different timestamp
    await new Promise((r) => setTimeout(r, 15));

    const journal2 = new MicroBurstSignalJournal(TEST_JOURNAL_DIR);
    journal2.append(makeResult({ shadowSignalId: 'sig-2' }));
    const filePath2 = journal2.getCurrentFilePath();

    // After flush, a new file is created. Verify both files exist and have 1 line each.
    const content1 = fs.readFileSync(filePath1!, 'utf-8');
    expect(content1.trim().split('\n')).toHaveLength(1);

    const content2 = fs.readFileSync(filePath2!, 'utf-8');
    expect(content2.trim().split('\n')).toHaveLength(1);

    // Verify both files are distinct
    expect(filePath1).not.toBe(filePath2);
  });
});
