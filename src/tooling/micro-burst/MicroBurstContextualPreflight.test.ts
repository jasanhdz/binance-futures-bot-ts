import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  contextualPreflight,
  MICRO_HISTORICAL_YAML_CHECKPOINT,
} from './MicroBurstContextualPreflight';

const source = { sourceCommit: 'a'.repeat(40), sourceDirty: false };

describe('Micro local preflight', () => {
  it('reports the actual drift without approving it or hiding implementation blockers', () => {
    const report = contextualPreflight({
      ...source,
      yaml: readFileSync('regime_config.live.yaml', 'utf8'),
    });
    expect(report).toMatchObject({
      status: 'BLOCKED',
      grantsAuthority: false,
      hashes: {
        effectiveConfig: '132879584379e97474309df05d99552a6b835fecdcbe38d3b586b7bfb76633e1',
        historicalApprovedConfig:
          '093ab31d5531272246e7d408c0351d3a41e7d3716deaa02bf25ba39a43db2f1b',
        yaml: '5935f7cbf9c1837efa82e84e226dcb9f4e7e4a182ff06b975f98ebae6ce97a1e',
        historicalYamlCheckpoint: MICRO_HISTORICAL_YAML_CHECKPOINT,
      },
    });
    expect(report.blockers).toEqual(
      expect.arrayContaining([
        'APPROVED_EFFECTIVE_CONFIG_MISMATCH',
        'APPROVED_SOURCE_COMMIT_MISMATCH',
      ]),
    );
  });

  it.each([
    '[invalid',
    'micro_burst:\n  mode: LIVE\n  exit_policy:\n    contextual_policy_version: MICRO',
  ])('fails closed for invalid or forbidden config', (yaml) => {
    const report = contextualPreflight({ ...source, yaml });
    expect(report.hashes.effectiveConfig).toBeNull();
    expect(report.blockers).toContain('CONFIG_PARSE_OR_POLICY_VALIDATION_FAILED');
    expect(report.grantsAuthority).toBe(false);
  });

  it('cannot turn a clean research source into approval', () => {
    const report = contextualPreflight({
      ...source,
      yaml: 'micro_burst:\n  mode: OFF\n  exit_policy:\n    contextual_policy_version: MICRO',
    });
    expect(report.blockers).not.toContain('MICRO_NOT_CONFIGURED');
    expect(report.blockers).toContain('APPROVED_SOURCE_COMMIT_MISMATCH');
    expect(report.status).toBe('BLOCKED');
  });

  it('reports dirty and unknown sources independently of config failures', () => {
    const report = contextualPreflight({ yaml: '[', sourceCommit: 'UNKNOWN', sourceDirty: true });
    expect(report.blockers).toEqual(
      expect.arrayContaining(['SOURCE_DIRTY', 'SOURCE_REVISION_UNKNOWN']),
    );
  });

  it('validates only the approved current local source/config and retains separate deployment checks', () => {
    const input = {
      ...source,
      approvedCommit: source.sourceCommit,
      approvedConfigSha256: '132879584379e97474309df05d99552a6b835fecdcbe38d3b586b7bfb76633e1',
      yaml: readFileSync('regime_config.live.yaml', 'utf8'),
    };
    expect(contextualPreflight(input)).toMatchObject({
      status: 'LOCAL_VALIDATED',
      grantsAuthority: false,
      blockers: [],
    });
    expect(contextualPreflight(input).remainingChecks).toContain('RUNNING_ARTIFACT_NOT_ATTESTED');
    expect(contextualPreflight({ ...input, sourceDirty: true }).status).toBe('BLOCKED');
    expect(contextualPreflight({ ...input, approvedCommit: 'b'.repeat(40) }).status).toBe(
      'BLOCKED',
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
