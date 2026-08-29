import { describe, expect, it } from 'vitest';
import {
  createUnfrozenStrategyIdentity,
  hasLiveAuthority,
  isFrozenStrategyIdentity,
} from './StrategyIdentity';

describe('StrategyIdentity', () => {
  it('does not pretend an unfrozen strategy is frozen', () => {
    const identity = createUnfrozenStrategyIdentity('AEGIS_TURBO', 'legacy', 'abc123');

    expect(identity.freezeState).toBe('DRAFT');
    expect(identity.strategyHash).toBeUndefined();
    expect(isFrozenStrategyIdentity(identity)).toBe(false);
    expect(hasLiveAuthority(identity, 'LIVE')).toBe(false);
  });

  it('requires valid hashes before a FROZEN_LIVE identity has authority', () => {
    const digest = `sha256:${'a'.repeat(64)}` as const;
    const identity = {
      strategyId: 'MOMENTUM_RIDE' as const,
      strategyVersion: '1.0.0',
      freezeState: 'FROZEN_LIVE' as const,
      strategyHash: digest,
      configHash: digest,
      codeCommitSha: 'deadbeef',
    };

    expect(isFrozenStrategyIdentity(identity)).toBe(true);
    expect(hasLiveAuthority(identity, 'SHADOW')).toBe(false);
    expect(hasLiveAuthority(identity, 'LIVE')).toBe(true);
  });
});
