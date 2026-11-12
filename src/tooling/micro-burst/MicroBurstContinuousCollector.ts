import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { load } from 'js-yaml';
import { createReadOnlyBinanceMarketData } from '../../infra/adapters/ReadOnlyBinanceMarketData';
import {
  MicroBurstRuntime,
  type MicroBurstRuntimeDeps,
} from '../../strategies/micro-burst/application/MicroBurstRuntime';
import { parseMicroBurstConfig } from '../../strategies/micro-burst/application/MicroBurstConfigLoader';
import type { MicroBurstRuntimeConfig } from '../../strategies/micro-burst/application/MicroBurstRuntimeTypes';
import { MicroBurstStorage } from '../../strategies/micro-burst/research/MicroBurstStorage';
import {
  ORDER_BOOK_FEATURE_DEPTH,
  ORDER_BOOK_SNAPSHOT_DEPTH,
  type MarketDataPort,
} from '../../app/ports/MarketData';
import { MicroBurstEpisodeCapture } from './MicroBurstEpisodeCapture';
import { reconcileMicroBurstCaptureCounters } from './MicroBurstCaptureCounters';
import { writeCaptureSessionManifest } from './MicroBurstCaptureSession';
import { verifyFrozenCollectorArtifact } from './MicroBurstCollectorFreeze';
import {
  MicroBurstStrategy,
  type MicroBurstStrategyContext,
} from '../../strategies/micro-burst/domain/MicroBurstStrategy';
import { createMicroBurstIdentity } from '../../strategies/micro-burst/domain/MicroBurstIdentity';
import { StrategyRouter } from '../../core/strategy/StrategyRouter';
import { JsonlDecisionEvidenceSink } from '../../infra/logging/JsonlDecisionEvidenceSink';
import { JsonlMarketSnapshotSink } from '../../infra/logging/JsonlMarketSnapshotSink';
import type { ShadowJournal } from '../../core/shadow/ShadowTradeJournal';
import { RotatingJsonlWriter } from '../../infra/logging/RotatingJsonlWriter';
import type { Logger } from '../../app/ports/Logger';
import type { VerifiedFrozenCollectorArtifact } from './MicroBurstCollectorFreeze';
import { MICRO_EVIDENCE_LIMITS } from '../../strategies/micro-burst/domain/MicroBurstExactReplay';

const EVALUATION_INTERVAL_MS = 500;
const MAX_PUBLIC_REQUESTS_IN_FLIGHT = 16;
const MAX_CAPTURE_BYTES = 1024 * 1024 * 1024;
const MAX_CAPTURE_MEMORY_BYTES = 1536 * 1024 * 1024;
const MIN_FREE_DISK_RESERVE_BYTES = 1536 * 1024 * 1024;
const CAPTURE_DISK_STOP_BYTES = MAX_CAPTURE_BYTES - 64 * 1024 * 1024;
const MAX_CAPTURE_QUEUE_RECORDS = 8192;
const MAX_ACTIVE_SEGMENT_BYTES = 4 * 1024 * 1024;
const MAX_ACTIVE_SEGMENT_RECORDS = 5000;
const MAX_ACTIVE_SEGMENT_DURATION_MS = 30_000;
const DURABILITY_FLUSH_INTERVAL_MS = 1000;
const EPISODE_CAPTURE_PENDING_LIMIT = 128;

class NoPaperShadowJournal implements ShadowJournal {
  appendPosition(): void {
    throw new Error('PAPER_TRADING_DISABLED_IN_CAPTURE');
  }
  appendEvent(): void {
    throw new Error('PAPER_TRADING_DISABLED_IN_CAPTURE');
  }
  loadOpenPositions(): never[] {
    return [];
  }
  loadAllPositions(): never[] {
    return [];
  }
  loadAllEvents(): never[] {
    return [];
  }
  getHealth(): { healthy: boolean; malformedCount: number } {
    return { healthy: true, malformedCount: 0 };
  }
  flush(): void {}
}

/** Shared by production capture and the simulated-transport integration test. */
export function composeCaptureObservationRuntime(input: {
  config: MicroBurstRuntimeConfig;
  producer: Pick<VerifiedFrozenCollectorArtifact, 'gitCommit'>;
  configHash: string;
  runtimeDeps: Omit<
    MicroBurstRuntimeDeps,
    'strategyRouter' | 'enablePaperTrading' | 'shadowTradeJournal'
  >;
  signalJournalDir: string;
}): MicroBurstRuntime {
  const strategyRouter = new StrategyRouter<MicroBurstStrategyContext>();
  strategyRouter.register(
    new MicroBurstStrategy(
      createMicroBurstIdentity(input.producer.gitCommit, input.configHash),
      'SHADOW',
      input.config.exitPolicy,
    ),
  );
  return new MicroBurstRuntime(
    {
      ...input.runtimeDeps,
      strategyRouter,
      enablePaperTrading: false,
      shadowTradeJournal: new NoPaperShadowJournal(),
    },
    input.config,
    EVALUATION_INTERVAL_MS,
    input.signalJournalDir,
  );
}

export function wrapPublicMarketDataForCapture(
  source: MarketDataPort,
  recordRequest: (entry: Record<string, unknown>) => void,
  requestStarted: () => void,
  requestFinished: () => void,
  now: () => number = Date.now,
): MarketDataPort {
  const capturedMethods = new Set([
    'getCandles',
    'getDepthSnapshot',
    'getServerTime',
    'getMarkPrice',
    'getFundingRate',
    'getBasisSnapshot',
  ]);
  return new Proxy(Object.create(null) as MarketDataPort, {
    get(_target, property) {
      const value = Reflect.get(source, property);
      if (typeof property !== 'string' || typeof value !== 'function') return value;
      if (!capturedMethods.has(property)) return value;
      return async (...args: unknown[]) => {
        requestStarted();
        const requestedAtMs = now();
        const requestedAtMonotonicMs = performance.now();
        try {
          const response = await value(...args);
          const receivedAtMonotonicMs = performance.now();
          try {
            recordRequest({
              method: property,
              args,
              requestedAtMs,
              receivedAtMs: now(),
              requestedAtMonotonicMs,
              receivedAtMonotonicMs,
              response,
            });
          } catch {
            // Raw REST capture is observational; persistence failures are counted separately.
          }
          return response;
        } catch (error) {
          try {
            recordRequest({
              method: property,
              args,
              requestedAtMs,
              receivedAtMs: now(),
              requestedAtMonotonicMs,
              receivedAtMonotonicMs: performance.now(),
              error: error instanceof Error ? error.message : String(error),
            });
          } catch {
            // Keep the original public request failure when observational logging also fails.
          }
          throw error;
        } finally {
          requestFinished();
        }
      };
    },
    has(_target, property) {
      return Reflect.has(source, property);
    },
  });
}

export function buildEffectiveCaptureConfiguration(
  policySource: unknown,
  policySourceSha256: string,
  output: string,
  durationSeconds: number,
  rateLimitDbPath = 'SUPERVISOR_MONITOR/public-rate-limit.sqlite3',
): {
  config: MicroBurstRuntimeConfig;
  effectiveConfig: Record<string, unknown>;
  configHash: string;
} {
  if (!Number.isSafeInteger(durationSeconds) || durationSeconds < 360 || durationSeconds > 1200)
    throw new Error('COLLECTOR_DURATION_MUST_BE_360_TO_1200_SECONDS');
  const config = parseMicroBurstConfig(policySource);
  // Policy thresholds are preserved, but activation, symbols, archival and paper settings
  // are owned by this capture request, not by the operational YAML's enable/mode fields.
  config.enabled = true;
  config.mode = 'SHADOW';
  config.symbols = Object.fromEntries(
    ['SOLUSDT', 'AVAXUSDT'].map((symbol) => [symbol, { enabled: true }]),
  );
  config.marketArchive = {
    ...config.marketArchive,
    enabled: true,
    rootDir: output,
    bookCheckpointIntervalMs: 1000,
    rawTradeArchive: true,
    rawDepthArchive: true,
    maxActiveSegmentRecords: MAX_ACTIVE_SEGMENT_RECORDS,
    maxActiveSegmentBytes: MAX_ACTIVE_SEGMENT_BYTES,
    maxActiveSegmentDurationMs: MAX_ACTIVE_SEGMENT_DURATION_MS,
    durabilityFlushIntervalMs: DURABILITY_FLUSH_INTERVAL_MS,
  };
  config.prospectiveValidation = { ...config.prospectiveValidation, enabled: false };
  const effectiveConfig: Record<string, unknown> = {
    schema: 'MICRO_OBSERVATIONAL_CAPTURE_CONFIG_V1',
    authority: 'PUBLIC_MARKET_DATA_OBSERVATION_ONLY',
    sourcePolicyConfigSha256: policySourceSha256,
    rateLimitIsolation: {
      limiterProcessLabel: '01-Trading-Bot legacy source label',
      databasePath: rateLimitDbPath,
      sharedWithOperationalBot: false,
      scope: 'FRESH_UNIQUE_SUPERVISOR_FILE_PER_CAPTURE',
    },
    activation: 'EXPLICIT_CAPTURE_SHADOW_OVERRIDE',
    mode: config.mode,
    enabled: config.enabled,
    symbols: ['SOLUSDT', 'AVAXUSDT'],
    benchmarkSymbols: ['BTCUSDT'],
    requestedDurationSeconds: durationSeconds,
    runtime: {
      evaluationIntervalMs: EVALUATION_INTERVAL_MS,
      warmupRequiredMs: 300_000,
      minimumPostWarmupWindowMs: 60_000,
      tradeFlowWindowMs: 300_000,
      benchmarkCandleInterval: '1m',
      benchmarkWarmupCandleCount: 60,
      benchmarkPollIntervalMs: 60_000,
      strategyCandleIntervals: ['1m', '3m', '5m'],
      healthReportingIntervalMs: 5000,
      maximumDurationSeconds: 1200,
      shutdownDrainTimeoutMs: 30_000,
      publicRestDrainTimeoutMs: 30_000,
      supervisorShutdownGraceMs: 120_000,
      paperTradingEnabled: false,
      prospectiveValidationEnabled: false,
      maxPublicRestRequestsInFlight: MAX_PUBLIC_REQUESTS_IN_FLIGHT,
    },
    limits: {
      captureBytes: MAX_CAPTURE_BYTES,
      processMemoryBytes: MAX_CAPTURE_MEMORY_BYTES,
      minimumFreeDiskReserveBytes: MIN_FREE_DISK_RESERVE_BYTES,
      stopCaptureBytes: CAPTURE_DISK_STOP_BYTES,
      marketQueueRecords: MAX_CAPTURE_QUEUE_RECORDS,
      activeSegmentBytes: MAX_ACTIVE_SEGMENT_BYTES,
      activeSegmentRecords: MAX_ACTIVE_SEGMENT_RECORDS,
      activeSegmentDurationMs: MAX_ACTIVE_SEGMENT_DURATION_MS,
      decisionObservationQueue: MICRO_EVIDENCE_LIMITS,
      signalJournalMaxEntriesPerFile: 10_000,
      episodeCapturePendingWrites: EPISODE_CAPTURE_PENDING_LIMIT,
      orderBook: {
        snapshotLevels: ORDER_BOOK_SNAPSHOT_DEPTH,
        featureLevels: ORDER_BOOK_FEATURE_DEPTH,
        diffSpeed: '100ms',
        checkpointIntervalMs: 1000,
      },
      writers: {
        decisions: { maxBytes: 64 * 1024 * 1024, maxPendingWrites: 256, compressRotated: true },
        snapshots: {
          maxBytes: 32 * 1024 * 1024,
          maxPendingWrites: 256,
          compressRotated: true,
          dedupeWindowMs: 300_000,
          maxDedupeEntries: 4096,
        },
        events: { maxBytes: 32 * 1024 * 1024, maxPendingWrites: 256, compressRotated: true },
        rawRest: { maxBytes: 32 * 1024 * 1024, maxPendingWrites: 256, compressRotated: true },
      },
    },
    strategyConfig: config,
  };
  return {
    config,
    effectiveConfig,
    configHash: createHash('sha256').update(JSON.stringify(effectiveConfig)).digest('hex'),
  };
}

/** Separate public-data observer. There is deliberately no LIVE execution port. */
export async function runContinuousCollector(root: string, durationSeconds: number): Promise<void> {
  if (!Number.isSafeInteger(durationSeconds) || durationSeconds < 360 || durationSeconds > 1200)
    throw new Error('COLLECTOR_DURATION_MUST_BE_360_TO_1200_SECONDS');
  if ((process.env.BINANCE_API_KEY ?? '') !== '' || (process.env.BINANCE_API_SECRET ?? '') !== '')
    throw new Error('COLLECTOR_CREDENTIALS_PROHIBITED');
  const collectorRoot = resolve(root);
  const producer = verifyFrozenCollectorArtifact(collectorRoot);
  const rateLimitDbPathEnv = process.env.BINANCE_SHARED_RATE_LIMIT_DB;
  if (!rateLimitDbPathEnv || !isAbsolute(rateLimitDbPathEnv))
    throw new Error('CAPTURE_RATE_LIMIT_DATABASE_ISOLATION_REQUIRED');
  const rateLimitDbPath = resolve(rateLimitDbPathEnv);
  const rateLimitRelative = relative(collectorRoot, rateLimitDbPath);
  if (
    rateLimitRelative === '' ||
    (!isAbsolute(rateLimitRelative) &&
      rateLimitRelative !== '..' &&
      !rateLimitRelative.startsWith(`..${sep}`))
  )
    throw new Error('CAPTURE_RATE_LIMIT_DATABASE_MUST_BE_OUTSIDE_CAPTURE_ROOT');
  if (
    existsSync(rateLimitDbPath) ||
    existsSync(`${rateLimitDbPath}-wal`) ||
    existsSync(`${rateLimitDbPath}-shm`)
  )
    throw new Error('CAPTURE_RATE_LIMIT_DATABASE_MUST_BE_NEW');
  const output = join(collectorRoot, 'capture');
  const {
    config: cfg,
    effectiveConfig,
    configHash,
  } = buildEffectiveCaptureConfiguration(
    load(readFileSync(join(collectorRoot, 'regime_config.live.yaml'), 'utf8')),
    producer.configSha256,
    output,
    durationSeconds,
    rateLimitDbPath,
  );
  const diskStats = statfsSync(collectorRoot);
  const availableDiskBytes = diskStats.bavail * diskStats.bsize;
  if (availableDiskBytes < MAX_CAPTURE_BYTES + MIN_FREE_DISK_RESERVE_BYTES)
    throw new Error('COLLECTOR_DISK_BUDGET_UNAVAILABLE');
  writeFileSync(
    join(collectorRoot, 'effective-config.json'),
    JSON.stringify(effectiveConfig, null, 2),
    {
      flag: 'wx',
      mode: 0o600,
    },
  );
  mkdirSync(output, { recursive: true });
  const episodeCaptureStartedAtMs = Date.now();
  let sessionStartedAtMs = episodeCaptureStartedAtMs;
  const episodeCapture = await MicroBurstEpisodeCapture.create(
    join(output, 'episode-capture'),
    { config: effectiveConfig, producer },
    episodeCaptureStartedAtMs,
    EPISODE_CAPTURE_PENDING_LIMIT,
  );
  const writerConfiguration = (
    effectiveConfig.limits as {
      writers: {
        decisions: { maxBytes: number; maxPendingWrites: number; compressRotated: boolean };
        snapshots: {
          maxBytes: number;
          maxPendingWrites: number;
          compressRotated: boolean;
          dedupeWindowMs: number;
          maxDedupeEntries: number;
        };
        events: { maxBytes: number; maxPendingWrites: number; compressRotated: boolean };
        rawRest: { maxBytes: number; maxPendingWrites: number; compressRotated: boolean };
      };
    }
  ).writers;
  const auxiliaryWriterOptions = {
    ...writerConfiguration.events,
  };
  const events = new RotatingJsonlWriter(join(output, 'events.jsonl'), auxiliaryWriterOptions);
  const rawRest = new RotatingJsonlWriter(join(output, 'rest-inputs.jsonl'), {
    ...writerConfiguration.rawRest,
  });
  let auxiliaryWriteFailures = 0;
  let publicRequestsInFlight = 0;
  const pendingAuxiliaryWrites = new Set<Promise<void>>();
  const trackAuxiliaryWrite = (start: () => Promise<void>): void => {
    let tracked: Promise<void>;
    try {
      tracked = start()
        .catch(() => {
          auxiliaryWriteFailures++;
        })
        .finally(() => pendingAuxiliaryWrites.delete(tracked));
    } catch {
      auxiliaryWriteFailures++;
      return;
    }
    pendingAuxiliaryWrites.add(tracked);
  };
  const log = (level: string, message: string, context?: unknown): void => {
    trackAuxiliaryWrite(() => events.append({ atMs: Date.now(), level, message, context }));
  };
  const logger: Logger = {
    debug: () => {},
    info: (m, c) => log('info', m, c),
    warn: (m, c) => log('warn', m, c),
    error: (m, c) => log('error', m, c),
  };
  const audited = createReadOnlyBinanceMarketData(logger, producer.gitCommit);
  const exchange = wrapPublicMarketDataForCapture(
    audited.exchange,
    (entry) => trackAuxiliaryWrite(() => rawRest.append(entry)),
    () => publicRequestsInFlight++,
    () => publicRequestsInFlight--,
  );
  const storage = new MicroBurstStorage({
    databasePath: join(output, 'research.sqlite'),
    archivePath: join(output, 'market-data'),
    maxArchiveQueueRecords: MAX_CAPTURE_QUEUE_RECORDS,
    maxActiveSegmentRecords: MAX_ACTIVE_SEGMENT_RECORDS,
    maxActiveSegmentBytes: MAX_ACTIVE_SEGMENT_BYTES,
    deferRawWrites: true,
    maxActiveSegmentDurationMs: MAX_ACTIVE_SEGMENT_DURATION_MS,
    durabilityFlushIntervalMs: DURABILITY_FLUSH_INTERVAL_MS,
    maxDeferredWriteBatchRecords: 128,
    maxDeferredWriteBatchMs: 10,
  });
  const decisions = new JsonlDecisionEvidenceSink(
    join(output, 'decisions.jsonl'),
    writerConfiguration.decisions,
  );
  const snapshots = new JsonlMarketSnapshotSink(
    join(output, 'snapshots.jsonl'),
    writerConfiguration.snapshots,
  );
  const lastAt = new Map<string, number>();
  const cadence = new Map<
    string,
    { observations: number; gapsOver2s: number; maxGapMs: number; lastGapMs: number }
  >();
  const seen = new Set<string>();
  const runtime = composeCaptureObservationRuntime({
    config: cfg,
    producer,
    configHash,
    signalJournalDir: join(output, 'signals'),
    runtimeDeps: {
      exchange,
      logger,
      clock: { now: Date.now },
      marketStorage: storage,
      provenance: {
        codeCommitSha: producer.gitCommit,
        configHash,
        cohortId: `COLLECTOR-${producer.artifactHash.slice(0, 12)}-${configHash.slice(0, 12)}`,
        officialCohortReady: false,
      },
      mutationAudit: () => ({
        totalMutationAttempts: audited.audit.totalMutationAttempts,
        forwardedMutationCalls: audited.audit.forwardedMutationCalls,
      }),
      blackBox: {
        marketSnapshotSink: snapshots,
        decisionSink: {
          async append(record) {
            await decisions.append(record);
            await episodeCapture.append({
              kind: 'DECISION',
              receivedAtMs: Date.now(),
              decision: record,
            });
            const previous = lastAt.get(record.symbol);
            const gap = previous === undefined ? 0 : record.evaluatedAtReceivedMs - previous;
            const metric = cadence.get(record.symbol) ?? {
              observations: 0,
              gapsOver2s: 0,
              maxGapMs: 0,
              lastGapMs: 0,
            };
            metric.observations++;
            metric.lastGapMs = gap;
            metric.maxGapMs = Math.max(metric.maxGapMs, gap);
            if (gap > 2000) {
              metric.gapsOver2s++;
              const gapRecord = {
                atMs: Date.now(),
                message: 'OBSERVATION_CADENCE_GAP',
                symbol: record.symbol,
                fromMs: previous ?? record.evaluatedAtReceivedMs,
                throughMs: record.evaluatedAtReceivedMs,
              };
              await events.append(gapRecord);
              await episodeCapture.append({
                kind: 'GAP',
                receivedAtMs: Date.now(),
                fromMs: previous ?? record.evaluatedAtReceivedMs,
                throughMs: record.evaluatedAtReceivedMs,
                symbol: record.symbol,
                reason: 'OBSERVATION_CADENCE_GAP',
              });
            }
            cadence.set(record.symbol, metric);
            lastAt.set(record.symbol, record.evaluatedAtReceivedMs);
            if (record.decision === 'ENTRY_INTENT') {
              const id = record.diagnostics.episodeId;
              if (typeof id === 'string') seen.add(id);
            }
          },
          appendPersistenceTiming: (record) => decisions.appendPersistenceTiming(record),
        },
      },
    },
  });
  const lag = monitorEventLoopDelay({ resolution: 20 });
  lag.enable();
  let timer: NodeJS.Timeout | undefined;
  let end: NodeJS.Timeout | undefined;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const shutdownFailures: string[] = [];
  let externalStopReason: string | null = null;
  let stopFinished = false;
  const stop = (reason?: string): void => {
    if (reason) externalStopReason ??= reason;
    if (stopFinished) return;
    stopFinished = true;
    finish();
  };
  const onSigterm = (): void => stop('SIGTERM');
  const onSigint = (): void => stop('SIGINT');
  process.once('SIGTERM', onSigterm);
  process.once('SIGINT', onSigint);
  let lastHealthSha256: string | null = null;
  const health = (enforceSafetyLimits = true): Record<string, unknown> => {
    const memory = process.memoryUsage();
    const captureBytes = directoryBytes(output);
    const disk = statfsSync(output);
    const freeDiskBytes = disk.bavail * disk.bsize;
    const runtimeHealth = runtime.getHealth();
    const report: Record<string, unknown> = {
      pid: process.pid,
      startedAtMs: sessionStartedAtMs,
      atMs: Date.now(),
      sourceArtifactHash: producer.artifactHash,
      configHash,
      liveExecution: false,
      runtime: runtimeHealth,
      observations: Object.fromEntries(cadence),
      decisionWriter: decisions.health(),
      restWriter: rawRest.health(),
      eventWriter: events.health(),
      snapshotWriter: snapshots.health(),
      auxiliaryWriteFailures,
      memory,
      cpu: process.cpuUsage(),
      eventLoopP99Ms: lag.percentile(99) / 1e6,
      captureBytes,
      availableDiskBytes: freeDiskBytes,
      publicRequestsInFlight,
      auxiliaryWritesPending: pendingAuxiliaryWrites.size,
      mutationAudit: audited.audit,
    };
    const counterReconciliation = reconcileMicroBurstCaptureCounters(report);
    report.counterReconciliation = counterReconciliation;
    try {
      const bytes = JSON.stringify(report);
      writeFileSync(join(collectorRoot, 'health.json.tmp'), bytes, { mode: 0o600 });
      renameSync(join(collectorRoot, 'health.json.tmp'), join(collectorRoot, 'health.json'));
      lastHealthSha256 = createHash('sha256').update(bytes).digest('hex');
    } catch (error) {
      shutdownFailures.push(`HEALTH_WRITE_FAILED:${String(error)}`);
      stop('HEALTH_WRITE_FAILED');
    }
    if (enforceSafetyLimits) {
      if (runtimeHealth.mutationAttempts > 0 || runtimeHealth.forwardedMutations > 0)
        stop('MUTATION_ATTEMPT');
      if (runtimeHealth.totalEvaluationFailures > 0) stop('EVALUATION_FAILURE');
      if ((runtimeHealth.archiveOverflowRecords ?? 0) > 0) stop('ARCHIVE_QUEUE_OVERFLOW');
      if ((runtimeHealth.archiveQueueDepth ?? 0) >= Math.floor(MAX_CAPTURE_QUEUE_RECORDS * 0.75))
        stop('ARCHIVE_QUEUE_PRESSURE');
      if (auxiliaryWriteFailures > 0) stop('AUXILIARY_WRITE_FAILURE');
      const observation = (runtimeHealth.observationQueue ?? {}) as Record<string, unknown>;
      if ((Number(observation.captureFailures) || 0) > 0) stop('EXACT_INPUT_CAPTURE_FAILURE');
      if ((Number(observation.dropped) || 0) > 0) stop('OBSERVATION_QUEUE_DROP');
      if ((Number(observation.failed) || 0) > 0) stop('OBSERVATION_QUEUE_WRITE_FAILURE');
      if (observation.drainTimedOut === true) stop('OBSERVATION_QUEUE_DRAIN_TIMEOUT');
      if (publicRequestsInFlight > MAX_PUBLIC_REQUESTS_IN_FLIGHT) stop('PUBLIC_REQUEST_BACKLOG');
      if (memory.rss > MAX_CAPTURE_MEMORY_BYTES) stop('PROCESS_MEMORY_LIMIT');
      if (captureBytes >= CAPTURE_DISK_STOP_BYTES) stop('CAPTURE_DISK_LIMIT');
      if (freeDiskBytes < MIN_FREE_DISK_RESERVE_BYTES) stop('FREE_DISK_RESERVE_LIMIT');
      if (
        Number(runtimeHealth.observationQueue?.pendingRecords ?? 0) >=
        MICRO_EVIDENCE_LIMITS.maxRecords - 2
      )
        stop('DECISION_OBSERVATION_QUEUE_PRESSURE');
      if (
        Math.max(
          decisions.health().pendingWrites,
          rawRest.health().pendingWrites,
          events.health().pendingWrites,
          snapshots.health().pendingWrites,
        ) >= 224
      )
        stop('AUXILIARY_WRITER_QUEUE_PRESSURE');
      if (
        [decisions.health(), snapshots.health(), rawRest.health(), events.health()].some(
          (writer) => writer.writeFailures > 0 || writer.overloadRejected > 0,
        )
      )
        stop('AUXILIARY_WRITER_FAILURE');
      if (lag.percentile(99) / 1e6 > 1000) stop('EVENT_LOOP_LAG_LIMIT');
    }
    return report;
  };
  let runFailure: unknown;
  try {
    await runtime.start();
    sessionStartedAtMs = Date.now();
    health();
    timer = setInterval(() => health(), 5000);
    end = setTimeout(() => stop(), durationSeconds * 1000);
    await done;
  } catch (error) {
    runFailure = error;
    shutdownFailures.push(`COLLECTOR_RUNTIME_FAILED:${String(error)}`);
  } finally {
    if (timer) clearInterval(timer);
    if (end) clearTimeout(end);
    process.removeListener('SIGTERM', onSigterm);
    process.removeListener('SIGINT', onSigint);
    if (externalStopReason) shutdownFailures.push(`CAPTURE_INTERRUPTED:${externalStopReason}`);
    const attempt = async (name: string, work: () => Promise<unknown> | unknown): Promise<void> => {
      try {
        await work();
      } catch (error) {
        shutdownFailures.push(`${name}:${String(error)}`);
      }
    };
    await attempt('runtime_stop', () => runtime.stop());
    await attempt('websocket_disconnect', () => audited.disconnectAll());
    const publicDrainDeadline = Date.now() + 30_000;
    while (publicRequestsInFlight > 0 && Date.now() < publicDrainDeadline)
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    if (publicRequestsInFlight > 0) shutdownFailures.push('PUBLIC_REST_REQUEST_DRAIN_TIMEOUT');
    await Promise.allSettled([...pendingAuxiliaryWrites]);
    if (pendingAuxiliaryWrites.size > 0) shutdownFailures.push('AUXILIARY_WRITES_STILL_PENDING');
    await attempt('decisions_drain', () => decisions.drain());
    await attempt('snapshots_drain', () => snapshots.drain());
    await attempt('events_drain', () => events.drain());
    await attempt('rest_inputs_drain', () => rawRest.drain());
    let episodeCompletion: Awaited<ReturnType<MicroBurstEpisodeCapture['close']>> | null = null;
    try {
      episodeCompletion = await episodeCapture.close();
      if (episodeCompletion.failed || episodeCompletion.pendingWrites !== 0)
        shutdownFailures.push('EPISODE_CAPTURE_INCOMPLETE');
    } catch (error) {
      shutdownFailures.push(`EPISODE_CAPTURE_CLOSE:${String(error)}`);
    }
    if (auxiliaryWriteFailures > 0) shutdownFailures.push('AUXILIARY_WRITES_FAILED');
    const finalHealth = health(false);
    const completedAtMs = Date.now();
    writeFileSync(
      join(collectorRoot, 'completion.json'),
      JSON.stringify({
        completedAtMs,
        acceptedEpisodes: [...seen],
        lifecycle: 'SESSION_ENDED_NOT_AUTOMATICALLY_EPISODE_COMPLETE',
        failed: shutdownFailures.length > 0 || episodeCompletion?.failed === true,
        shutdownFailures,
        episodeCapture: episodeCompletion,
        counterReconciliation: finalHealth.counterReconciliation,
        finalHealthSha256: lastHealthSha256,
        externalStopReason,
        auxiliaryWriteFailures,
        mutationAttempts: audited.audit.totalMutationAttempts,
        forwardedMutations: audited.audit.forwardedMutationCalls,
      }),
      { flag: 'wx', mode: 0o600 },
    );
    await attempt('capture_session_manifest', () =>
      writeCaptureSessionManifest({
        collectorRoot,
        captureRoot: output,
        producer,
        configHash,
        startedAtMs: sessionStartedAtMs,
        completedAtMs,
        shutdownFailures,
        auxiliaryWriteFailures,
      }),
    );
    lag.disable();
  }
  if (runFailure) throw runFailure;
  if (shutdownFailures.length)
    throw new Error(`COLLECTOR_SHUTDOWN_INCOMPLETE:${shutdownFailures.join(';')}`);
}

function directoryBytes(directory: string): number {
  return readdirSync(directory, { withFileTypes: true }).reduce((total, entry) => {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) return total;
    return total + (entry.isDirectory() ? directoryBytes(path) : statSync(path).size);
  }, 0);
}

if (require.main === module)
  ((): Promise<void> => {
    const collectorRoot = process.argv[2];
    const durationText = process.argv[3];
    if (!collectorRoot || !durationText)
      throw new Error(
        'USAGE: MicroBurstContinuousCollector <frozen-collector-root> <duration-seconds-360-to-1200>',
      );
    return runContinuousCollector(collectorRoot, Number(durationText));
  })().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(error instanceof Error ? error.stack : String(error));
      process.exit(1);
    },
  );
