import { describe, expect, it } from 'vitest';
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
  it('is explicitly unfrozen and SHADOW-only until black-box validation', () => {
    const identity = createMicroBurstV1Identity();
    expect(identity).toMatchObject({
      strategyVersion: '0.8.0-expected-continuation-shadow',
      freezeState: 'SHADOW_CANDIDATE',
      codeCommitSha: 'PENDING_BLACK_BOX_VALIDATION',
    });
    expect(identity.strategyHash).toBeUndefined();
    expect(identity.configHash).toBeUndefined();
    expect(MICRO_BURST_V1_VERSION).toBe(identity.strategyVersion);
    expect(MICRO_BURST_V1_STRATEGY_SHA256).toBe('UNFROZEN');
    expect(MICRO_BURST_V1_CONFIG_SHA256).toBe('UNFROZEN');
    expect(MICRO_BURST_V1_LIVE_AUTHORITY_ENABLED).toBe(false);
    expect(hasLiveAuthority(identity, 'LIVE')).toBe(false);
  });

  it('denies LIVE even when callers supply plausible commit and config hashes', () => {
    const commit = 'a'.repeat(40);
    const identity = createMicroBurstV1Identity(commit);
    expect(hasMicroBurstV1LiveAuthority(identity, 'b'.repeat(64), commit)).toBe(false);
    expect(hasMicroBurstV1LiveAuthority(identity, 'c'.repeat(64), 'd'.repeat(40))).toBe(false);
  });
});
