import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  contextualPreflight,
  MICRO_HISTORICAL_YAML_CHECKPOINT,
} from './MicroBurstContextualPreflight';

const source = { sourceCommit: 'a'.repeat(40), sourceDirty: false };

describe('Contextual V3 local preflight', () => {
  it('reports the actual drift without approving it or hiding implementation blockers', () => {
    const report = contextualPreflight({
      ...source,
      yaml: readFileSync('regime_config.live.yaml', 'utf8'),
    });
    expect(report).toMatchObject({
      status: 'BLOCKED',
      grantsAuthority: false,
      hashes: {
        effectiveConfig: '957d53b90e8d57eb9233e468722e85786a42a9244dc88b6cd66fc485421aa3ba',
        historicalApprovedConfig:
          '093ab31d5531272246e7d408c0351d3a41e7d3716deaa02bf25ba39a43db2f1b',
        yaml: '970ce7308d7ec0cd49e97e032491dc0b50901c8ab4300746ebff6968d83ce730',
        historicalYamlCheckpoint: MICRO_HISTORICAL_YAML_CHECKPOINT,
      },
    });
    expect(report.blockers).toEqual(
      expect.arrayContaining([
        'HISTORICAL_APPROVED_EFFECTIVE_CONFIG_MISMATCH',
        'HISTORICAL_YAML_CHECKPOINT_MISMATCH',
        'V3_PRODUCTION_DEPLOYMENT_VALIDATION_NOT_ESTABLISHED',
        'CHRONOLOGICAL_OOS_ACCEPTANCE_NOT_ESTABLISHED',
      ]),
    );
  });

  it.each([
    '[invalid',
    'micro_burst:\n  mode: LIVE\n  exit_policy:\n    contextual_policy_version: CONTEXTUAL_V3',
  ])('fails closed for invalid or forbidden config', (yaml) => {
    const report = contextualPreflight({ ...source, yaml });
    expect(report.hashes.effectiveConfig).toBeNull();
    expect(report.blockers).toContain('CONFIG_PARSE_OR_POLICY_VALIDATION_FAILED');
    expect(report.grantsAuthority).toBe(false);
  });

  it('cannot turn a clean research source into approval', () => {
    const report = contextualPreflight({
      ...source,
      yaml: 'micro_burst:\n  mode: OFF\n  exit_policy:\n    contextual_policy_version: CONTEXTUAL_V3',
    });
    expect(report.blockers).not.toContain('V3_NOT_CONFIGURED');
    expect(report.blockers).toContain('V3_OPERATOR_APPROVAL_BUNDLE_NOT_ESTABLISHED');
    expect(report.status).toBe('BLOCKED');
  });

  it('reports dirty and unknown sources independently of config failures', () => {
    const report = contextualPreflight({ yaml: '[', sourceCommit: 'UNKNOWN', sourceDirty: true });
    expect(report.blockers).toEqual(
      expect.arrayContaining(['SOURCE_DIRTY', 'SOURCE_REVISION_UNKNOWN']),
    );
  });

  it('includes the existing effective overrides in the hash, without loading dotenv', () => {
    const yaml = readFileSync('regime_config.live.yaml', 'utf8');
    const report = contextualPreflight({ ...source, yaml });
    const enabled = contextualPreflight({ ...source, yaml, archiveOverride: 'true' });
    const disabled = contextualPreflight({ ...source, yaml, archiveOverride: 'false' });
    expect(enabled.hashes.effectiveConfig).not.toBe(disabled.hashes.effectiveConfig);
    expect(report.grantsAuthority).toBe(false);
  });
});
