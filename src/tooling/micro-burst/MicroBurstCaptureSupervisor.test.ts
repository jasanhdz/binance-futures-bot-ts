import { expect, it } from 'vitest';
import {
  CAPTURE_CANCELLATION_CONDITIONS,
  healthStopReason,
  sanitizedCollectorEnvironment,
  validateCaptureRunPlan,
  type MicroBurstCaptureRunPlan,
} from './MicroBurstCaptureSupervisor';
import { MICRO_PAIRED_REPLAY_EVIDENCE_CONTRACT_SHA256 } from './MicroBurstReplayEvidenceContract';

const plan: MicroBurstCaptureRunPlan = {
  schema: 'MICRO_OBSERVATIONAL_CAPTURE_RUN_PLAN_V1',
  collectorRoot: '/tmp/frozen-collector',
  monitorDirectory: '/tmp/frozen-collector-monitor',
  expectedProducerCommit: 'a'.repeat(40),
  expectedProducerArtifactHash: 'b'.repeat(64),
  durationSeconds: 420,
  symbols: ['SOLUSDT', 'AVAXUSDT'],
  benchmarkSymbols: ['BTCUSDT'],
  warmupMs: 300_000,
  minimumPostWarmupWindowMs: 120_000,
  replayFromSessionStartOffsetMs: 300_000,
  replayThroughSessionEndOffsetMs: 0,
  experimentContractSha256: MICRO_PAIRED_REPLAY_EVIDENCE_CONTRACT_SHA256,
  cancellationConditions: CAPTURE_CANCELLATION_CONDITIONS,
  maxCaptureBytes: 1024,
  stopCaptureBytes: 900,
  maxProcessMemoryBytes: 2048,
  minimumFreeDiskBytes: 512,
  maxArchiveQueueRecords: 100,
  maxDecisionObservationQueueRecords: 16,
  maxPublicRequestsInFlight: 16,
};

const healthy = () => ({
  atMs: 10_000,
  startedAtMs: 0,
  liveExecution: false,
  publicRequestsInFlight: 0,
  auxiliaryWriteFailures: 0,
  captureBytes: 200,
  availableDiskBytes: 1000,
  memory: { rss: 512 },
  eventLoopP99Ms: 2,
  mutationAudit: { totalMutationAttempts: 0, forwardedMutationCalls: 0 },
  runtime: {
    btcHealthy: true,
    healthyBooks: 2,
    liveExecution: false,
    paperTradingEnabled: false,
    totalEvaluationFailures: 0,
    archiveOverflowRecords: 0,
    archiveQueueDepth: 5,
    observationQueue: { pendingRecords: 2 },
  },
  decisionWriter: { pendingWrites: 0 },
  snapshotWriter: { pendingWrites: 0 },
  eventWriter: { pendingWrites: 0 },
  restWriter: { pendingWrites: 0 },
});

it('accepts only the bound two-symbol 7-minute plan with the declared warmup, replay, and limits', () => {
  expect(() => validateCaptureRunPlan(plan)).not.toThrow();
  expect(() => validateCaptureRunPlan({ ...plan, symbols: ['SOLUSDT', 'SUIUSDT'] as any })).toThrow(
    'CAPTURE_RUN_PLAN_INVALID',
  );
  expect(() => validateCaptureRunPlan({ ...plan, durationSeconds: 1201 })).toThrow(
    'CAPTURE_RUN_PLAN_INVALID',
  );
});

it('creates a child environment from an allowlist and blanks all Binance credentials', () => {
  const previousKey = process.env.BINANCE_API_KEY;
  const previousSecret = process.env.BINANCE_API_SECRET;
  process.env.BINANCE_API_KEY = 'parent-key-must-not-leak';
  process.env.BINANCE_API_SECRET = 'parent-secret-must-not-leak';
  try {
    const env = sanitizedCollectorEnvironment(plan.collectorRoot, plan.monitorDirectory);
    expect(env.BINANCE_API_KEY).toBe('');
    expect(env.BINANCE_API_SECRET).toBe('');
    expect(env.DOTENV_CONFIG_PATH).toBe('/dev/null');
    expect(env.REGIME_CONFIG).toBe('/tmp/frozen-collector/regime_config.live.yaml');
    expect(env.BINANCE_SHARED_RATE_LIMIT_DB).toBe(
      '/tmp/frozen-collector-monitor/public-rate-limit.sqlite3',
    );
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(env.ML_SERVICE_URL).toBeUndefined();
  } finally {
    if (previousKey === undefined) delete process.env.BINANCE_API_KEY;
    else process.env.BINANCE_API_KEY = previousKey;
    if (previousSecret === undefined) delete process.env.BINANCE_API_SECRET;
    else process.env.BINANCE_API_SECRET = previousSecret;
  }
});

it('continues on healthy public-feed gaps but stops on authority, queue, disk or resource limits', () => {
  const sample = healthy();
  expect(healthStopReason(sample, plan, 10_000, 10_000)).toBeNull();
  expect(
    healthStopReason(
      { ...sample, mutationAudit: { totalMutationAttempts: 1, forwardedMutationCalls: 0 } },
      plan,
      10_000,
      10_000,
    ),
  ).toBe('MUTATION_ATTEMPT');
  expect(
    healthStopReason(
      { ...sample, runtime: { ...sample.runtime, archiveQueueDepth: 75 } },
      plan,
      10_000,
      10_000,
    ),
  ).toBe('ARCHIVE_QUEUE_PRESSURE');
  expect(healthStopReason({ ...sample, publicRequestsInFlight: 17 }, plan, 10_000, 10_000)).toBe(
    'PUBLIC_REQUEST_BACKLOG',
  );
  expect(healthStopReason({ ...sample, captureBytes: 900 }, plan, 10_000, 10_000)).toBe(
    'CAPTURE_DISK_LIMIT',
  );
  expect(healthStopReason(sample, plan, 30_001, 10_000)).toBe('HEALTH_SAMPLE_STALE');
});

it('does not classify normal collector teardown at the planned endpoint as a feed failure', () => {
  const sample = healthy();
  expect(
    healthStopReason(
      { ...sample, runtime: { ...sample.runtime, btcHealthy: false, healthyBooks: 0 } },
      plan,
      330_001,
      330_001,
    ),
  ).toBe('POST_WARMUP_BENCHMARK_OR_BOOK_UNAVAILABLE');
  expect(
    healthStopReason(
      { ...sample, runtime: { ...sample.runtime, btcHealthy: false, healthyBooks: 0 } },
      plan,
      420_000,
      420_000,
    ),
  ).toBeNull();
});
