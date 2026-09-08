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
import { MICRO_BURST_V1_CONFIG_SHA256 } from '../../strategies/micro-burst/domain/MicroBurstIdentity';

export const MICRO_HISTORICAL_YAML_CHECKPOINT =
  '18c8584ac780bf3a1d34f90974dc4527b9c7116de79fdf9a927538ec89e33e4c';

/** Local source diagnostic, not artifact attestation or an execution capability. */
export function contextualPreflight(input: {
  yaml: string;
  sourceCommit: string;
  sourceDirty: boolean;
  prospectiveOverride?: string;
  archiveOverride?: string;
}): {
  schemaVersion: 1;
  policyVersion: 'CONTEXTUAL_V3';
  status: 'BLOCKED';
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
} {
  // These are implementation/evidence gaps, not operator-settable success flags.
  const blockers = [
    'V3_LIVE_EXECUTION_INTEGRATION_INCOMPLETE',
    'V3_OPERATOR_APPROVAL_BUNDLE_NOT_ESTABLISHED',
    'RUNNING_ARTIFACT_NOT_ATTESTED',
    'EXPLICIT_MONETARY_RISK_APPROVAL_NOT_ESTABLISHED',
    'LIVE_MARGIN_LIQUIDATION_FILTER_FEE_EVIDENCE_NOT_INTEGRATED',
    'QUANTITY_AWARE_EXIT_ECONOMICS_NOT_INTEGRATED',
    'DURABLE_V3_EPISODE_AND_PER_TRADE_POLICY_RECOVERY_NOT_INTEGRATED',
    'DECISION_FILL_COMMISSION_FUNDING_DATASET_NOT_ESTABLISHED',
    'CHRONOLOGICAL_OOS_ACCEPTANCE_NOT_ESTABLISHED',
    'OWNERSHIP_PROTECTION_AND_PNL_QUARANTINES_NOT_INSPECTED',
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
    if (effectiveConfig !== MICRO_BURST_V1_CONFIG_SHA256)
      blockers.push('HISTORICAL_APPROVED_EFFECTIVE_CONFIG_MISMATCH');
    if (config.exitPolicy?.contextualPolicyVersion !== 'CONTEXTUAL_V3')
      blockers.push('V3_NOT_CONFIGURED');
  } catch {
    blockers.push('CONFIG_PARSE_OR_POLICY_VALIDATION_FAILED');
  }
  const yaml = createHash('sha256').update(input.yaml).digest('hex');
  if (yaml !== MICRO_HISTORICAL_YAML_CHECKPOINT)
    blockers.push('HISTORICAL_YAML_CHECKPOINT_MISMATCH');
  if (input.sourceDirty) blockers.push('SOURCE_DIRTY');
  if (!/^[a-f0-9]{40}$/i.test(input.sourceCommit)) blockers.push('SOURCE_REVISION_UNKNOWN');
  return {
    schemaVersion: 1,
    policyVersion: 'CONTEXTUAL_V3',
    status: 'BLOCKED',
    grantsAuthority: false,
    sourceCommit: input.sourceCommit,
    sourceDirty: input.sourceDirty,
    hashes: {
      effectiveConfig,
      historicalApprovedConfig: MICRO_BURST_V1_CONFIG_SHA256,
      yaml,
      historicalYamlCheckpoint: MICRO_HISTORICAL_YAML_CHECKPOINT,
    },
    blockers,
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
      prospectiveOverride: process.env.PHANTOM_MICRO_BURST_PROSPECTIVE_VALIDATION,
      archiveOverride: process.env.PHANTOM_MICRO_BURST_MARKET_ARCHIVE,
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = 2;
  } catch {
    process.stdout.write(
      `${JSON.stringify({ status: 'BLOCKED', grantsAuthority: false, blockers: ['LOCAL_PREFLIGHT_FAILED'] })}\n`,
    );
    process.exitCode = 2;
  }
}
