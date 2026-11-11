import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { load } from 'js-yaml';
import { createReadOnlyBinanceMarketData } from '../../infra/adapters/ReadOnlyBinanceMarketData';
import { MicroBurstRuntime } from '../../strategies/micro-burst/application/MicroBurstRuntime';
import { parseMicroBurstConfig } from '../../strategies/micro-burst/application/MicroBurstConfigLoader';
import { MicroBurstStorage } from '../../strategies/micro-burst/research/MicroBurstStorage';
import { MicroBurstEpisodeCapture } from './MicroBurstEpisodeCapture';
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
import { FileShadowTradeJournal } from '../../core/shadow/ShadowTradeJournal';
import { RotatingJsonlWriter } from '../../infra/logging/RotatingJsonlWriter';
import type { Logger } from '../../app/ports/Logger';

/** Separate public-data observer. There is deliberately no LIVE execution port. */
export async function runContinuousCollector(root: string, durationSeconds: number): Promise<void> {
  if (!Number.isFinite(durationSeconds) || durationSeconds < 360)
    throw new Error('COLLECTOR_MINIMUM_360_SECONDS');
  if (process.env.BINANCE_API_KEY || process.env.BINANCE_API_SECRET)
    throw new Error('COLLECTOR_CREDENTIALS_PROHIBITED');
  const collectorRoot = resolve(root);
  const producer = verifyFrozenCollectorArtifact(collectorRoot);
  const cfg = parseMicroBurstConfig(
    load(readFileSync(join(collectorRoot, 'regime_config.live.yaml'), 'utf8')),
  );
  cfg.enabled = true;
  cfg.mode = 'SHADOW';
  cfg.symbols = Object.fromEntries(['SOLUSDT', 'AVAXUSDT'].map((s) => [s, { enabled: true }]));
  cfg.marketArchive = { ...cfg.marketArchive, enabled: true, bookCheckpointIntervalMs: 1000 };
  cfg.prospectiveValidation = { ...cfg.prospectiveValidation, enabled: true };
  const configHash = createHash('sha256').update(JSON.stringify(cfg)).digest('hex');
  writeFileSync(join(collectorRoot, 'effective-config.json'), JSON.stringify(cfg, null, 2), {
    flag: 'wx',
    mode: 0o600,
  });
  const output = join(collectorRoot, 'capture');
  mkdirSync(output, { recursive: true });
  const sessionStartedAtMs = Date.now();
  const episodeCapture = await MicroBurstEpisodeCapture.create(
    join(output, 'episode-capture'),
    { config: cfg, producer },
    sessionStartedAtMs,
  );
  const events = new RotatingJsonlWriter(join(output, 'events.jsonl'));
  const rawRest = new RotatingJsonlWriter(join(output, 'rest-inputs.jsonl'));
  let auxiliaryWriteFailures = 0;
  const log = (level: string, message: string, context?: unknown): void => {
    void events.append({ atMs: Date.now(), level, message, context }).catch(() => {
      auxiliaryWriteFailures++;
    });
  };
  const logger: Logger = {
    debug: () => {},
    info: (m, c) => log('info', m, c),
    warn: (m, c) => log('warn', m, c),
    error: (m, c) => log('error', m, c),
  };
  const audited = createReadOnlyBinanceMarketData(logger, producer.gitCommit);
  const exchange = new Proxy(audited.exchange, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (typeof value !== 'function') return value;
      if (!['getCandles', 'getDepthSnapshot', 'getServerTime'].includes(String(property)))
        return value.bind(target);
      return async (...args: unknown[]) => {
        const requestedAtMs = Date.now();
        const response = await value.apply(target, args);
        const receivedAtMs = Date.now();
        void rawRest
          .append({ method: property, args, requestedAtMs, receivedAtMs, response })
          .catch(() => {
            auxiliaryWriteFailures++;
          });
        return response;
      };
    },
  });
  const storage = new MicroBurstStorage({
    databasePath: join(output, 'research.sqlite'),
    archivePath: join(output, 'market-data'),
    deferRawWrites: true,
    maxActiveSegmentDurationMs: 30_000,
    durabilityFlushIntervalMs: 1000,
  });
  const router = new StrategyRouter<MicroBurstStrategyContext>();
  router.register(
    new MicroBurstStrategy(
      createMicroBurstIdentity(producer.gitCommit, configHash),
      'SHADOW',
      cfg.exitPolicy,
    ),
  );
  const decisions = new JsonlDecisionEvidenceSink(join(output, 'decisions.jsonl'));
  const snapshots = new JsonlMarketSnapshotSink(join(output, 'snapshots.jsonl'));
  const lastAt = new Map<string, number>();
  const cadence = new Map<
    string,
    { observations: number; gapsOver2s: number; maxGapMs: number; lastGapMs: number }
  >();
  const seen = new Set<string>();
  const runtime = new MicroBurstRuntime(
    {
      exchange,
      logger,
      clock: { now: Date.now },
      strategyRouter: router,
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
      shadowTradeJournal: new FileShadowTradeJournal(
        join(output, 'paper-trades'),
        join(output, 'paper-events'),
      ),
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
    cfg,
    500,
    join(output, 'signals'),
  );
  const lag = monitorEventLoopDelay({ resolution: 20 });
  lag.enable();
  let timer: NodeJS.Timeout | undefined;
  let end: NodeJS.Timeout | undefined;
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const stop = (): void => finish();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  const health = (): void => {
    const report = {
      pid: process.pid,
      startedAtMs: sessionStartedAtMs,
      atMs: Date.now(),
      sourceArtifactHash: producer.artifactHash,
      configHash,
      liveExecution: false,
      runtime: runtime.getHealth(),
      observations: Object.fromEntries(cadence),
      decisionWriter: decisions.health(),
      restWriter: rawRest.health(),
      eventWriter: events.health(),
      snapshotWriter: snapshots.health(),
      auxiliaryWriteFailures,
      memory: process.memoryUsage(),
      cpu: process.cpuUsage(),
      eventLoopP99Ms: lag.percentile(99) / 1e6,
      mutationAudit: audited.audit,
    };
    writeFileSync(join(collectorRoot, 'health.json.tmp'), JSON.stringify(report), { mode: 0o600 });
    renameSync(join(collectorRoot, 'health.json.tmp'), join(collectorRoot, 'health.json'));
  };
  const shutdownFailures: string[] = [];
  let runFailure: unknown;
  try {
    await runtime.start();
    timer = setInterval(health, 5000);
    end = setTimeout(stop, durationSeconds * 1000);
    await done;
  } catch (error) {
    runFailure = error;
  } finally {
    if (timer) clearInterval(timer);
    if (end) clearTimeout(end);
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    const attempt = async (name: string, work: () => Promise<unknown> | unknown): Promise<void> => {
      try {
        await work();
      } catch (error) {
        shutdownFailures.push(`${name}:${String(error)}`);
      }
    };
    await attempt('runtime_stop', () => runtime.stop());
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
    await attempt('websocket_disconnect', () => audited.disconnectAll());
    health();
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

if (require.main === module)
  runContinuousCollector(process.argv[2], Number(process.argv[3] ?? 86400)).then(
    () => process.exit(0),
    (error: unknown) => {
      console.error(error instanceof Error ? error.stack : String(error));
      process.exit(1);
    },
  );
