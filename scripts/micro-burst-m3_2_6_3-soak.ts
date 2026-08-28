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
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import Database from 'better-sqlite3';
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
import { createReadOnlyAuditedExchange } from '../src/infra/adapters/ReadOnlyAuditedExchange';

const root = resolve(__dirname, '..');
const SYMBOLS = ['BTCUSDT', 'ETHUSDT'] as const;
const configPath = resolve(root, 'config/micro-burst-m3_2_2-soak.yaml');
const expectedCiSha = process.env.MICRO_BURST_EXPECTED_CI_HEAD_SHA;
const ciRunId = process.env.MICRO_BURST_CI_RUN_ID ?? null;
const smokeEvidencePath = process.env.MICRO_BURST_SMOKE_EVIDENCE_PATH;
const shortValidation = process.env.MICRO_BURST_SHORT_VALIDATION === 'true';
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
if (!smokeEvidencePath) throw new Error('M3_2_6_3_SMOKE_EVIDENCE_MISSING');
const smokeEvidence = JSON.parse(readFileSync(resolve(root, smokeEvidencePath), 'utf8')) as {
  runId: string;
  codeSha: string;
  workingTreeClean: boolean;
  durationSeconds: number;
  depth: Record<string, number>;
  aggTrade: Record<string, number>;
  reconnects: number;
  cleanUnsubscribe: boolean;
  mutationAudit: { totalMutationAttempts: number };
  verdict: string;
};
if (
  smokeEvidence.codeSha !== codeSha ||
  smokeEvidence.workingTreeClean !== true ||
  smokeEvidence.durationSeconds < 90 ||
  smokeEvidence.verdict !== 'MICRO_BURST_V1_PRODUCTION_PATH_MARKET_DATA_SMOKE_VERIFIED' ||
  smokeEvidence.reconnects !== 0 ||
  smokeEvidence.cleanUnsubscribe !== true ||
  smokeEvidence.mutationAudit.totalMutationAttempts !== 0 ||
  Object.values(smokeEvidence.depth).some((count) => count <= 0) ||
  Object.values(smokeEvidence.aggTrade).some((count) => count <= 0)
)
  throw new Error('M3_2_6_3_SMOKE_EVIDENCE_INVALID');
if (!Number.isFinite(durationSeconds) || durationSeconds < (shortValidation ? 300 : 900))
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

const manifestSha256 = createHash('sha256')
  .update(readFileSync(resolve(runRoot, 'manifest.json')))
  .digest('hex');

function validateArchive(runRootPath: string): Record<string, unknown> {
  const archiveRoot = resolve(runRootPath, 'archive');
  const files: string[] = [];
  const walk = (directory: string): void => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = resolve(directory, entry.name);
      if (entry.isDirectory()) walk(file);
      else files.push(file);
    }
  };
  walk(archiveRoot);
  const gzipFiles = files.filter((file) => file.endsWith('.ndjson.gz'));
  const tempFiles = files.filter((file) => file.endsWith('.tmp') || file.endsWith('.active.ndjson'));
  let actualRecords = 0;
  let checksumErrors = 0;
  for (const file of gzipFiles) {
    const text = gunzipSync(readFileSync(file)).toString('utf8');
    const count = text.split('\n').filter((line) => line.trim()).length;
    const metadataPath = `${file}.meta.json`;
    try {
      const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as {
        recordCount: number;
        checksum: string;
      };
      const checksum = createHash('sha256').update(text).digest('hex');
      if (metadata.recordCount !== count || metadata.checksum !== checksum) checksumErrors++;
    } catch {
      checksumErrors++;
    }
    actualRecords += count;
  }
  const db = new Database(resolve(runRootPath, 'research.sqlite'), { readonly: true });
  const integrity = (db.pragma('integrity_check') as Array<{ integrity_check: string }>)[0]
    ?.integrity_check;
  const segmentRows = db
    .prepare('SELECT COUNT(*) AS count, COALESCE(SUM(record_count), 0) AS records FROM market_data_segments')
    .get() as { count: number; records: number };
  const counts = {
    signals: (db.prepare('SELECT COUNT(*) AS count FROM micro_burst_signals').get() as { count: number })
      .count,
    outcomes: (db.prepare('SELECT COUNT(*) AS count FROM micro_burst_outcomes').get() as { count: number })
      .count,
    gaps: (db.prepare('SELECT COUNT(*) AS count FROM market_data_gaps').get() as { count: number }).count,
    pending: (db.prepare('SELECT COUNT(*) AS count FROM micro_burst_pending_outcomes').get() as { count: number })
      .count,
  };
  db.close();
  return {
    gzipFiles: gzipFiles.length,
    metadataFiles: files.filter((file) => file.endsWith('.ndjson.gz.meta.json')).length,
    sqliteSegmentRows: segmentRows.count,
    sqliteRecordCount: segmentRows.records,
    actualRecords,
    checksumErrors,
    tempFiles: tempFiles.length,
    sqliteIntegrity: integrity,
    counts,
    verified:
      integrity === 'ok' &&
      tempFiles.length === 0 &&
      checksumErrors === 0 &&
      gzipFiles.length === files.filter((file) => file.endsWith('.ndjson.gz.meta.json')).length &&
      gzipFiles.length === segmentRows.count &&
      actualRecords === segmentRows.records,
  };
}

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
  const rawExchange = new BinanceExchange(logger);
  const auditedExchange = createReadOnlyAuditedExchange(rawExchange, codeSha);
  const exchange = auditedExchange.exchange;
  const wsManager = (rawExchange as any).wsManager as { disconnectAll(): void };
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
  let readyLosses = 0;
  let previousReady = false;
  let readySamples = 0;
  let readySampleSeconds = 0;
  let maxContinuousReadySeconds = 0;
  let continuousReadySeconds = 0;
  const readinessHistory: Array<{ at: string; readyForSoak: boolean; blockers: string[] }> = [];
  await runtime.start();
  try {
    while (Date.now() - startedAtMs < durationSeconds * 1_000) {
      const readiness = runtime.getReadiness();
      readinessHistory.push({
        at: new Date().toISOString(),
        readyForSoak: readiness.readyForSoak,
        blockers: readiness.blockers,
      });
      readySamples++;
      if (readiness.readyForSoak) {
        if (!previousReady) continuousReadySeconds = 0;
        continuousReadySeconds += warmupPollMs / 1_000;
        maxContinuousReadySeconds = Math.max(maxContinuousReadySeconds, continuousReadySeconds);
      } else if (previousReady) {
        readyLosses++;
        continuousReadySeconds = 0;
      }
      previousReady = readiness.readyForSoak;
      readySampleSeconds += readiness.readyForSoak ? warmupPollMs / 1_000 : 0;
      if (readiness.readyForSoak && readyAtMs === null) readyAtMs = Date.now();
      await new Promise((resolve) => setTimeout(resolve, warmupPollMs));
    }
  } finally {
    const healthBeforeStop = runtime.getHealth();
    const readinessBeforeStop = runtime.getReadiness();
    const symbolHealth = Object.fromEntries(
      SYMBOLS.map((symbol) => [symbol, runtime.getSymbolHealth(symbol)]),
    );
    await runtime.stop();
    wsManager.disconnectAll();
    const storageHealthBeforeClose = storage.getHealth();
    storage.flush();
    storage.close();
    const storageValidation = validateArchive(runRoot);
    writeFileSync(
      resolve(runRoot, 'storage-validation.json'),
      JSON.stringify(storageValidation, null, 2) + '\n',
      { flag: 'wx' },
    );
    const finalManifestSha256 = createHash('sha256')
      .update(readFileSync(resolve(runRoot, 'manifest.json')))
      .digest('hex');
    const readinessStable = maxContinuousReadySeconds >= 300 && previousReady;
    const mutationAudit = auditedExchange.audit;
    const validContexts = Math.max(
      0,
      healthBeforeStop.totalEvaluations - healthBeforeStop.totalInvalidContexts,
    );
    const btcReady = healthBeforeStop.btcHealthy;
    const btcWindowComplete = symbolHealth.BTCUSDT?.windowComplete === true;
    const ethWindowComplete = symbolHealth.ETHUSDT?.windowComplete === true;
    const btcGapFree = symbolHealth.BTCUSDT?.gapFree === true;
    const ethGapFree = symbolHealth.ETHUSDT?.gapFree === true;
    const shortValidationPassed =
      readinessBeforeStop.readyForSoak &&
      storageValidation.verified === true &&
      mutationAudit.totalMutationAttempts === 0 &&
      validContexts > 0 &&
      btcReady &&
      btcWindowComplete &&
      ethWindowComplete &&
      btcGapFree &&
      ethGapFree;
    const result = {
      runId,
      codeSha,
      endedAtUtc: new Date().toISOString(),
      durationSeconds: (Date.now() - startedAtMs) / 1_000,
      validationMode: shortValidation ? 'SHORT_VALIDATION' : 'RETAINED_SOAK',
      readyForSoak:
        readinessBeforeStop.readyForSoak &&
        (shortValidation || readinessStable) &&
        storageValidation.verified === true,
      readyAtUtc: readyAtMs ? new Date(readyAtMs).toISOString() : null,
      readiness: readinessBeforeStop,
      symbolHealth,
      evaluations: healthBeforeStop.totalEvaluations,
      invalidContexts: healthBeforeStop.totalInvalidContexts,
      validContexts,
      shortValidation: {
        btcReady,
        btcWindowComplete,
        ethWindowComplete,
        btcGapFree,
        ethGapFree,
        storageVerified: storageValidation.verified === true,
        mutationAttempts: mutationAudit.totalMutationAttempts,
        passed: shortValidationPassed,
      },
      readinessHistory,
      readinessStability: {
        firstReadyAt: readyAtMs ? new Date(readyAtMs).toISOString() : null,
        readyDurationSeconds: readySampleSeconds,
        readyFraction: readySamples ? readySampleSeconds / ((Date.now() - startedAtMs) / 1_000) : 0,
        maxContinuousReadySeconds,
        readinessLosses: readyLosses,
      },
      health: healthBeforeStop,
      storageHealthBeforeClose,
      storageValidation,
      mutationAudit,
      smokeEvidence: { runId: smokeEvidence.runId, codeSha: smokeEvidence.codeSha },
      ciRunId,
      manifestSha256,
      finalManifestSha256,
      mutations: mutationAudit,
      verdict: shortValidation
        ? shortValidationPassed
          ? 'MICRO_BURST_V1_M3_2_6_5_SHORT_VALIDATION_VERIFIED'
          : 'MICRO_BURST_V1_M3_2_6_5_SHORT_VALIDATION_BLOCKED'
        : readinessBeforeStop.readyForSoak
        && readinessStable
        && storageValidation.verified === true
        && mutationAudit.totalMutationAttempts === 0
        ? 'MICRO_BURST_V1_M3_2_6_PRE_COHORT_CORRECTNESS_VERIFIED'
        : 'MICRO_BURST_V1_M3_2_6_4_BLOCKED',
    };
    writeFileSync(
      resolve(runRoot, 'http-mutation-audit.json'),
      JSON.stringify(result.mutationAudit, null, 2) + '\n',
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
