import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load } from 'js-yaml';
import {
  mergeMicroBurstConfigs,
  parseMicroBurstConfig,
} from '../../strategies/micro-burst/application/MicroBurstConfigLoader';
import { microBurstConfigHash } from '../../strategies/micro-burst/application/MicroBurstConfigHash';
import { MICRO_BURST_CONFIG_SHA256 } from '../../strategies/micro-burst/domain/MicroBurstIdentity';

// Historical research baseline, not the subsequently approved REACTION deployment.
const MICRO_HISTORICAL_APPROVED_CONFIG =
  '093ab31d5531272246e7d408c0351d3a41e7d3716deaa02bf25ba39a43db2f1b';

export const MICRO_HISTORICAL_YAML_CHECKPOINT =
  '18c8584ac780bf3a1d34f90974dc4527b9c7116de79fdf9a927538ec89e33e4c';

/** Local source diagnostic, not artifact attestation or an execution capability. */
export function contextualPreflight(input: {
  yaml: string;
  sourceCommit: string;
  sourceDirty: boolean;
  approvedCommit?: string;
  approvedConfigSha256?: string;
  prospectiveOverride?: string;
  archiveOverride?: string;
}): {
  schemaVersion: 1;
  policyVersion: 'MICRO';
  status: 'BLOCKED' | 'LOCAL_VALIDATED';
  grantsAuthority: false;
  sourceCommit: string;
  sourceDirty: boolean;
  hashes: {
    effectiveConfig: string | null;
    historicalApprovedConfig: string;
    yaml: string;
    historicalYamlCheckpoint: string;
  };
  blockers: string[];
  remainingChecks: string[];
} {
  // This local-only command cannot attest deployment or exchange acceptance.
  const blockers: string[] = [];
  const remainingChecks = [
    'RUNNING_ARTIFACT_NOT_ATTESTED',
    'SIGNED_NET_LOSS_LEDGER_INITIALIZATION_NOT_INSPECTED',
    'OWNERSHIP_PROTECTION_AND_PNL_QUARANTINES_NOT_INSPECTED',
    'EXCHANGE_STOP_ACCEPTANCE_NOT_PROVEN_BY_LOCAL_CHECK',
    'ECONOMIC_RESULTS_NOT_VALIDATED',
  ];
  let effectiveConfig: string | null = null;
  try {
    const config = mergeMicroBurstConfigs(parseMicroBurstConfig(load(input.yaml)), {
      prospectiveValidation:
        input.prospectiveOverride === undefined
          ? undefined
          : { enabled: input.prospectiveOverride === 'true' },
      marketArchive:
        input.archiveOverride === undefined
          ? undefined
          : { enabled: input.archiveOverride === 'true' },
    });
    effectiveConfig = microBurstConfigHash(config);
    if (
      effectiveConfig !== MICRO_BURST_CONFIG_SHA256 ||
      effectiveConfig !== input.approvedConfigSha256
    )
      blockers.push('APPROVED_EFFECTIVE_CONFIG_MISMATCH');
    if (config.exitPolicy?.contextualPolicyVersion !== 'MICRO')
      blockers.push('MICRO_NOT_CONFIGURED');
    if (!config.contextualRisk) blockers.push('EXPLICIT_MARGIN_FRACTION_POLICY_NOT_CONFIGURED');
    if (!config.enabled || config.mode !== 'LIVE') blockers.push('MICRO_LIVE_NOT_SELECTED');
  } catch {
    blockers.push('CONFIG_PARSE_OR_POLICY_VALIDATION_FAILED');
  }
  const yaml = createHash('sha256').update(input.yaml).digest('hex');
  if (input.sourceDirty) blockers.push('SOURCE_DIRTY');
  if (!/^[a-f0-9]{40}$/i.test(input.sourceCommit)) blockers.push('SOURCE_REVISION_UNKNOWN');
  if (
    !/^[a-f0-9]{40}$/i.test(input.approvedCommit ?? '') ||
    input.approvedCommit !== input.sourceCommit
  )
    blockers.push('APPROVED_SOURCE_COMMIT_MISMATCH');
  return {
    schemaVersion: 1,
    policyVersion: 'MICRO',
    status: blockers.length ? 'BLOCKED' : 'LOCAL_VALIDATED',
    grantsAuthority: false,
    sourceCommit: input.sourceCommit,
    sourceDirty: input.sourceDirty,
    hashes: {
      effectiveConfig,
      historicalApprovedConfig: MICRO_HISTORICAL_APPROVED_CONFIG,
      yaml,
      historicalYamlCheckpoint: MICRO_HISTORICAL_YAML_CHECKPOINT,
    },
    blockers,
    remainingChecks,
  };
}

if (require.main === module) {
  try {
    if (process.argv.length !== 2) throw new Error('UNSUPPORTED_ARGUMENTS');
    const root = process.cwd();
    const git = (...args: string[]): string =>
      execFileSync('git', args, {
        cwd: root,
        encoding: 'utf8',
        timeout: 5_000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    const report = contextualPreflight({
      yaml: readFileSync(resolve(root, 'regime_config.live.yaml'), 'utf8'),
      sourceCommit: git('rev-parse', 'HEAD'),
      sourceDirty: git('status', '--porcelain', '--untracked-files=normal') !== '',
      approvedCommit: process.env.MICRO_BURST_APPROVED_COMMIT,
      approvedConfigSha256: process.env.MICRO_BURST_APPROVED_CONFIG_SHA256,
      prospectiveOverride: process.env.PHANTOM_MICRO_BURST_PROSPECTIVE_VALIDATION,
      archiveOverride: process.env.PHANTOM_MICRO_BURST_MARKET_ARCHIVE,
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.status === 'LOCAL_VALIDATED' ? 0 : 2;
  } catch {
    process.stdout.write(
      `${JSON.stringify({ status: 'BLOCKED', grantsAuthority: false, blockers: ['LOCAL_PREFLIGHT_FAILED'] })}\n`,
    );
    process.exitCode = 2;
  }
}
