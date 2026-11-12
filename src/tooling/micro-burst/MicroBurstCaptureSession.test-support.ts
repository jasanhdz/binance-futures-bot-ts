import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Side } from '../../core/types';
import type { StrategyDecisionEvidenceV2 } from '../../core/blackbox/StrategyDecisionBlackBox';
import type {
  LocalCausalContextEvidence,
  LocalCausalStateWatermark,
} from '../../core/market-data/LocalCausalWatermark';
import { hashTree, verifyFrozenCollectorArtifact } from './MicroBurstCollectorFreeze';
import {
  openVerifiedCaptureSession,
  writeCaptureSessionManifest,
} from './MicroBurstCaptureSession';
import {
  MicroBurstStorage,
  type ArchiveDepth,
  type ArchiveTrade,
} from '../../strategies/micro-burst/research/MicroBurstStorage';
import {
  defaultMicroBurstConfig,
  type MicroBurstConfig,
} from '../../strategies/micro-burst/domain/MicroBurstTypes';
import {
  makeLevel,
  makeMicroBurstContext,
  TEST_SNAPSHOT_AT_MS,
} from '../../strategies/micro-burst/domain/MicroBurst.test-support';
import type { MicroBurstStrategyContext } from '../../strategies/micro-burst/domain/MicroBurstStrategy';
import { evaluateMicroBurstReactionEntry } from '../../strategies/micro-burst/domain/MicroBurstReactionEntryPolicy';
import {
  captureMicroBurstReplay,
  encodeMicroReplay,
} from '../../strategies/micro-burst/domain/MicroBurstExactReplay';
import { reconcileMicroBurstCaptureCounters } from './MicroBurstCaptureCounters';

const sha = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

export interface SyntheticCaptureInput {
  readonly startedAtMs: number;
  readonly completedAtMs: number;
  readonly trades: readonly ArchiveTrade[];
  readonly depth?: readonly ArchiveDepth[];
  readonly checkpoints?: readonly {
    symbol: string;
    eventTimeMs: number;
    persistedAtMs?: number;
    checkpoint: unknown;
  }[];
  readonly gaps?: readonly {
    symbol: string;
    startedAtMs: number;
    endedAtMs: number;
    feed: 'AGG_TRADE' | 'DEPTH';
  }[];
  readonly decisionRecords?: readonly StrategyDecisionEvidenceV2[];
  readonly rawRestRecords?: readonly Record<string, unknown>[];
  readonly eventRecords?: readonly Record<string, unknown>[];
  readonly bindLocalCausalPersistence?: boolean;
  readonly storageNowMs?: number;
  readonly maxActiveSegmentRecords?: number;
  readonly fundingEvidenceRecords?: readonly Record<string, unknown>[];
}

export function makeSyntheticNoFundingEvidence(
  symbol: string,
  fromMs: number,
  throughMs: number,
): Record<string, unknown> {
  const body = {
    schema: 'MICRO_FUNDING_EVIDENCE_V1',
    symbol,
    fromMs,
    throughMs,
    source: 'SYNTHETIC_TEST_FIXTURE',
    events: [],
  };
  return { ...body, responseSha256: sha(JSON.stringify(body, Object.keys(body).sort())) };
}

export function makeSyntheticDecisionRecord(
  atMs: number,
  side: Side = 'LONG',
  symbol = 'SOLUSDT',
  options: {
    rejectBaseline?: boolean;
    exchangeClockOffsetMs?: number;
    exchangeClockLowerBoundOffsetMs?: number;
    bookObservedAtOffsetMs?: number;
    bookCausalState?: LocalCausalStateWatermark;
    localCausalContext?: LocalCausalContextEvidence;
    book?: { bid: number; ask: number; bidQty?: number; askQty?: number };
    bookDepth?: {
      bidDepth: readonly { price: number; qty: number }[];
      askDepth: readonly { price: number; qty: number }[];
    };
    replayConfig?: MicroBurstConfig;
  } = {},
): StrategyDecisionEvidenceV2 {
  const config = defaultMicroBurstConfig();
  const mirror = (price: number): number => (side === 'LONG' ? price : 200 - price);
  const base = TEST_SNAPSHOT_AT_MS;
  const supportPrice = side === 'LONG' ? mirror(99.7) : mirror(102);
  const resistancePrice = side === 'LONG' ? mirror(102) : mirror(99.7);
  const context = makeMicroBurstContext({
    symbol,
    timestamp: base,
    currentPrice: 100,
    decisionPrice: { price: 100, source: 'CANDLE', observedAtMs: base },
    microRegime: side === 'LONG' ? 'TRENDING_UP' : 'TRENDING_DOWN',
    momentum: { ...makeMicroBurstContext().momentum, direction: side },
    btcContext: {
      ret1m: 0,
      ret3m: 0,
      ret5m: 0,
      acceleration: 0,
      conflictFlag: false,
      direction: 'NEUTRAL',
      observedAtMs: base - 1_000,
      receivedAtMs: base - 1_000,
    },
    aggTradeFlow: {
      buyTakerVolume: side === 'LONG' ? 60 : 40,
      sellTakerVolume: side === 'LONG' ? 40 : 60,
      netTakerFlow: side === 'LONG' ? 20 : -20,
      tradeCount: 20,
      requestedWindowMs: 5_000,
      observedWindowMs: 5_000,
      observedSampleCount: 20,
      eventWatermarkMs: base,
      capacityTruncated: false,
      coverageStartedAtMs: base - 5_000,
      windowComplete: true,
      gapFree: true,
    },
    levels: {
      levels: [
        { ...makeLevel('support', supportPrice), availableAtMs: base - 300_000 },
        { ...makeLevel('resistance', resistancePrice), availableAtMs: base - 300_000 },
      ],
      nearest: {
        support: { ...makeLevel('support', supportPrice), availableAtMs: base - 300_000 },
        resistance: { ...makeLevel('resistance', resistancePrice), availableAtMs: base - 300_000 },
        distanceToSupportBps: side === 'LONG' ? 30 : 200,
        distanceToResistanceBps: side === 'LONG' ? 200 : 30,
        corridorWidthBps: 230,
        structuralPosition: side === 'LONG' ? 'near_support' : 'near_resistance',
      },
    },
    dataQuality: {
      ...makeMicroBurstContext().dataQuality,
      snapshotAtMs: base,
      latestClosed1mAt: base,
      latestClosed3mAt: base,
      latestClosed5mAt: base,
      levelsAvailableAt: base - 300_000,
      contextValid: true,
      closedCandlesOnly: true,
      bookAgeMs: atMs - base,
      btcAgeMs: atMs - (base - 1_000),
      invalidReasons: [],
    },
  });
  const previous = {
    timestamp: base - 60_000,
    openTime: base - 120_000,
    closeTime: base - 60_000,
    open: mirror(99.8),
    high: side === 'LONG' ? 100.05 : mirror(99.65),
    low: side === 'LONG' ? 99.65 : mirror(100.05),
    close: mirror(100),
    volume: 100,
    buyVolume: 50,
  };
  context.candles = {
    candles1m: [
      previous,
      {
        ...previous,
        timestamp: base,
        openTime: base - 60_000,
        closeTime: base,
        open: mirror(99.8),
        high: side === 'LONG' ? 100.05 : mirror(99.75),
        low: side === 'LONG' ? 99.75 : mirror(100.05),
        close: mirror(100),
      },
    ],
    candles3m: [],
    candles5m: [],
  };
  const strategyContext = context as MicroBurstStrategyContext;
  strategyContext.observedAtMs = atMs;
  strategyContext.exchangeObservedAtMs = atMs + (options.exchangeClockOffsetMs ?? 0);
  if (options.exchangeClockLowerBoundOffsetMs !== undefined) {
    strategyContext.clockReference = {
      source: 'SERVER_REQUEST_RESPONSE_BOUND',
      serverSampleAtMs: atMs,
      localRequestStartedAtMs: atMs - 100,
      localResponseReceivedAtMs: atMs - 50,
      requestRoundTripMs: 50,
      contextBuiltExchangeLowerBoundMs: atMs + options.exchangeClockLowerBoundOffsetMs,
      contextBuiltExchangeUpperBoundMs: strategyContext.exchangeObservedAtMs,
    };
  }
  strategyContext.executionBook = {
    observedAtMs: atMs + (options.bookObservedAtOffsetMs ?? 0),
    status: 'HEALTHY',
    bidDepth: options.bookDepth?.bidDepth.map((level) => ({ ...level })) ?? [
      { price: options.book?.bid ?? 99.99, qty: options.book?.bidQty ?? 100 },
    ],
    askDepth: options.bookDepth?.askDepth.map((level) => ({ ...level })) ?? [
      { price: options.book?.ask ?? 100.01, qty: options.book?.askQty ?? 100 },
    ],
    ...(options.bookCausalState ? { localCausality: options.bookCausalState } : {}),
  };
  if (options.localCausalContext) {
    strategyContext.inputCaptureTiming = {
      captureStartedAtMs: atMs - 50,
      capturedAtMs: atMs,
      captureDurationMs: 50,
      timestampClock: 'LOCAL_RECEIVE_TIME',
      durationClock: 'MONOTONIC',
      contextCaptureAtMonotonicMs: options.localCausalContext.captureMonotonicAtMs,
      decisionAtMonotonicMs: options.localCausalContext.captureMonotonicAtMs ?? undefined,
      localCausalContext: options.localCausalContext,
    };
  }
  if (options.rejectBaseline) context.dataQuality.contextValid = false;
  const baseline = evaluateMicroBurstReactionEntry(
    context,
    config,
    strategyContext.executionBook,
    atMs,
    strategyContext.exchangeObservedAtMs,
  );
  const codeCommitSha = 'a'.repeat(40);
  const decisionId = `synthetic-${symbol}-${atMs}`;
  const strategyInputReplay = encodeMicroReplay(
    captureMicroBurstReplay(strategyContext, options.replayConfig ?? config, codeCommitSha),
  );
  return {
    schemaVersion: 2,
    decisionId,
    marketSnapshotId: `snapshot-${decisionId}`,
    marketSnapshotStored: true,
    marketSnapshotContentHash: 'c'.repeat(64),
    evidenceLevel: 'FULL_REPLAY',
    symbol,
    evaluatedAtReceivedMs: atMs,
    strategyTimestampMs: base,
    recordedAtMs: atMs + 1,
    strategy: {
      strategyId: 'MICRO_BURST',
      strategyVersion: 'MICRO',
      freezeState: 'FROZEN_LIVE',
      codeCommitSha,
      configHash: `sha256:${sha(JSON.stringify(config))}`,
      strategyHash: `sha256:${'b'.repeat(64)}`,
    },
    mode: 'SHADOW',
    decision: baseline.action,
    side: baseline.side,
    reason: baseline.reason,
    confidence: baseline.confirmationStrength,
    structuralInvalidation: baseline.stopInvalidationPrice,
    destinationPrice: baseline.targetPrice,
    diagnostics: { ...baseline.diagnostics, strategyInputReplay },
    marketHealth: {} as StrategyDecisionEvidenceV2['marketHealth'],
    provenance: {
      schema: 'STRATEGY_DECISION_BLACKBOX_V2',
      schemaVersion: 2,
      marketSnapshotSchemaVersion: 1,
      causalClock: 'LOCAL_RECEIVE_TIME',
      storagePolicy: 'TIERED_DEDUPLICATED_ROTATING_JSONL_V2',
    },
  } as StrategyDecisionEvidenceV2;
}

export async function createSyntheticCaptureSession(input: SyntheticCaptureInput): Promise<{
  root: string;
  session: Awaited<ReturnType<typeof openVerifiedCaptureSession>>;
  cleanup: () => void;
}> {
  const root = mkdtempSync(join(tmpdir(), 'micro-capture-session-fixture-'));
  try {
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'code'));
    mkdirSync(join(root, 'node_modules'));
    mkdirSync(join(root, 'capture'));
    writeFileSync(join(root, 'src', 'producer.ts'), 'export const producer = 1;\n');
    writeFileSync(join(root, 'code', 'main.js'), '"use strict";\n');
    writeFileSync(join(root, 'node_modules', 'fixture.js'), 'module.exports = 1;\n');
    const packageJson = '{"name":"capture-fixture","version":"1.0.0"}\n';
    const packageLock = '{"name":"capture-fixture","lockfileVersion":3}\n';
    const tsconfig = '{"compilerOptions":{"target":"ES2020"},"include":["src"]}\n';
    const regime = 'micro_burst:\n  enabled: true\n  mode: SHADOW\n';
    writeFileSync(join(root, 'package.json'), packageJson);
    writeFileSync(join(root, 'package-lock.json'), packageLock);
    writeFileSync(join(root, 'tsconfig.json'), tsconfig);
    writeFileSync(join(root, 'regime_config.live.yaml'), regime);
    const files = {
      source: hashTree(join(root, 'src')),
      code: hashTree(join(root, 'code')),
      dependencies: hashTree(join(root, 'node_modules')),
      packageJson: sha(packageJson),
      tsconfig: sha(tsconfig),
      config: sha(regime),
      lock: sha(packageLock),
    };
    const artifactHash = sha(JSON.stringify(files));
    const codeSha256 = sha(JSON.stringify(files.code));
    writeFileSync(
      join(root, 'manifest.json'),
      JSON.stringify(
        {
          schema: 'MICRO_COLLECTOR_FROZEN_V2',
          createdAtMs: input.startedAtMs,
          gitCommit: 'a'.repeat(40),
          artifactHash,
          codeSha256,
          nodeVersion: process.version,
          platform: process.platform,
          arch: process.arch,
          packageJsonSha256: files.packageJson,
          tsconfigSha256: files.tsconfig,
          sourceDirty: true,
          authority: 'OBSERVATION_ONLY',
          credentialPolicy: 'EMPTY_KEYS_DOTENV_DEV_NULL',
          files,
        },
        null,
        2,
      ),
    );
    const producer = verifyFrozenCollectorArtifact(root);
    const effectiveConfig = {
      schema: 'MICRO_OBSERVATIONAL_CAPTURE_CONFIG_V1',
      authority: 'PUBLIC_MARKET_DATA_OBSERVATION_ONLY',
      symbols: ['SOLUSDT', 'AVAXUSDT'],
      benchmarkSymbols: ['BTCUSDT'],
      strategyConfig: defaultMicroBurstConfig(),
    };
    const configHash = sha(JSON.stringify(effectiveConfig));
    writeFileSync(join(root, 'effective-config.json'), JSON.stringify(effectiveConfig));
    const archivePath = join(root, 'capture', 'market-data');
    let storageNowMs = input.storageNowMs ?? input.startedAtMs;
    const storage = new MicroBurstStorage({
      databasePath: join(root, 'capture', 'research.sqlite'),
      archivePath,
      now: () => storageNowMs,
      maxActiveSegmentRecords: input.maxActiveSegmentRecords,
    });
    for (const trade of input.trades) {
      storageNowMs = Math.max(storageNowMs, trade.receivedAtMs);
      storage.appendTrade(trade);
    }
    for (const depth of input.depth ?? []) {
      storageNowMs = Math.max(storageNowMs, depth.receivedAtMs);
      storage.appendDepth(depth);
    }
    for (const checkpoint of input.checkpoints ?? []) {
      storageNowMs = checkpoint.persistedAtMs ?? checkpoint.eventTimeMs;
      storage.persistCheckpoint(checkpoint.symbol, checkpoint.eventTimeMs, checkpoint.checkpoint);
    }
    for (const gap of input.gaps ?? [])
      storage.recordGap({
        symbol: gap.symbol,
        startedAtMs: gap.startedAtMs,
        endedAtMs: gap.endedAtMs,
        reason: 'synthetic_fixture_gap',
        kind: gap.feed === 'AGG_TRADE' ? 'AGG_TRADE_SEQUENCE' : 'DEPTH_SEQUENCE',
        feed: gap.feed,
      });
    if (!storage.close()) throw new Error('SYNTHETIC_CAPTURE_STORAGE_CLOSE_FAILED');
    const persistenceWatermark = storage.getPersistenceWatermark();
    const decisionRecords = (input.decisionRecords ?? []).map((record) => ({
      ...record,
      strategy: { ...record.strategy, configHash: `sha256:${configHash}` },
      ...(input.bindLocalCausalPersistence
        ? {
            diagnostics: {
              ...record.diagnostics,
              strategyInputReplay: bindReplayPersistenceWatermark(
                record.diagnostics?.strategyInputReplay,
                persistenceWatermark,
              ),
            },
          }
        : {}),
    }));
    if (decisionRecords.length)
      writeFileSync(
        join(root, 'capture', 'decisions.jsonl'),
        `${decisionRecords.map((record) => JSON.stringify(record)).join('\n')}\n`,
      );
    if (input.rawRestRecords?.length)
      writeFileSync(
        join(root, 'capture', 'rest-inputs.jsonl'),
        `${input.rawRestRecords.map((record) => JSON.stringify(record)).join('\n')}\n`,
      );
    if (input.eventRecords?.length)
      writeFileSync(
        join(root, 'capture', 'events.jsonl'),
        `${input.eventRecords.map((record) => JSON.stringify(record)).join('\n')}\n`,
      );
    if (input.fundingEvidenceRecords?.length)
      writeFileSync(
        join(root, 'capture', 'funding-evidence.jsonl'),
        `${input.fundingEvidenceRecords.map((record) => JSON.stringify(record)).join('\n')}\n`,
      );
    const decisionCount = input.decisionRecords?.length ?? 0;
    const observationQueue = {
      captureAttempts: decisionCount,
      captureSucceeded: decisionCount,
      captureFailures: 0,
      exactDecisionEmissions: decisionCount,
      pendingRecords: 0,
      pendingBytes: 0,
      peakRecords: 0,
      peakBytes: 0,
      accepted: decisionCount,
      written: decisionCount,
      dropped: 0,
      failed: 0,
      closed: true,
      lastWriteDurationMs: 0,
      lastQueueWaitMs: 0,
      drainTimedOut: false,
    };
    const runtime = {
      running: false,
      marketArchiveHealthy: true,
      archiveQueueDepth: 0,
      archiveOverflowRecords: 0,
      storageErrors: 0,
      uncleanDeferredWriteMarker: false,
      mutationAttempts: 0,
      forwardedMutations: 0,
      totalEvaluations: decisionCount,
      totalEvaluationAttempts: decisionCount,
      totalEvaluationFailures: 0,
      evaluationInFlight: 0,
      observationQueue,
      paperTradingEnabled: false,
      paperTrading: { openPositions: 0, completedManagedTrades: 0 },
    };
    const writer = {
      recordsWritten: 0,
      pendingWrites: 0,
      writeFailures: 0,
      overloadRejected: 0,
    };
    const health: Record<string, any> = {
      startedAtMs: input.startedAtMs,
      atMs: input.completedAtMs,
      configHash,
      sourceArtifactHash: artifactHash,
      liveExecution: false,
      runtime,
      decisionWriter: { ...writer, recordsWritten: decisionCount },
      restWriter: { ...writer },
      eventWriter: { ...writer },
      snapshotWriter: { ...writer },
      auxiliaryWriteFailures: 0,
    };
    const counterReconciliation = reconcileMicroBurstCaptureCounters(health);
    health.counterReconciliation = counterReconciliation;
    const healthBytes = JSON.stringify(health);
    writeFileSync(join(root, 'health.json'), healthBytes);
    writeFileSync(
      join(root, 'completion.json'),
      JSON.stringify({
        completedAtMs: input.completedAtMs,
        lifecycle: 'SESSION_ENDED_NOT_AUTOMATICALLY_EPISODE_COMPLETE',
        failed: false,
        mutationAttempts: 0,
        forwardedMutations: 0,
        auxiliaryWriteFailures: 0,
        counterReconciliation,
        finalHealthSha256: sha(healthBytes),
      }),
    );
    await writeCaptureSessionManifest({
      collectorRoot: root,
      captureRoot: join(root, 'capture'),
      producer,
      configHash,
      startedAtMs: input.startedAtMs,
      completedAtMs: input.completedAtMs,
      shutdownFailures: [],
      auxiliaryWriteFailures: 0,
    });
    const session = await openVerifiedCaptureSession(root);
    return { root, session, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

function bindReplayPersistenceWatermark(value: unknown, persistenceWatermark: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const replay = value as Record<string, any>;
  if (!replay.context || typeof replay.context !== 'object') return value;
  const context = replay.context as Record<string, any>;
  if (!context.inputCaptureTiming || typeof context.inputCaptureTiming !== 'object') return value;
  const inputCaptureTiming = context.inputCaptureTiming as Record<string, any>;
  const localCausalContext = inputCaptureTiming.localCausalContext;
  if (!localCausalContext || typeof localCausalContext !== 'object') return value;
  return {
    ...replay,
    context: {
      ...context,
      inputCaptureTiming: {
        ...inputCaptureTiming,
        localCausalContext: {
          ...localCausalContext,
          archivePersistence: persistenceWatermark,
        },
      },
    },
  };
}
