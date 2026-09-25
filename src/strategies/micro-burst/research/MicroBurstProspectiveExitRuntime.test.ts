import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MicroBurstExitContext } from '../domain/MicroBurstTypes';
import {
  MicroBurstProspectiveExitRuntime,
  MicroBurstProspectiveExitRuntimeConfig,
  MicroBurstProspectiveExitEventSource,
  createMicroBurstProspectiveExitRuntime,
} from './MicroBurstProspectiveExitRuntime';
import { MicroBurstProspectiveExitCapture } from './MicroBurstProspectiveExitCapture';
import { MicroBurstProspectiveExitObserver } from './MicroBurstProspectiveExitObserver';
import type {
  ProspectiveExitIdentity,
  ProspectiveExitObservation,
  ProspectiveRealFill,
} from './MicroBurstProspectiveExitObserver';
import { MicroBurstProspectiveExitEventBus } from './MicroBurstProspectiveExitEventBus';

class FakeProspectiveEventSource implements MicroBurstProspectiveExitEventSource {
  private readonly entries = new Set<
    (identity: ProspectiveExitIdentity, fills: readonly ProspectiveRealFill[]) => void
  >();
  private readonly fills = new Set<(entryId: string, fill: ProspectiveRealFill) => void>();
  private readonly closes = new Set<(entryId: string, closedAtMs: number) => void>();
  private readonly observations = new Set<
    (entryId: string, observation: ProspectiveExitObservation) => void
  >();

  public onExecutedEntry(
    listener: (identity: ProspectiveExitIdentity, fills: readonly ProspectiveRealFill[]) => void,
  ): () => void {
    this.entries.add(listener);
    return () => this.entries.delete(listener);
  }

  public onRealFill(listener: (entryId: string, fill: ProspectiveRealFill) => void): () => void {
    this.fills.add(listener);
    return () => this.fills.delete(listener);
  }

  public onRealPositionClosed(listener: (entryId: string, closedAtMs: number) => void): () => void {
    this.closes.add(listener);
    return () => this.closes.delete(listener);
  }

  public onObservation(
    listener: (entryId: string, observation: ProspectiveExitObservation) => void,
  ): () => void {
    this.observations.add(listener);
    return () => this.observations.delete(listener);
  }

  public emitEntry(identity: ProspectiveExitIdentity, fills: readonly ProspectiveRealFill[]): void {
    for (const listener of this.entries) listener(identity, fills);
  }

  public emitFill(entryId: string, fill: ProspectiveRealFill): void {
    for (const listener of this.fills) listener(entryId, fill);
  }

  public emitClose(entryId: string, closedAtMs: number): void {
    for (const listener of this.closes) listener(entryId, closedAtMs);
  }

  public emitObservation(entryId: string, observation: ProspectiveExitObservation): void {
    for (const listener of this.observations) listener(entryId, observation);
  }
}

function identity(entryId: string): ProspectiveExitIdentity {
  return {
    entryId,
    symbol: 'BTCUSDT',
    side: 'LONG',
    enteredAtMs: 0,
    quantity: 2,
    entryPrice: 100,
    strategyVersion: 'micro-test-v1',
    codeCommitSha: 'runtime-test-sha',
    configHash: 'runtime-test-config',
    currentPolicyVersion: 'EXPECTED_CONTINUATION_V2',
    candidatePolicyVersion: 'MICRO_OFFLINE_NO_TIME_CLOSE_V1',
  };
}

function observation(now: number): ProspectiveExitObservation {
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
      source: 'RUNTIME_TEST',
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
  };
}

const fill: ProspectiveRealFill = {
  fillId: 'fill-runtime-1',
  orderId: 'order-runtime-1',
  eventAtMs: 10,
  receivedAtMs: 11,
  price: 100,
  quantity: 2,
  feeBps: 10,
  fundingBps: 0,
};

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe('MicroBurst prospective runtime composition', () => {
  it('connects reconciled entry/fills, observations, real close, and post-close horizon continuation', async () => {
    const source = new FakeProspectiveEventSource();
    const config: MicroBurstProspectiveExitRuntimeConfig = {
      enabled: true,
      journalPath: join(mkdtempSync(join(tmpdir(), 'micro-runtime-capture-')), 'episodes.jsonl'),
    };
    const runtime = createMicroBurstProspectiveExitRuntime(config, source);
    expect(await runtime.start()).toBe(true);
    const entry = identity('runtime-entry');
    source.emitEntry(entry, [fill]);
    source.emitFill(entry.entryId, {
      ...fill,
      fillId: 'fill-runtime-2',
      quantity: 0.5,
      role: 'EXIT',
    });
    source.emitObservation(entry.entryId, observation(300_000));
    source.emitClose(entry.entryId, 301_000);
    source.emitObservation(entry.entryId, observation(360_000));
    await settle();

    expect(runtime.getHealth().capture.metrics.persistenceFailures).toBe(0);
    const snapshot = runtime.getEntry(entry.entryId)!;
    expect(snapshot.realFills).toHaveLength(2);
    expect(snapshot.realPositionClosedAtMs).toBe(301_000);
    expect(snapshot.simulations.CURRENT.decisions).toHaveLength(2);
    expect(snapshot.simulations.CANDIDATE.decisions).toHaveLength(2);
    expect(snapshot.simulations.CANDIDATE.status).toBe('CLOSED');
    expect(snapshot.simulations.CANDIDATE.closeDecision).not.toBeNull();
    await expect(runtime.stop()).resolves.toBe(true);
    expect(runtime.getHealth().started).toBe(false);
  });

  it('does not subscribe when disabled', async () => {
    const source = new FakeProspectiveEventSource();
    const runtime = createMicroBurstProspectiveExitRuntime(
      { enabled: false, journalPath: '/tmp/unused-prospective.jsonl' },
      source,
    );
    expect(await runtime.start()).toBe(false);
    expect(runtime.getHealth()).toMatchObject({ enabled: false, started: false, restored: 0 });
  });

  it('uses the production event bus without blocking its publisher on persistence', async () => {
    const source = new MicroBurstProspectiveExitEventBus(true);
    const runtime = createMicroBurstProspectiveExitRuntime(
      {
        enabled: true,
        journalPath: join(mkdtempSync(join(tmpdir(), 'micro-runtime-bus-')), 'episodes.jsonl'),
      },
      source,
    );
    await runtime.start();
    const entry = identity('runtime-bus-entry');
    source.publishExecutedEntry(entry, [fill]);
    source.publishObservation(entry.entryId, observation(10_000));
    source.publishRealPositionClosed(entry.entryId, 301_000);
    await settle();
    source.publishObservation(entry.entryId, observation(360_000));
    source.publishObservation(entry.entryId, observation(1_000_000));
    await settle();

    expect(source.entriesSnapshot()).toHaveLength(0);
    expect(source.getSynchronousCost().maxMs).toBeLessThan(25);
    await expect(runtime.stop()).resolves.toBe(true);
  });

  it('serializes concurrent start and cancels subscription after stop during restore', async () => {
    const source = new FakeProspectiveEventSource();
    let resolveLoad!: (value: readonly never[]) => void;
    const store = {
      save: async () => true,
      load: () => new Promise<readonly never[]>((resolve) => (resolveLoad = resolve)),
      drain: async () => true,
      getHealth: () => ({
        healthy: true,
        malformedRecords: 0,
        truncatedRecords: 0,
        writeFailures: 0,
        pendingWrites: 0,
        readFailures: 0,
        incompatibleRecords: 0,
        fileMissing: false,
        appendBlocked: false,
      }),
    };
    const capture = new MicroBurstProspectiveExitCapture(
      new MicroBurstProspectiveExitObserver(),
      store,
      { enabled: true },
    );
    const runtime = new MicroBurstProspectiveExitRuntime(capture, source, true);
    const firstStart = runtime.start();
    const secondStart = runtime.start();
    const stopped = runtime.stop();
    resolveLoad([]);
    expect(await stopped).toBe(true);
    expect(await firstStart).toBe(false);
    expect(await secondStart).toBe(false);
    expect(runtime.getHealth().started).toBe(false);
  });
});
