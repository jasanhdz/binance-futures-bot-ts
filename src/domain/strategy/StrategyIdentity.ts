export type StrategyId = 'AEGIS_TURBO' | 'MOMENTUM_RIDE' | 'MICRO_BURST_V1';

export type StrategyMode = 'OFF' | 'SHADOW' | 'LIVE';

export type StrategyFreezeState =
  | 'DRAFT'
  | 'SHADOW_CANDIDATE'
  | 'FROZEN_SHADOW'
  | 'FROZEN_LIVE_CANDIDATE'
  | 'FROZEN_LIVE'
  | 'RETIRED'
  | 'INVALIDATED';

export type Sha256Digest = `sha256:${string}`;

export interface StrategyIdentity {
  strategyId: StrategyId;
  strategyVersion: string;
  freezeState: StrategyFreezeState;
  strategyHash?: Sha256Digest;
  configHash?: Sha256Digest;
  codeCommitSha: string;
}

export function createUnfrozenStrategyIdentity(
  strategyId: StrategyId,
  strategyVersion: string,
  codeCommitSha: string,
): StrategyIdentity {
  return {
    strategyId,
    strategyVersion,
    freezeState: 'DRAFT',
    codeCommitSha,
  };
}

export function isFrozenStrategyIdentity(identity: StrategyIdentity): boolean {
  const frozenState =
    identity.freezeState === 'FROZEN_SHADOW' ||
    identity.freezeState === 'FROZEN_LIVE_CANDIDATE' ||
    identity.freezeState === 'FROZEN_LIVE';

  return Boolean(
    frozenState &&
      identity.strategyHash &&
      identity.configHash &&
      isSha256Digest(identity.strategyHash) &&
      isSha256Digest(identity.configHash) &&
      identity.codeCommitSha.trim().length > 0,
  );
}

export function hasLiveAuthority(identity: StrategyIdentity, mode: StrategyMode): boolean {
  if (mode !== 'LIVE') return false;
  if (identity.freezeState === 'RETIRED' || identity.freezeState === 'INVALIDATED') return false;
  return identity.freezeState === 'FROZEN_LIVE' && isFrozenStrategyIdentity(identity);
}

function isSha256Digest(value: string): value is Sha256Digest {
  return /^sha256:[a-f0-9]{64}$/i.test(value);
}
