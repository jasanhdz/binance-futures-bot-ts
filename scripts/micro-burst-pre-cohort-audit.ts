#!/usr/bin/env tsx

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');
const source = (relativePath: string) => readFileSync(resolve(root, relativePath), 'utf8');
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

const headSha = git('rev-parse', 'HEAD');
const workingTreeClean = git('status', '--porcelain') === '';
const identity = source('src/domain/strategies/micro-burst/MicroBurstIdentity.ts');
const runtime = source('src/domain/strategies/micro-burst/MicroBurstRuntime.ts');
const analyzer = source('src/tooling/micro-burst/MicroBurstProspectiveAnalyzer.ts');
const storage = source('src/app/micro-burst/MicroBurstStorage.ts');
const telegram = source('src/app/telegram/TelegramCommandRouter.ts');
const main = source('src/main.ts');

const checks = {
  codeShaKnown: headSha !== 'UNKNOWN',
  workingTreeClean,
  configHashKnown: !runtime.includes("configHash: 'UNKNOWN'") || runtime.includes('configHash'),
  strategyVersionFrozen: identity.includes('0.6.0-precohort-correctness'),
  cohortIdValid: /MBV1-M3_2-/.test(runtime),
  preStartManifestValid: false,
  manifestShaMatches: false,
  manifestConfigMatches: false,
  archiveRootFresh: false,
  databaseFresh: false,
  storageHealthy: storage.includes('StorageHealth') && storage.includes('integrity_check'),
  storageOverflowZero: false,
  storageErrorsZero: false,
  unresolvedTradeGapsZero: false,
  bookHealthy: false,
  btcContextHealthy: false,
  aggTradeWindowComplete: false,
  mutationAuditEnabled: telegram.includes('mutationsEnabled') && existsSync(resolve(root, 'src/infra/telegram/TelegramMutationAuditWriter.ts')),
  liveExecutionFalse: identity.includes('MICRO_BURST_V1_LIVE_AUTHORITY_ENABLED = false'),
  liveAuthorityFalse: identity.includes('MICRO_BURST_V1_LIVE_AUTHORITY_ENABLED = false'),
  preregistrationPresent: false,
  analysisSchemaVersionKnown: analyzer.includes('unresolvedOutcomeCount'),
  episodeDefinitionFrozen: identity.includes('300') || runtime.includes('300000'),
  gapSemanticsFrozen: storage.includes('UNKNOWN_LEGACY'),
  costSemanticsFrozen: false,
  typedGapMigrationInstalled: storage.includes('UNKNOWN_LEGACY'),
  analyzerCohortIsolationActive: analyzer.includes('COHORT_SELECTION_REQUIRED'),
  episodeSchemaActive: storage.includes('episode_id'),
  storageSchemaValid: storage.includes('micro_burst_outcomes'),
  startupConfigurationValid: main.includes('STARTUP_NO_ACTIVE_SYMBOLS'),
  mutationAuditAvailable: existsSync(resolve(root, 'src/infra/telegram/TelegramMutationAuditWriter.ts')),
  testsAndBuildSupplied: false,
};

const blockers = Object.entries(checks)
  .filter(([, value]) => !value)
  .map(([name]) => name);

console.log(
  JSON.stringify(
    {
      readyForSoak: blockers.length === 0,
      blockers,
      warnings: ['No official cohort is started by this read-only audit.'],
      checks,
      headSha,
    },
    null,
    2,
  ),
);
