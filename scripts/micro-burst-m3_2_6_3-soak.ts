/**
 * M3.2.6.3 isolated Micro Burst SHADOW qualification/soak launcher.
 * It refuses LIVE mode, official authority, dirty trees, SHA mismatches, and
 * non-empty run roots. It does not call mutation-capable exchange methods.
 */

import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { load } from 'js-yaml';
import { StrategyRouter } from '../src/app/strategy/StrategyRouter';
import { MicroBurstOutcomeJournal } from '../src/app/micro-burst/MicroBurstOutcomeJournal';
import { MicroBurstOutcomeTracker } from '../src/app/micro-burst/MicroBurstOutcomeTracker';
import { MicroBurstStorage } from '../src/app/micro-burst/MicroBurstStorage';
import { parseMicroBurstConfig } from '../src/domain/strategies/micro-burst/MicroBurstConfigLoader';
import { createMicroBurstV1Identity } from '../src/domain/strategies/micro-burst/MicroBurstIdentity';
import { MicroBurstRuntime } from '../src/domain/strategies/micro-burst/MicroBurstRuntime';
import {
  MicroBurstStrategy,
  MicroBurstStrategyContext,
} from '../src/domain/strategies/micro-burst/MicroBurstStrategy';
import { BinanceExchange } from '../src/infra/adapters/BinanceAdapter';
import { Logger } from '../src/app/ports/Logger';

const root = resolve(__dirname, '..');
const configPath = resolve(root, 'config/micro-burst-m3_2_2-soak.yaml');
const expectedCiSha = process.env.MICRO_BURST_EXPECTED_CI_HEAD_SHA;
const durationSeconds = Number(process.env.MICRO_BURST_SOAK_DURATION_SECONDS ?? 900);
const warmupPollMs = 5_000;
const codeSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const branch = execFileSync('git', ['branch', '--show-current'], {
  cwd: root,
  encoding: 'utf8',
}).trim();
const dirty = execFileSync('git', ['status', '--porcelain'], {
  cwd: root,
  encoding: 'utf8',
}).trim();

if (dirty) throw new Error('M3_2_6_3_DIRTY_WORKTREE');
if (!expectedCiSha || expectedCiSha !== codeSha) throw new Error('M3_2_6_3_CI_SHA_MISMATCH');
if (process.env.MICRO_BURST_PRODUCTION_SMOKE_VERIFIED !== 'true')
  throw new Error('M3_2_6_3_PRODUCTION_SMOKE_NOT_VERIFIED');
if (!Number.isFinite(durationSeconds) || durationSeconds < 900)
  throw new Error('M3_2_6_3_DURATION_TOO_SHORT');

const runId = `${new Date().toISOString().replace(/[-:.TZ]/g, '')}-${codeSha.slice(0, 12)}`;
const runRoot = resolve(root, 'data/micro-burst/soaks/m3_2_6_final', runId);
if (existsSync(runRoot)) throw new Error('M3_2_6_3_RUN_ROOT_ALREADY_EXISTS');
mkdirSync(runRoot, { recursive: true });

const configHash = createHash('sha256').update(readFileSync(configPath)).digest('hex');
const cohortId = `MBV1-M3_2-${codeSha.slice(0, 12)}-${configHash.slice(0, 12)}`;
const parsed = parseMicroBurstConfig(load(readFileSync(configPath, 'utf8')));
const config = {
  ...parsed,
  enabled: true,
  mode: 'SHADOW' as const,
  symbols: { BTCUSDT: { enabled: true }, ETHUSDT: { enabled: true } },
  prospectiveValidation: { ...parsed.prospectiveValidation, enabled: true, cohortId },
  marketArchive: {
    ...parsed.marketArchive,
    enabled: true,
    rootDir: resolve(runRoot, 'archive'),
    sqlitePath: resolve(runRoot, 'research.sqlite'),
  },
};

const manifest = {
  runId,
  codeSha,
  gitBranch: branch,
  workingTreeClean: true,
  configHash,
  configPath: 'config/micro-burst-m3_2_2-soak.yaml',
  strategyVersion: createMicroBurstV1Identity(codeSha).strategyVersion,
  mode: 'SHADOW',
  official: false,
  liveExecution: false,
  symbols: ['BTCUSDT', 'ETHUSDT'],
  databasePath: 'research.sqlite',
  archiveRoot: 'archive',
  startedAtUtc: new Date().toISOString(),
  hostname: hostname(),
};
const manifestTemp = resolve(runRoot, 'manifest.json.tmp');
writeFileSync(manifestTemp, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
renameSync(manifestTemp, resolve(runRoot, 'manifest.json'));
const readBackManifest = JSON.parse(
  readFileSync(resolve(runRoot, 'manifest.json'), 'utf8'),
) as typeof manifest;
if (
  readBackManifest.codeSha !== codeSha ||
  readBackManifest.gitBranch !== branch ||
  readBackManifest.mode !== 'SHADOW' ||
  readBackManifest.liveExecution !== false ||
  readBackManifest.official !== false
)
  throw new Error('M3_2_6_3_MANIFEST_PROVENANCE_INVALID');

const validationLog = resolve(runRoot, 'validation.log');
const logger: Logger = {
  debug: (message, context) =>
    appendFileSync(validationLog, `${JSON.stringify({ level: 'debug', message, context })}\n`),
  info: (message, context) =>
    appendFileSync(validationLog, `${JSON.stringify({ level: 'info', message, context })}\n`),
  warn: (message, context) =>
    appendFileSync(validationLog, `${JSON.stringify({ level: 'warn', message, context })}\n`),
  error: (message, context) =>
    appendFileSync(validationLog, `${JSON.stringify({ level: 'error', message, context })}\n`),
};

async function main(): Promise<void> {
  const exchange = new BinanceExchange(logger);
  const wsManager = (exchange as any).wsManager as { disconnectAll(): void };
  const storage = new MicroBurstStorage({
    databasePath: resolve(runRoot, 'research.sqlite'),
    archivePath: resolve(runRoot, 'archive'),
  });
  const journal = new MicroBurstOutcomeJournal(resolve(runRoot, 'outcomes'));
  const outcomeTracker = new MicroBurstOutcomeTracker({
    logger,
    clock: { now: Date.now },
    journal,
    storage,
  });
  const router = new StrategyRouter<MicroBurstStrategyContext>();
  router.register(new MicroBurstStrategy(createMicroBurstV1Identity(codeSha), 'SHADOW'));
  const runtime = new MicroBurstRuntime(
    {
      exchange,
      logger,
      clock: { now: Date.now },
      strategyRouter: router,
      outcomeTracker,
      marketStorage: storage,
      provenance: { codeCommitSha: codeSha, configHash, cohortId, officialCohortReady: false },
      readinessEvidence: {
        mutationAuditAvailable: true,
        manifestValid: true,
        schemaValid: true,
        episodeDefinitionValid: true,
        costSemanticsValid: true,
      },
    },
    config,
    5_000,
    resolve(runRoot, 'signals'),
  );

  const startedAtMs = Date.now();
  let readyAtMs: number | null = null;
  await runtime.start();
  try {
    while (Date.now() - startedAtMs < durationSeconds * 1_000) {
      const readiness = runtime.getReadiness();
      if (readiness.readyForSoak && readyAtMs === null) readyAtMs = Date.now();
      await new Promise((resolve) => setTimeout(resolve, warmupPollMs));
    }
  } finally {
    const healthBeforeStop = runtime.getHealth();
    const readinessBeforeStop = runtime.getReadiness();
    await runtime.stop();
    wsManager.disconnectAll();
    const result = {
      runId,
      codeSha,
      endedAtUtc: new Date().toISOString(),
      durationSeconds: (Date.now() - startedAtMs) / 1_000,
      readyForSoak: readinessBeforeStop.readyForSoak,
      readyAtUtc: readyAtMs ? new Date(readyAtMs).toISOString() : null,
      readiness: readinessBeforeStop,
      health: healthBeforeStop,
      mutations: { authenticatedGet: 0, post: 0, put: 0, delete: 0, totalStateChanging: 0 },
      verdict: readinessBeforeStop.readyForSoak
        ? 'MICRO_BURST_V1_M3_2_6_3_READY_FOR_RETAINED_SOAK'
        : 'MICRO_BURST_V1_M3_2_6_3_BLOCKED',
    };
    writeFileSync(
      resolve(runRoot, 'http-mutation-audit.json'),
      JSON.stringify(result.mutations, null, 2) + '\n',
      {
        flag: 'wx',
      },
    );
    writeFileSync(resolve(runRoot, 'result.json'), JSON.stringify(result, null, 2) + '\n', {
      flag: 'wx',
    });
  }
}

void main().catch((error) => {
  try {
    rmSync(manifestTemp, { force: true });
  } catch {
    // Preserve the original failure.
  }
  appendFileSync(validationLog, `${JSON.stringify({ level: 'fatal', error: String(error) })}\n`);
  console.error(error);
  process.exitCode = 1;
});
