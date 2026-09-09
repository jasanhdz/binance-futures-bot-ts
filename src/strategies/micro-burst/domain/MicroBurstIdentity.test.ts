import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hasLiveAuthority } from '../../../core/strategy/StrategyIdentity';
import {
  createMicroBurstIdentity,
  createMicroBurstEpisodeId,
  diagnoseMicroBurstAuthority,
  hasMicroBurstLiveAuthority,
  MICRO_BURST_CONFIG_SHA256,
  MICRO_BURST_LIVE_AUTHORITY_ENABLED,
  MICRO_BURST_STRATEGY_SHA256,
  MICRO_BURST_VERSION,
} from './MicroBurstIdentity';

describe('Micro Burst canonical identity', () => {
  it('preserves the causal episode digest across the historical namespace rename', () => {
    const historical = createMicroBurstEpisodeId(
      'ETHUSDT',
      'LONG',
      1234,
      'reaction-entry-2-contextual-shadow:SUPPORT:100:1000',
    );
    expect(createMicroBurstEpisodeId('ETHUSDT', 'LONG', 1234, 'MICRO:SUPPORT:100:1000')).toBe(
      historical,
    );
    expect(historical).toMatch(/^MB-EP-[a-f0-9]{24}$/);
  });
  it('does not mistake matching environment labels for an attested artifact', () => {
    const input = {
      identity: createMicroBurstIdentity('a'.repeat(40), MICRO_BURST_CONFIG_SHA256),
      effectiveConfigSha256: MICRO_BURST_CONFIG_SHA256,
      declaredCommitSha: 'a'.repeat(40),
      artifactVerified: false,
      sourceDirty: false,
    };
    expect(diagnoseMicroBurstAuthority(input)).toMatchObject({
      status: 'UNVERIFIED',
      grantsAuthority: false,
    });
    expect(
      diagnoseMicroBurstAuthority({
        ...input,
        artifactVerified: true,
        artifactCommitSha: 'b'.repeat(40),
      }),
    ).toMatchObject({ status: 'MISMATCH', grantsAuthority: false });
    expect(
      diagnoseMicroBurstAuthority({
        ...input,
        artifactVerified: true,
        artifactCommitSha: 'a'.repeat(40),
      }),
    ).toMatchObject({ status: 'MATCHED_EVIDENCE', grantsAuthority: false });
  });
  beforeEach(() => {
    vi.stubEnv('MICRO_BURST_APPROVED_COMMIT', undefined);
    vi.stubEnv('MICRO_BURST_APPROVED_CONFIG_SHA256', MICRO_BURST_CONFIG_SHA256);
  });
  afterEach(() => vi.unstubAllEnvs());

  it('uses the separately approved deployment revision and owner-approved effective config', () => {
    vi.stubEnv('MICRO_BURST_APPROVED_COMMIT', 'a'.repeat(40));
    const identity = createMicroBurstIdentity();
    expect(identity).toMatchObject({
      strategyId: 'MICRO_BURST',
      strategyVersion: 'MICRO',
      freezeState: 'FROZEN_LIVE',
      codeCommitSha: 'a'.repeat(40),
    });
    expect(identity.strategyHash).toBe(`sha256:${MICRO_BURST_STRATEGY_SHA256}`);
    expect(identity.configHash).toBe(`sha256:${MICRO_BURST_CONFIG_SHA256}`);
    expect(MICRO_BURST_VERSION).toBe(identity.strategyVersion);
    expect(MICRO_BURST_STRATEGY_SHA256).toMatch(/^[a-f0-9]{64}$/);
    expect(MICRO_BURST_CONFIG_SHA256).toBe(
      '132879584379e97474309df05d99552a6b835fecdcbe38d3b586b7bfb76633e1',
    );
    expect(MICRO_BURST_LIVE_AUTHORITY_ENABLED).toBe(true);
    expect(hasLiveAuthority(identity, 'LIVE')).toBe(true);
  });

  it('does not infer approval from the observed code revision', () => {
    vi.stubEnv('GIT_COMMIT_SHA', 'a'.repeat(40));
    const identity = createMicroBurstIdentity();
    expect(identity.codeCommitSha).toBe('UNKNOWN');
    expect(hasMicroBurstLiveAuthority(identity, MICRO_BURST_CONFIG_SHA256, 'a'.repeat(40))).toBe(
      false,
    );
  });

  it.each(['UNKNOWN', '', 'a'.repeat(63), 'g'.repeat(64)])(
    'rejects matching malformed config approval %s',
    (hash) => {
      const identity = createMicroBurstIdentity('a'.repeat(40), hash);
      expect(hasMicroBurstLiveAuthority(identity, hash, 'a'.repeat(40))).toBe(false);
    },
  );

  it.each(['', 'UNKNOWN', 'a'.repeat(39), `${'a'.repeat(40)}-dirty`])(
    'rejects invalid deployment approval %s',
    (revision) => {
      vi.stubEnv('MICRO_BURST_APPROVED_COMMIT', revision);
      expect(
        hasMicroBurstLiveAuthority(createMicroBurstIdentity(), MICRO_BURST_CONFIG_SHA256, revision),
      ).toBe(false);
    },
  );

  it('retains exact deployment revision matching with explicit approval', () => {
    vi.stubEnv('MICRO_BURST_APPROVED_COMMIT', 'a'.repeat(40));
    const identity = createMicroBurstIdentity();
    expect(hasMicroBurstLiveAuthority(identity, MICRO_BURST_CONFIG_SHA256, 'a'.repeat(40))).toBe(
      true,
    );
    expect(hasMicroBurstLiveAuthority(identity, MICRO_BURST_CONFIG_SHA256, 'b'.repeat(40))).toBe(
      false,
    );
  });

  it('grants LIVE authority when deployed commit and config hash match', () => {
    const commit = '56e4574fe629768524b3f129e4f45e55746c6550';
    const identity = createMicroBurstIdentity(commit);
    const configHash = 'a'.repeat(64);
    identity.configHash = `sha256:${configHash}`;
    expect(hasMicroBurstLiveAuthority(identity, configHash, commit)).toBe(true);
  });

  it('denies LIVE when deployed commit does not match identity commit', () => {
    const identity = createMicroBurstIdentity('a'.repeat(40));
    expect(hasMicroBurstLiveAuthority(identity, MICRO_BURST_CONFIG_SHA256, 'c'.repeat(40))).toBe(
      false,
    );
  });

  it.each(['UNKNOWN', `${'a'.repeat(40)}-dirty`, `sha256:${'b'.repeat(64)}`])(
    'denies LIVE for unsupported code revision %s even when identity and config match',
    (revision) => {
      const identity = createMicroBurstIdentity(revision);
      expect(hasMicroBurstLiveAuthority(identity, MICRO_BURST_CONFIG_SHA256, revision)).toBe(false);
    },
  );

  it('denies LIVE when config hash does not match identity config hash', () => {
    const commit = '56e4574fe629768524b3f129e4f45e55746c6550';
    const identity = createMicroBurstIdentity(commit);
    expect(hasMicroBurstLiveAuthority(identity, 'wrong_hash', commit)).toBe(false);
  });

  it('denies LIVE when freeze state is not FROZEN_LIVE', () => {
    const commit = '56e4574fe629768524b3f129e4f45e55746c6550';
    const identity = createMicroBurstIdentity(commit);
    identity.freezeState = 'FROZEN_LIVE_CANDIDATE';
    expect(hasMicroBurstLiveAuthority(identity, MICRO_BURST_CONFIG_SHA256, commit)).toBe(false);
  });

  it('denies LIVE when code commit SHA is empty', () => {
    const identity = createMicroBurstIdentity();
    identity.codeCommitSha = '';
    expect(hasMicroBurstLiveAuthority(identity, MICRO_BURST_CONFIG_SHA256, 'whatever')).toBe(false);
  });
});
