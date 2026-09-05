import { describe, expect, it } from 'vitest';
import { hasLiveAuthority } from '../../../core/strategy/StrategyIdentity';
import {
  createMicroBurstV1Identity,
  hasMicroBurstV1LiveAuthority,
  MICRO_BURST_V1_CONFIG_SHA256,
  MICRO_BURST_V1_LIVE_AUTHORITY_ENABLED,
  MICRO_BURST_V1_STRATEGY_SHA256,
  MICRO_BURST_V1_VERSION,
  MICRO_BURST_V1_APPROVED_COMMIT,
} from './MicroBurstIdentity';

describe('Micro Burst Expected Continuation candidate identity', () => {
  it('is frozen LIVE with approved commit after black-box validation', () => {
    const identity = createMicroBurstV1Identity();
    expect(identity).toMatchObject({
      strategyVersion: '0.8.0-expected-continuation-live',
      freezeState: 'FROZEN_LIVE',
      codeCommitSha: '56e4574fe629768524b3f129e4f45e55746c6550',
    });
    expect(identity.strategyHash).toBe(
      'sha256:5d3995995c49b3a4397038a7169b44759da8b1f6afc0798d90906e6898548810',
    );
    expect(identity.configHash).toBe(
      'sha256:0444662a043cf452cd77cd92e37c1969be86f97e8eb16f1cfb82f41e3a943118',
    );
    expect(MICRO_BURST_V1_VERSION).toBe(identity.strategyVersion);
    expect(MICRO_BURST_V1_STRATEGY_SHA256).toBe(
      '5d3995995c49b3a4397038a7169b44759da8b1f6afc0798d90906e6898548810',
    );
    expect(MICRO_BURST_V1_CONFIG_SHA256).toBe(
      '0444662a043cf452cd77cd92e37c1969be86f97e8eb16f1cfb82f41e3a943118',
    );
    expect(MICRO_BURST_V1_LIVE_AUTHORITY_ENABLED).toBe(true);
    expect(MICRO_BURST_V1_APPROVED_COMMIT).toBe(
      '56e4574fe629768524b3f129e4f45e55746c6550',
    );
    expect(hasLiveAuthority(identity, 'LIVE')).toBe(true);
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
    expect(hasMicroBurstV1LiveAuthority(identity, 'b'.repeat(64), 'c'.repeat(40))).toBe(false);
  });

  it('denies LIVE when config hash does not match identity config hash', () => {
    const commit = '56e4574fe629768524b3f129e4f45e55746c6550';
    const identity = createMicroBurstV1Identity(commit);
    expect(hasMicroBurstV1LiveAuthority(identity, 'wrong_hash', commit)).toBe(false);
  });

  it('denies LIVE when freeze state is not FROZEN_LIVE', () => {
    const commit = '56e4574fe629768524b3f129e4f45e55746c6550';
    const identity = createMicroBurstV1Identity(commit);
    identity.freezeState = 'FROZEN_LIVE_CANDIDATE';
    expect(hasMicroBurstV1LiveAuthority(identity, MICRO_BURST_V1_CONFIG_SHA256, commit)).toBe(false);
  });

  it('denies LIVE when code commit SHA is empty', () => {
    const identity = createMicroBurstV1Identity();
    identity.codeCommitSha = '';
    expect(hasMicroBurstV1LiveAuthority(identity, MICRO_BURST_V1_CONFIG_SHA256, 'whatever')).toBe(false);
  });
});
