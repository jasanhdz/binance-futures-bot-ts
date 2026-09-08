import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasLiveAuthority } from '../../../core/strategy/StrategyIdentity';
import {
  createMicroBurstV1Identity,
  hasMicroBurstV1LiveAuthority,
  MICRO_BURST_V1_CONFIG_SHA256,
  MICRO_BURST_V1_LIVE_AUTHORITY_ENABLED,
  MICRO_BURST_V1_STRATEGY_SHA256,
  MICRO_BURST_V1_VERSION,
} from './MicroBurstIdentity';

describe('Micro Burst Expected Continuation candidate identity', () => {
  beforeEach(() => vi.stubEnv('MICRO_BURST_APPROVED_COMMIT', undefined));
  afterEach(() => vi.unstubAllEnvs());

  it('uses the separately approved deployment revision and owner-approved effective config', () => {
    vi.stubEnv('MICRO_BURST_APPROVED_COMMIT', 'a'.repeat(40));
    const identity = createMicroBurstV1Identity();
    expect(identity).toMatchObject({
      strategyVersion: '0.9.0-reaction-entry-live',
      freezeState: 'FROZEN_LIVE',
      codeCommitSha: 'a'.repeat(40),
    });
    expect(identity.strategyHash).toBe(
      'sha256:5d3995995c49b3a4397038a7169b44759da8b1f6afc0798d90906e6898548810',
    );
    expect(identity.configHash).toBe(
      'sha256:957d53b90e8d57eb9233e468722e85786a42a9244dc88b6cd66fc485421aa3ba',
    );
    expect(MICRO_BURST_V1_VERSION).toBe(identity.strategyVersion);
    expect(MICRO_BURST_V1_STRATEGY_SHA256).toBe(
      '5d3995995c49b3a4397038a7169b44759da8b1f6afc0798d90906e6898548810',
    );
    expect(MICRO_BURST_V1_CONFIG_SHA256).toBe(
      '957d53b90e8d57eb9233e468722e85786a42a9244dc88b6cd66fc485421aa3ba',
    );
    expect(MICRO_BURST_V1_LIVE_AUTHORITY_ENABLED).toBe(true);
    expect(hasLiveAuthority(identity, 'LIVE')).toBe(true);
  });

  it('does not infer approval from the observed code revision', () => {
    vi.stubEnv('GIT_COMMIT_SHA', 'a'.repeat(40));
    const identity = createMicroBurstV1Identity();
    expect(identity.codeCommitSha).toBe('UNKNOWN');
    expect(
      hasMicroBurstV1LiveAuthority(identity, MICRO_BURST_V1_CONFIG_SHA256, 'a'.repeat(40)),
    ).toBe(false);
  });

  it.each(['', 'UNKNOWN', 'a'.repeat(39), `${'a'.repeat(40)}-dirty`])(
    'rejects invalid deployment approval %s',
    (revision) => {
      vi.stubEnv('MICRO_BURST_APPROVED_COMMIT', revision);
      expect(
        hasMicroBurstV1LiveAuthority(
          createMicroBurstV1Identity(),
          MICRO_BURST_V1_CONFIG_SHA256,
          revision,
        ),
      ).toBe(false);
    },
  );

  it('retains exact deployment revision matching with explicit approval', () => {
    vi.stubEnv('MICRO_BURST_APPROVED_COMMIT', 'a'.repeat(40));
    const identity = createMicroBurstV1Identity();
    expect(
      hasMicroBurstV1LiveAuthority(identity, MICRO_BURST_V1_CONFIG_SHA256, 'a'.repeat(40)),
    ).toBe(true);
    expect(
      hasMicroBurstV1LiveAuthority(identity, MICRO_BURST_V1_CONFIG_SHA256, 'b'.repeat(40)),
    ).toBe(false);
  });

  it('grants LIVE authority when deployed commit and config hash match', () => {
    const commit = '56e4574fe629768524b3f129e4f45e55746c6550';
    const identity = createMicroBurstV1Identity(commit);
    const configHash = 'a'.repeat(64);
    identity.configHash = `sha256:${configHash}`;
    expect(hasMicroBurstV1LiveAuthority(identity, configHash, commit)).toBe(true);
  });

  it('denies LIVE when deployed commit does not match identity commit', () => {
    const identity = createMicroBurstV1Identity('a'.repeat(40));
    expect(
      hasMicroBurstV1LiveAuthority(identity, MICRO_BURST_V1_CONFIG_SHA256, 'c'.repeat(40)),
    ).toBe(false);
  });

  it.each(['UNKNOWN', `${'a'.repeat(40)}-dirty`, `sha256:${'b'.repeat(64)}`])(
    'denies LIVE for unsupported code revision %s even when identity and config match',
    (revision) => {
      const identity = createMicroBurstV1Identity(revision);
      expect(hasMicroBurstV1LiveAuthority(identity, MICRO_BURST_V1_CONFIG_SHA256, revision)).toBe(
        false,
      );
    },
  );

  it('denies LIVE when config hash does not match identity config hash', () => {
    const commit = '56e4574fe629768524b3f129e4f45e55746c6550';
    const identity = createMicroBurstV1Identity(commit);
    expect(hasMicroBurstV1LiveAuthority(identity, 'wrong_hash', commit)).toBe(false);
  });

  it('denies LIVE when freeze state is not FROZEN_LIVE', () => {
    const commit = '56e4574fe629768524b3f129e4f45e55746c6550';
    const identity = createMicroBurstV1Identity(commit);
    identity.freezeState = 'FROZEN_LIVE_CANDIDATE';
    expect(hasMicroBurstV1LiveAuthority(identity, MICRO_BURST_V1_CONFIG_SHA256, commit)).toBe(
      false,
    );
  });

  it('denies LIVE when code commit SHA is empty', () => {
    const identity = createMicroBurstV1Identity();
    identity.codeCommitSha = '';
    expect(hasMicroBurstV1LiveAuthority(identity, MICRO_BURST_V1_CONFIG_SHA256, 'whatever')).toBe(
      false,
    );
  });
});
