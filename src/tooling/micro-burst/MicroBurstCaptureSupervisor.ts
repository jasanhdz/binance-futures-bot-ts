import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { MICRO_PAIRED_REPLAY_EVIDENCE_CONTRACT_SHA256 } from './MicroBurstReplayEvidenceContract';

const MAX_HARD_TIMEOUT_GRACE_MS = 120_000;
const MAX_TERMINATION_GRACE_MS = 45_000;
const HEALTH_SAMPLE_MS = 5000;
const HEALTH_STALE_MS = 15_000;
export const CAPTURE_CANCELLATION_CONDITIONS = [
  'health file absent after startup grace or stale for over 15 seconds',
  'any public market mutation attempt or forwarded mutation',
  'paper simulation or live execution reported enabled',
  'any evaluator failure, archive overflow, observation drop, or writer failure',
  'public REST requests in flight above sixteen',
  'archive queue reaches 75 percent of configured capacity',
  'decision observation queue reaches capacity minus two',
  'any writer queue reaches 224 pending writes',
  'capture bytes reach the 960 MiB stop threshold',
  'process RSS reaches 1.5 GiB',
  'free disk falls below 1.5 GiB',
  'event-loop P99 exceeds 1000 ms',
  'BTC context or both symbol books are unavailable after 330 seconds',
  'hard process timeout at planned duration plus 120 seconds; SIGTERM then SIGKILL after 45 seconds',
] as const;

export interface MicroBurstCaptureRunPlan {
  schema: 'MICRO_OBSERVATIONAL_CAPTURE_RUN_PLAN_V1';
  collectorRoot: string;
  monitorDirectory: string;
  expectedProducerCommit: string;
  expectedProducerArtifactHash: string;
  durationSeconds: number;
  symbols: readonly ['SOLUSDT', 'AVAXUSDT'];
  benchmarkSymbols: readonly ['BTCUSDT'];
  warmupMs: number;
  minimumPostWarmupWindowMs: number;
  replayFromSessionStartOffsetMs: number;
  replayThroughSessionEndOffsetMs: number;
  experimentContractSha256: string;
  cancellationConditions: readonly string[];
  maxCaptureBytes: number;
  stopCaptureBytes: number;
  maxProcessMemoryBytes: number;
  minimumFreeDiskBytes: number;
  maxArchiveQueueRecords: number;
  maxDecisionObservationQueueRecords: number;
  maxPublicRequestsInFlight: number;
}

/** Spawns exactly one frozen collector with an allowlisted, credential-free environment. */
export async function runMicroBurstCapturePlan(planPath: string): Promise<Record<string, unknown>> {
  const planBytes = readFileSync(resolve(planPath));
  if (planBytes.length <= 0 || planBytes.length > 64 * 1024)
    throw new Error('CAPTURE_RUN_PLAN_SIZE_INVALID');
  let plan: MicroBurstCaptureRunPlan;
  try {
    plan = JSON.parse(planBytes.toString('utf8')) as MicroBurstCaptureRunPlan;
  } catch {
    throw new Error('CAPTURE_RUN_PLAN_JSON_INVALID');
  }
  validateCaptureRunPlan(plan);
  const collectorRoot = resolve(plan.collectorRoot);
  const monitorDirectory = resolve(plan.monitorDirectory);
  assertSeparatePath(collectorRoot, monitorDirectory);
  const manifest = JSON.parse(readFileSync(join(collectorRoot, 'manifest.json'), 'utf8')) as {
    schema?: string;
    gitCommit?: string;
    artifactHash?: string;
  };
  if (
    manifest.schema !== 'MICRO_COLLECTOR_FROZEN_V2' ||
    manifest.gitCommit !== plan.expectedProducerCommit ||
    manifest.artifactHash !== plan.expectedProducerArtifactHash ||
    !manifest.artifactHash
  )
    throw new Error('CAPTURE_RUN_PLAN_PRODUCER_IDENTITY_MISMATCH');
  const codePath = join(
    collectorRoot,
    'code',
    'tooling/micro-burst/MicroBurstContinuousCollector.js',
  );
  if (statSync(codePath).size <= 0) throw new Error('FROZEN_COLLECTOR_ENTRYPOINT_MISSING');

  mkdirSync(monitorDirectory, { recursive: false, mode: 0o700 });
  const monitorPath = join(monitorDirectory, 'monitor.jsonl');
  const stdoutPath = join(monitorDirectory, 'collector.stdout.log');
  const stderrPath = join(monitorDirectory, 'collector.stderr.log');
  const monitor = createWriteStream(monitorPath, { flags: 'wx', mode: 0o600 });
  const stdout = createWriteStream(stdoutPath, { flags: 'wx', mode: 0o600 });
  const stderr = createWriteStream(stderrPath, { flags: 'wx', mode: 0o600 });
  const env = sanitizedCollectorEnvironment(collectorRoot, monitorDirectory);
  const child = spawn(process.execPath, [codePath, collectorRoot, String(plan.durationSeconds)], {
    cwd: collectorRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.pipe(stdout);
  child.stderr?.pipe(stderr);
  const startedAtMs = Date.now();
  const planSha256 = createHash('sha256').update(planBytes).digest('hex');
  const deadline = startedAtMs + plan.durationSeconds * 1000 + MAX_HARD_TIMEOUT_GRACE_MS;
  let settled = false;
  let result: { code: number | null; signal: NodeJS.Signals | null } = {
    code: null,
    signal: null,
  };
  let childError: string | null = null;
  let monitorError: string | null = null;
  let healthSeenAt = startedAtMs;
  let stopReason: string | null = null;
  child.once('error', (error) => {
    childError = String(error);
    settled = true;
  });
  child.once('close', (code, signal) => {
    result = { code, signal };
    settled = true;
  });
  for (const stream of [monitor, stdout, stderr])
    stream.once('error', (error) => {
      monitorError ??= String(error);
    });

  const requestStop = (reason: string): void => {
    if (stopReason) return;
    stopReason = reason;
    record({ atMs: Date.now(), event: 'SAFETY_STOP_REQUESTED', reason, pid: child.pid ?? null });
    if (child.pid) child.kill('SIGTERM');
  };
  const record = (entry: Record<string, unknown>): void => {
    monitor.write(`${JSON.stringify(entry)}\n`);
  };

  while (!settled) {
    await new Promise<void>((resolveSleep) => setTimeout(resolveSleep, HEALTH_SAMPLE_MS));
    if (settled) break;
    const now = Date.now();
    if (monitorError) requestStop('SUPERVISOR_LOG_FAILURE');
    if (now > deadline) {
      requestStop('SUPERVISOR_HARD_TIMEOUT');
      const terminateDeadline = Date.now() + MAX_TERMINATION_GRACE_MS;
      while (!settled && Date.now() < terminateDeadline)
        await new Promise<void>((resolveSleep) => setTimeout(resolveSleep, 100));
      if (!settled && child.pid) child.kill('SIGKILL');
      continue;
    }
    let health: Record<string, any>;
    try {
      health = JSON.parse(readFileSync(join(collectorRoot, 'health.json'), 'utf8')) as Record<
        string,
        any
      >;
    } catch {
      if (now - startedAtMs > 60_000) requestStop('HEALTH_FILE_NOT_PRODUCED');
      continue;
    }
    if (health.pid !== child.pid) {
      requestStop('COLLECTOR_HEALTH_PID_MISMATCH');
      continue;
    }
    if (health.atMs !== healthSeenAt) healthSeenAt = health.atMs;
    const reason = healthStopReason(health, plan, now, healthSeenAt);
    record({
      atMs: now,
      event: 'HEALTH_SAMPLE',
      pid: health.pid,
      elapsedMs: now - startedAtMs,
      evaluations: health.runtime?.totalEvaluations ?? null,
      attempts: health.runtime?.totalEvaluationAttempts ?? null,
      failures: health.runtime?.totalEvaluationFailures ?? null,
      observationQueue: health.runtime?.observationQueue ?? null,
      symbols: health.observations ?? null,
      btcHealthy: health.runtime?.btcHealthy ?? null,
      healthyBooks: health.runtime?.healthyBooks ?? null,
      archiveQueueDepth: health.runtime?.archiveQueueDepth ?? null,
      archiveOverflowRecords: health.runtime?.archiveOverflowRecords ?? null,
      captureBytes: health.captureBytes ?? null,
      freeDiskBytes: health.availableDiskBytes ?? null,
      rssBytes: health.memory?.rss ?? null,
      eventLoopP99Ms: health.eventLoopP99Ms ?? null,
      publicRequestsInFlight: health.publicRequestsInFlight ?? null,
      auxiliaryWritesPending: health.auxiliaryWritesPending ?? null,
      mutationAttempts: health.mutationAudit?.totalMutationAttempts ?? null,
      forwardedMutations: health.mutationAudit?.forwardedMutationCalls ?? null,
      safetyReason: reason,
    });
    process.stdout.write(
      `capture t=${Math.floor((now - startedAtMs) / 1000)}s eval=${health.runtime?.totalEvaluations ?? '?'} failed=${health.runtime?.totalEvaluationFailures ?? '?'} btc=${health.runtime?.btcHealthy ?? '?'} bytes=${health.captureBytes ?? '?'} rss=${health.memory?.rss ?? '?'}\n`,
    );
    if (reason) requestStop(reason);
  }
  let completion: Record<string, unknown> | null = null;
  let session: Record<string, unknown> | null = null;
  try {
    completion = JSON.parse(readFileSync(join(collectorRoot, 'completion.json'), 'utf8'));
    session = JSON.parse(readFileSync(join(collectorRoot, 'capture-session.json'), 'utf8'));
  } catch {
    // Missing completion/session is a technical failure and is represented below.
  }
  const status =
    !childError &&
    !monitorError &&
    result.code === 0 &&
    completion?.failed === false &&
    (session as Record<string, unknown> | null)?.captureComplete === true
      ? 'SESSION_CLOSED_MANIFEST_COMPLETE'
      : 'SESSION_INCOMPLETE_OR_PROCESS_FAILED';
  const summary = {
    schema: 'MICRO_CAPTURE_SUPERVISOR_REPORT_V1',
    status,
    collectorRoot,
    monitorDirectory,
    planSha256,
    producerArtifactHash: manifest.artifactHash,
    producerCommit: manifest.gitCommit,
    symbols: plan.symbols,
    benchmarkSymbols: plan.benchmarkSymbols,
    warmupMs: plan.warmupMs,
    replayFromSessionStartOffsetMs: plan.replayFromSessionStartOffsetMs,
    replayThroughSessionEndOffsetMs: plan.replayThroughSessionEndOffsetMs,
    experimentContractSha256: plan.experimentContractSha256,
    cancellationConditions: plan.cancellationConditions,
    childPid: child.pid ?? null,
    childExit: result,
    childError,
    monitorError,
    stopReason,
    sessionManifestSha256: (session as Record<string, unknown> | null)?.manifestSha256 ?? null,
    sessionCaptureComplete: (session as Record<string, unknown> | null)?.captureComplete ?? false,
    sessionBlockers: (session as Record<string, unknown> | null)?.blockers ?? null,
    completion,
    monitorPath,
    stdoutPath,
    stderrPath,
    publicRateLimitArtifacts: rateLimitArtifacts(monitorDirectory),
  };
  record({ atMs: Date.now(), event: 'SUPERVISOR_TERMINAL', summary });
  await Promise.all(
    [monitor, stdout, stderr].map(
      (stream) =>
        new Promise<void>((resolveClose) => {
          stream.end(resolveClose);
        }),
    ),
  );
  const report = {
    ...summary,
    logSha256: {
      monitor: createHash('sha256').update(readFileSync(monitorPath)).digest('hex'),
      stdout: createHash('sha256').update(readFileSync(stdoutPath)).digest('hex'),
      stderr: createHash('sha256').update(readFileSync(stderrPath)).digest('hex'),
    },
  };
  writeFileSync(join(monitorDirectory, 'supervisor-report.json'), JSON.stringify(report, null, 2), {
    flag: 'wx',
    mode: 0o600,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report;
}

export function sanitizedCollectorEnvironment(
  collectorRoot: string,
  monitorDirectory: string,
): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: '/tmp',
    TMPDIR: '/tmp/opencode',
    DOTENV_CONFIG_PATH: '/dev/null',
    REGIME_CONFIG: join(resolve(collectorRoot), 'regime_config.live.yaml'),
    BINANCE_SHARED_RATE_LIMIT_DB: join(resolve(monitorDirectory), 'public-rate-limit.sqlite3'),
    BINANCE_API_KEY: '',
    BINANCE_API_SECRET: '',
    IS_TESTNET: '0',
    AEGIS_ENABLED: 'false',
    AEGIS_LIVE_ENABLED: '0',
    PHANTOM_MICRO_BURST_PROSPECTIVE_VALIDATION: 'false',
    PHANTOM_MICRO_BURST_MARKET_ARCHIVE: 'false',
  };
}

function rateLimitArtifacts(monitorDirectory: string): Array<{
  file: string;
  bytes: number;
  sha256: string;
}> {
  return [
    'public-rate-limit.sqlite3',
    'public-rate-limit.sqlite3-wal',
    'public-rate-limit.sqlite3-shm',
  ]
    .map((name) => join(monitorDirectory, name))
    .filter(existsSync)
    .map((file) => {
      const bytes = readFileSync(file);
      return {
        file,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    });
}

export function healthStopReason(
  health: Record<string, any>,
  plan: MicroBurstCaptureRunPlan,
  now: number,
  lastHealthAtMs: number,
): string | null {
  const runtime = health.runtime ?? {};
  const queue = runtime.observationQueue ?? {};
  if (health.pid !== undefined && health.pid <= 0) return 'INVALID_COLLECTOR_PID';
  if (now - lastHealthAtMs > HEALTH_STALE_MS) return 'HEALTH_SAMPLE_STALE';
  if (runtime.liveExecution !== false || runtime.paperTradingEnabled !== false)
    return 'EXECUTION_OR_PAPER_MODE_ENABLED';
  if ((health.mutationAudit?.totalMutationAttempts ?? 0) !== 0) return 'MUTATION_ATTEMPT';
  if ((health.mutationAudit?.forwardedMutationCalls ?? 0) !== 0) return 'MUTATION_FORWARDED';
  if ((runtime.archiveOverflowRecords ?? 0) > 0) return 'ARCHIVE_QUEUE_OVERFLOW';
  if ((runtime.archiveQueueDepth ?? 0) >= Math.floor(plan.maxArchiveQueueRecords * 0.75))
    return 'ARCHIVE_QUEUE_PRESSURE';
  if ((health.auxiliaryWriteFailures ?? 0) > 0) return 'AUXILIARY_WRITE_FAILURE';
  if ((runtime.totalEvaluationFailures ?? 0) > 0) return 'EVALUATION_FAILURE';
  if ((queue.captureFailures ?? 0) > 0) return 'EXACT_INPUT_CAPTURE_FAILURE';
  if ((queue.dropped ?? 0) > 0) return 'OBSERVATION_QUEUE_DROP';
  if ((queue.failed ?? 0) > 0) return 'OBSERVATION_QUEUE_WRITE_FAILURE';
  if (queue.drainTimedOut === true) return 'OBSERVATION_QUEUE_DRAIN_TIMEOUT';
  if ((health.publicRequestsInFlight ?? 0) > plan.maxPublicRequestsInFlight)
    return 'PUBLIC_REQUEST_BACKLOG';
  if ((queue.pendingRecords ?? 0) >= plan.maxDecisionObservationQueueRecords - 2)
    return 'DECISION_OBSERVATION_QUEUE_PRESSURE';
  if (
    Math.max(
      health.decisionWriter?.pendingWrites ?? 0,
      health.snapshotWriter?.pendingWrites ?? 0,
      health.eventWriter?.pendingWrites ?? 0,
      health.restWriter?.pendingWrites ?? 0,
    ) >= 224
  )
    return 'AUXILIARY_WRITER_QUEUE_PRESSURE';
  if (
    [health.decisionWriter, health.snapshotWriter, health.eventWriter, health.restWriter].some(
      (writer) => (writer?.writeFailures ?? 0) > 0 || (writer?.overloadRejected ?? 0) > 0,
    )
  )
    return 'AUXILIARY_WRITER_FAILURE';
  if ((health.captureBytes ?? 0) >= plan.stopCaptureBytes) return 'CAPTURE_DISK_LIMIT';
  if ((health.memory?.rss ?? 0) >= plan.maxProcessMemoryBytes) return 'PROCESS_MEMORY_LIMIT';
  if ((health.availableDiskBytes ?? 0) < plan.minimumFreeDiskBytes) return 'FREE_DISK_RESERVE';
  if ((health.eventLoopP99Ms ?? 0) > 1000) return 'EVENT_LOOP_LAG_LIMIT';
  if (
    now >= Number(health.startedAtMs ?? now) + plan.warmupMs + 30_000 &&
    now < Number(health.startedAtMs ?? now) + plan.durationSeconds * 1000 &&
    (runtime.btcHealthy !== true || (runtime.healthyBooks ?? 0) < plan.symbols.length)
  )
    return 'POST_WARMUP_BENCHMARK_OR_BOOK_UNAVAILABLE';
  return null;
}

export function validateCaptureRunPlan(plan: MicroBurstCaptureRunPlan): void {
  if (
    !plan ||
    plan.schema !== 'MICRO_OBSERVATIONAL_CAPTURE_RUN_PLAN_V1' ||
    !plan.collectorRoot ||
    !plan.monitorDirectory ||
    !/^[a-f0-9]{40}$/.test(plan.expectedProducerCommit) ||
    !/^[a-f0-9]{64}$/.test(plan.expectedProducerArtifactHash) ||
    !Number.isSafeInteger(plan.durationSeconds) ||
    plan.durationSeconds < 360 ||
    plan.durationSeconds > 1200 ||
    plan.maxPublicRequestsInFlight !== 16 ||
    JSON.stringify(plan.symbols) !== JSON.stringify(['SOLUSDT', 'AVAXUSDT']) ||
    JSON.stringify(plan.benchmarkSymbols) !== JSON.stringify(['BTCUSDT']) ||
    plan.experimentContractSha256 !== MICRO_PAIRED_REPLAY_EVIDENCE_CONTRACT_SHA256 ||
    JSON.stringify(plan.cancellationConditions) !==
      JSON.stringify(CAPTURE_CANCELLATION_CONDITIONS) ||
    ![plan.warmupMs, plan.minimumPostWarmupWindowMs, plan.replayFromSessionStartOffsetMs].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    ) ||
    !Number.isSafeInteger(plan.replayThroughSessionEndOffsetMs) ||
    plan.replayThroughSessionEndOffsetMs < 0 ||
    plan.warmupMs < 300_000 ||
    plan.minimumPostWarmupWindowMs < 60_000 ||
    plan.replayFromSessionStartOffsetMs !== plan.warmupMs ||
    plan.replayThroughSessionEndOffsetMs !== 0 ||
    plan.durationSeconds * 1000 < plan.warmupMs + plan.minimumPostWarmupWindowMs ||
    ![
      plan.maxCaptureBytes,
      plan.stopCaptureBytes,
      plan.maxProcessMemoryBytes,
      plan.minimumFreeDiskBytes,
      plan.maxArchiveQueueRecords,
      plan.maxDecisionObservationQueueRecords,
      plan.maxPublicRequestsInFlight,
    ].every((value) => Number.isSafeInteger(value) && value > 0) ||
    plan.stopCaptureBytes > plan.maxCaptureBytes
  )
    throw new Error('CAPTURE_RUN_PLAN_INVALID');
}

function assertSeparatePath(collectorRoot: string, monitorDirectory: string): void {
  const child = relative(collectorRoot, monitorDirectory);
  if (child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`)))
    throw new Error('CAPTURE_MONITOR_MUST_BE_OUTSIDE_SOURCE');
}

if (require.main === module) {
  const requestPath = process.argv[2];
  if (!requestPath) throw new Error('USAGE: MicroBurstCaptureSupervisor <run-plan.json>');
  runMicroBurstCapturePlan(requestPath).then(
    (report) => {
      if (report.status !== 'SESSION_CLOSED_MANIFEST_COMPLETE') process.exitCode = 1;
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
