import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MicroBurstExitContext } from '../domain/MicroBurstTypes';
import {
  MicroBurstProspectiveExitObserver,
  ProspectiveExitObservation,
} from './MicroBurstProspectiveExitObserver';
import {
  MicroBurstProspectiveExitCapture,
  MicroBurstProspectiveExitJsonlStore,
  writeAllBytes,
} from './MicroBurstProspectiveExitCapture';

function identity(entryId: string) {
  return {
    entryId,
    symbol: 'BTCUSDT',
    side: 'LONG' as const,
    enteredAtMs: 0,
    quantity: 2,
    entryPrice: 100,
    strategyVersion: 'micro-test-v1',
    codeCommitSha: 'capture-test-sha',
    configHash: 'capture-test-config',
    currentPolicyVersion: 'EXPECTED_CONTINUATION_V2',
    candidatePolicyVersion: 'MICRO_OFFLINE_NO_TIME_CLOSE_V1' as const,
  };
}

function observation(
  now: number,
  gap?: ProspectiveExitObservation['gap'],
): ProspectiveExitObservation {
  const context: MicroBurstExitContext = {
    observedAtMs: now,
    timeInTradeMs: now,
    currentPrice: 100.1,
    entryPrice: 100,
    peakPrice: 100.1,
    troughPrice: 100,
    structuralInvalidationPrice: 98,
    destinationPrice: 104,
    currentStopPrice: 98,
    unrealizedRoe: 0,
    priceReturn: 0.001,
    leverage: 20,
    momentumDecayFlag: false,
    anomalyExitFlag: false,
    currentBookPressure: null,
    currentBtcContext: null,
    marketEvidence: null,
    executableEconomics: {
      observedAtMs: now,
      exitPrice: 100.1,
      quantityCovered: true,
      residualCostBps: 14,
      volatilityBps: 4,
    },
  };
  return {
    eventAtMs: now,
    receivedAtMs: now + 1,
    evaluatedAtMs: now + 2,
    context,
    executionAssumptions: {
      roundTripCostBps: 14,
      feeBps: 10,
      slippageBps: 4,
      source: 'TEST_EXECUTION_QUOTE',
    },
    depth: {
      status: 'HEALTHY',
      observedAtMs: now,
      requiredQuantity: 2,
      availableQuantity: 2,
      levelsUsed: 3,
      quantityCovered: true,
    },
    inputProvenance: {
      btcAvailable: false,
      flowAvailable: false,
      structureAvailable: true,
      quality: { closedCandlesOnly: true },
    },
    gap,
  };
}

describe('MicroBurst prospective capture integration boundary', () => {
  it('retries partial writes and rejects a zero-progress writer', async () => {
    const chunks: Buffer[] = [];
    const partialHandle = {
      write: async (bytes: Buffer, offset: number, length: number) => {
        const size = Math.min(3, length);
        chunks.push(Buffer.from(bytes.subarray(offset, offset + size)));
        return { bytesWritten: size };
      },
    };
    await expect(
      writeAllBytes(partialHandle, Buffer.from('journal-record')),
    ).resolves.toBeUndefined();
    expect(Buffer.concat(chunks).toString()).toBe('journal-record');
    const stalledHandle = {
      write: async () => ({ bytesWritten: 0 }),
    };
    await expect(writeAllBytes(stalledHandle, Buffer.from('journal-record'))).rejects.toThrow(
      'JOURNAL_WRITE_NO_PROGRESS',
    );
  });

  it('is disabled unless explicitly enabled by a separate observer-only composition', async () => {
    const observer = new MicroBurstProspectiveExitObserver();
    const capture = new MicroBurstProspectiveExitCapture(observer);
    expect(await capture.onExecutedEntry(identity('disabled'))).toBe(false);
    expect(observer.getEntry('disabled')).toBeNull();
  });

  it('restarts an episode, preserves real fills, and continues after real close', async () => {
    const root = mkdtempSync(join(tmpdir(), 'micro-prospective-capture-'));
    const store = new MicroBurstProspectiveExitJsonlStore(join(root, 'episodes.jsonl'));
    const first = new MicroBurstProspectiveExitCapture(
      new MicroBurstProspectiveExitObserver(),
      store,
      { enabled: true },
    );
    const entry = identity('entry-1');
    await expect(
      first.onExecutedEntry(entry, [
        {
          fillId: 'fill-1',
          orderId: 'order-1',
          eventAtMs: 10,
          receivedAtMs: 11,
          price: 100,
          quantity: 2,
          feeBps: 10,
          fundingBps: 0,
        },
      ]),
    ).resolves.toBe(true);
    await expect(first.onObservation('entry-1', observation(300_000))).resolves.toBe(true);
    await expect(first.onRealPositionClosed('entry-1', 301_000)).resolves.toBe(true);
    const journalRecords = readFileSync(join(root, 'episodes.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as {
            snapshot: {
              observations: unknown[];
              simulations: {
                CURRENT: { decisions: unknown[] };
                CANDIDATE: { decisions: unknown[] };
              };
            };
            observations: unknown[];
            decisions: { CURRENT: unknown[]; CANDIDATE: unknown[] };
          },
      );
    expect(journalRecords.every((record) => record.snapshot.observations.length === 0)).toBe(true);
    expect(journalRecords.reduce((sum, record) => sum + record.observations.length, 0)).toBe(1);
    expect(
      journalRecords.every(
        (record) =>
          record.snapshot.simulations.CURRENT.decisions.length === 0 &&
          record.snapshot.simulations.CANDIDATE.decisions.length === 0,
      ),
    ).toBe(true);
    expect(journalRecords.reduce((sum, record) => sum + record.decisions.CURRENT.length, 0)).toBe(
      1,
    );
    expect(journalRecords.reduce((sum, record) => sum + record.decisions.CANDIDATE.length, 0)).toBe(
      1,
    );

    const restartedObserver = new MicroBurstProspectiveExitObserver();
    const restarted = new MicroBurstProspectiveExitCapture(restartedObserver, store, {
      enabled: true,
    });
    await expect(restarted.restore()).resolves.toBe(1);
    await expect(
      restarted.onObservation(
        'entry-1',
        observation(320_000, {
          kind: 'DEPTH',
          fromMs: 319_000,
          toMs: 320_000,
          reason: 'FULL_DEPTH_GAP',
        }),
      ),
    ).resolves.toBe(true);
    await expect(restarted.onObservation('entry-1', observation(360_000))).resolves.toBe(true);

    const report = restartedObserver.getEntry('entry-1')!;
    expect(report.identity.quantity).toBe(2);
    expect(report.realFills).toHaveLength(1);
    expect(report.realPositionClosedAtMs).toBe(301_000);
    expect(report.simulations.CURRENT.decisions.length).toBe(3);
    expect(report.simulations.CANDIDATE.decisions.length).toBe(3);
    expect(report.simulations.CANDIDATE.status).toBe('CLOSED');
    expect(report.simulations.CANDIDATE.noEvaluableReason).toBe('FULL_DEPTH_GAP');
    expect(report.simulations.CANDIDATE.decisions[1]).toMatchObject({
      decision: null,
      evaluable: false,
      gap: { kind: 'DEPTH' },
    });
    expect(report.simulations.CURRENT.decisions[0].hypothetical).toBe(true);
    expect(store.getHealth().healthy).toBe(true);
  });

  it('keeps same-symbol episodes distinct and isolates persistence failure', async () => {
    const observer = new MicroBurstProspectiveExitObserver();
    const capture = new MicroBurstProspectiveExitCapture(
      observer,
      {
        save: async () => false,
        load: async () => [],
        drain: async () => true,
        getHealth: () => ({
          healthy: false,
          malformedRecords: 0,
          truncatedRecords: 0,
          writeFailures: 1,
          pendingWrites: 0,
          readFailures: 0,
          incompatibleRecords: 0,
          fileMissing: false,
          appendBlocked: false,
        }),
      },
      { enabled: true },
    );
    await expect(capture.onExecutedEntry(identity('entry-a'))).resolves.toBe(false);
    await expect(capture.onExecutedEntry(identity('entry-b'))).resolves.toBe(false);
    expect(observer.getEntry('entry-a')?.identity.entryId).toBe('entry-a');
    expect(observer.getEntry('entry-b')?.identity.entryId).toBe('entry-b');
    expect(capture.getMetrics().persistenceFailures).toBe(2);
  });

  it('keeps valid JSONL rows, reports a truncated tail, and does not duplicate restore', async () => {
    const root = mkdtempSync(join(tmpdir(), 'micro-prospective-truncated-'));
    const path = join(root, 'episodes.jsonl');
    const store = new MicroBurstProspectiveExitJsonlStore(path);
    const observer = new MicroBurstProspectiveExitObserver();
    const capture = new MicroBurstProspectiveExitCapture(observer, store, { enabled: true });
    await expect(capture.onExecutedEntry(identity('durable'))).resolves.toBe(true);
    const snapshot = observer.getEntry('durable')!;
    writeFileSync(
      path,
      `${JSON.stringify({
        formatVersion: 1,
        recordType: 'EPISODE_SNAPSHOT',
        snapshot: {
          ...snapshot,
          observations: [],
          simulations: {
            CURRENT: { ...snapshot.simulations.CURRENT, decisions: [] },
            CANDIDATE: { ...snapshot.simulations.CANDIDATE, decisions: [] },
          },
        },
        observations: snapshot.observations,
        decisions: {
          CURRENT: snapshot.simulations.CURRENT.decisions,
          CANDIDATE: snapshot.simulations.CANDIDATE.decisions,
        },
      })}\n${JSON.stringify({ identity: { entryId: 'durable' } })}\n{"identity":{"entryId":"truncated"`,
    );

    const restartedObserver = new MicroBurstProspectiveExitObserver();
    const restarted = new MicroBurstProspectiveExitCapture(restartedObserver, store, {
      enabled: true,
    });
    await expect(restarted.restore()).resolves.toBe(1);
    await expect(restarted.restore()).resolves.toBe(0);
    expect(restartedObserver.getEntry('durable')).not.toBeNull();
    expect(restarted.getMetrics().rejectedEntries).toBe(0);
    expect(store.getHealth()).toMatchObject({
      malformedRecords: 2,
      incompatibleRecords: 0,
      truncatedRecords: 1,
    });
    await expect(store.save(snapshot)).resolves.toBe(false);
    expect(store.getHealth().appendBlocked).toBe(true);
  });

  it('rejects legacy snapshot rows and unsupported journal versions without migration', async () => {
    const root = mkdtempSync(join(tmpdir(), 'micro-prospective-format-'));
    const path = join(root, 'episodes.jsonl');
    const store = new MicroBurstProspectiveExitJsonlStore(path);
    const observer = new MicroBurstProspectiveExitObserver();
    const capture = new MicroBurstProspectiveExitCapture(observer, store, { enabled: true });
    await expect(capture.onExecutedEntry(identity('legacy'))).resolves.toBe(true);
    const snapshot = observer.getEntry('legacy')!;
    writeFileSync(
      path,
      `${JSON.stringify(snapshot)}\n${JSON.stringify({
        formatVersion: 999,
        recordType: 'EPISODE_SNAPSHOT',
        snapshot: { ...snapshot, observations: [] },
        observations: [],
      })}\n`,
    );
    expect(await store.load()).toEqual([]);
    expect(store.getHealth()).toMatchObject({ incompatibleRecords: 2, appendBlocked: true });
    await expect(store.save(snapshot)).resolves.toBe(false);
  });

  it('retains the previous valid snapshot when a later same-entry row is invalid', async () => {
    const root = mkdtempSync(join(tmpdir(), 'micro-prospective-invalid-row-'));
    const path = join(root, 'episodes.jsonl');
    const writer = new MicroBurstProspectiveExitJsonlStore(path);
    const observer = new MicroBurstProspectiveExitObserver();
    const capture = new MicroBurstProspectiveExitCapture(observer, writer, { enabled: true });
    await expect(capture.onExecutedEntry(identity('fallback'))).resolves.toBe(true);
    const valid = observer.getEntry('fallback')!;
    appendFileSync(
      path,
      `${JSON.stringify({
        formatVersion: 1,
        recordType: 'EPISODE_SNAPSHOT',
        snapshot: { ...valid, identity: { ...valid.identity, side: 'INVALID' } },
        observations: [],
      })}\n`,
    );
    await expect(writer.save(valid)).resolves.toBe(false);
    expect(writer.getHealth().appendBlocked).toBe(true);
    const restartedStore = new MicroBurstProspectiveExitJsonlStore(path);
    const restored = await restartedStore.load();
    expect(restored).toHaveLength(1);
    expect(restored[0].identity.side).toBe(valid.identity.side);
    expect(restartedStore.getHealth()).toMatchObject({
      incompatibleRecords: 1,
      appendBlocked: true,
    });
  });

  it('retains the previous valid snapshot when an incremental observation is incomplete', async () => {
    const root = mkdtempSync(join(tmpdir(), 'micro-prospective-incomplete-observation-'));
    const path = join(root, 'episodes.jsonl');
    const writer = new MicroBurstProspectiveExitJsonlStore(path);
    const observer = new MicroBurstProspectiveExitObserver();
    const capture = new MicroBurstProspectiveExitCapture(observer, writer, { enabled: true });
    await expect(capture.onExecutedEntry(identity('incomplete'))).resolves.toBe(true);
    const valid = observer.getEntry('incomplete')!;
    appendFileSync(
      path,
      `${JSON.stringify({
        formatVersion: 1,
        recordType: 'EPISODE_SNAPSHOT',
        snapshot: {
          ...valid,
          observations: [],
          simulations: {
            CURRENT: { ...valid.simulations.CURRENT, decisions: [] },
            CANDIDATE: { ...valid.simulations.CANDIDATE, decisions: [] },
          },
        },
        observations: [{ eventAtMs: 1_000 }],
        decisions: { CURRENT: [], CANDIDATE: [] },
      })}\n`,
    );
    const restartedStore = new MicroBurstProspectiveExitJsonlStore(path);
    const restored = await restartedStore.load();
    expect(restored).toHaveLength(1);
    expect(restored[0].observations).toHaveLength(0);
    expect(restartedStore.getHealth()).toMatchObject({
      incompatibleRecords: 1,
      appendBlocked: true,
    });
  });

  it('isolates the in-memory cache from save inputs and load outputs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'micro-prospective-cache-'));
    const store = new MicroBurstProspectiveExitJsonlStore(join(root, 'episodes.jsonl'));
    const observer = new MicroBurstProspectiveExitObserver();
    observer.registerEntry(identity('cache'));
    const snapshot = observer.getEntry('cache')!;
    await expect(store.save(snapshot)).resolves.toBe(true);
    snapshot.identity.entryPrice = 200;
    const firstLoad = await store.load();
    expect(firstLoad[0].identity.entryPrice).toBe(100);
    firstLoad[0].identity.entryPrice = 300;
    const secondLoad = await store.load();
    expect(secondLoad[0].identity.entryPrice).toBe(100);
  });

  it('restores original observations and reproduces decisions without original objects', async () => {
    const root = mkdtempSync(join(tmpdir(), 'micro-prospective-evidence-'));
    const path = join(root, 'episodes.jsonl');
    const store = new MicroBurstProspectiveExitJsonlStore(path);
    const observer = new MicroBurstProspectiveExitObserver();
    const capture = new MicroBurstProspectiveExitCapture(observer, store, { enabled: true });
    const original = observation(1_000);
    await expect(capture.onExecutedEntry(identity('evidence'))).resolves.toBe(true);
    await expect(capture.onObservation('evidence', original)).resolves.toBe(true);
    const expected = observer.getEntry('evidence')!;
    original.context.currentPrice = 999;
    const restoredObserver = new MicroBurstProspectiveExitObserver();
    const restored = new MicroBurstProspectiveExitCapture(restoredObserver, store, {
      enabled: true,
    });
    await expect(restored.restore()).resolves.toBe(1);
    const actual = restoredObserver.getEntry('evidence')!;
    expect(actual.observations[0].context.currentPrice).toBe(100.1);
    expect(actual.simulations).toEqual(expected.simulations);
  });

  it('distinguishes a missing journal from a read error', async () => {
    const root = mkdtempSync(join(tmpdir(), 'micro-prospective-read-'));
    const missing = new MicroBurstProspectiveExitJsonlStore(join(root, 'missing.jsonl'));
    expect(await missing.load()).toEqual([]);
    expect(missing.getHealth()).toMatchObject({
      fileMissing: true,
      readFailures: 0,
      healthy: false,
    });
    const directory = new MicroBurstProspectiveExitJsonlStore(root);
    expect(await directory.load()).toEqual([]);
    expect(directory.getHealth()).toMatchObject({
      fileMissing: false,
      readFailures: 1,
      healthy: false,
    });
  });

  it('bounds pending disk writes and records saturation without throwing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'micro-prospective-saturation-'));
    const store = new MicroBurstProspectiveExitJsonlStore(
      join(root, 'episodes.jsonl'),
      64 * 1024,
      1,
    );
    const observer = new MicroBurstProspectiveExitObserver();
    observer.registerEntry(identity('saturated'));
    const snapshot = observer.getEntry('saturated')!;
    const first = store.save(snapshot);
    await expect(store.save(snapshot)).resolves.toBe(false);
    await expect(first).resolves.toBe(true);
    expect(store.getHealth()).toMatchObject({ writeFailures: 1, pendingWrites: 0 });
  });
});
