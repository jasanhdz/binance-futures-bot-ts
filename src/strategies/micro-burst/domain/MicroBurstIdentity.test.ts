import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { hasLiveAuthority } from '../../../core/strategy/StrategyIdentity';
import { parseMicroBurstConfig } from '../application/MicroBurstConfigLoader';
import {
  createMicroBurstV1Identity,
  hasMicroBurstV1LiveAuthority,
  MICRO_BURST_V1_APPROVED_COMMIT,
  MICRO_BURST_V1_CONFIG_SHA256,
  MICRO_BURST_V1_STRATEGY_SHA256,
} from './MicroBurstIdentity';

interface FreezeManifest {
  freezeState: string;
  approvedCommit: string;
  strategySha256: string;
  configFile: string;
  configFileSha256: string;
  effectiveConfigSha256: string;
  componentFiles: Record<string, string>;
}

const repoRoot = resolve(__dirname, '../../../..');
const sha256 = (path: string): string =>
  createHash('sha256')
    .update(readFileSync(resolve(repoRoot, path)))
    .digest('hex');
const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};

describe('Micro Burst LIVE freeze identity', () => {
  it('binds LIVE authority to the approved code and configuration manifest', () => {
    const manifest = JSON.parse(
      readFileSync(resolve(repoRoot, 'config/micro-burst-live-freeze-v0.7.0.json'), 'utf8'),
    ) as FreezeManifest;
    const componentDigestInput = Object.entries(manifest.componentFiles)
      .map(([path, expected]) => {
        expect(sha256(path), path).toBe(expected);
        return `${expected}  ${path}\n`;
      })
      .join('');
    const strategyHash = createHash('sha256').update(componentDigestInput).digest('hex');

    expect(manifest.freezeState).toBe('FROZEN_LIVE');
    expect(manifest.approvedCommit).toBe(MICRO_BURST_V1_APPROVED_COMMIT);
    expect(manifest.approvedCommit).toMatch(/^[a-f0-9]{40}$/);
    expect(strategyHash).toBe(manifest.strategySha256);
    expect(sha256(manifest.configFile)).toBe(manifest.configFileSha256);
    const yaml = load(readFileSync(resolve(repoRoot, manifest.configFile), 'utf8')) as {
      micro_burst?: unknown;
    };
    const effectiveConfigHash = createHash('sha256')
      .update(stable(parseMicroBurstConfig({ micro_burst: yaml.micro_burst })))
      .digest('hex');
    expect(effectiveConfigHash).toBe(manifest.effectiveConfigSha256);
    expect(MICRO_BURST_V1_STRATEGY_SHA256).toBe(manifest.strategySha256);
    expect(MICRO_BURST_V1_CONFIG_SHA256).toBe(manifest.effectiveConfigSha256);
    expect(hasLiveAuthority(createMicroBurstV1Identity(), 'LIVE')).toBe(true);
  });

  it('denies LIVE authority unless deployed commit and effective config match exactly', () => {
    const approvedCommit = 'a'.repeat(40);
    const identity = createMicroBurstV1Identity(approvedCommit);

    expect(
      hasMicroBurstV1LiveAuthority(identity, MICRO_BURST_V1_CONFIG_SHA256, approvedCommit),
    ).toBe(true);
    expect(
      hasMicroBurstV1LiveAuthority(identity, 'b'.repeat(64), approvedCommit),
    ).toBe(false);
    expect(
      hasMicroBurstV1LiveAuthority(identity, MICRO_BURST_V1_CONFIG_SHA256, 'b'.repeat(40)),
    ).toBe(false);
    expect(
      hasMicroBurstV1LiveAuthority(
        createMicroBurstV1Identity('PENDING_FREEZE_COMMIT'),
        MICRO_BURST_V1_CONFIG_SHA256,
        'PENDING_FREEZE_COMMIT',
      ),
    ).toBe(false);
  });
});
