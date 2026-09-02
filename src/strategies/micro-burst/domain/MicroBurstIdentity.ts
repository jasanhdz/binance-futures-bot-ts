import { hasLiveAuthority, StrategyIdentity } from '../../../core/strategy/StrategyIdentity';
import * as crypto from 'crypto';

export const MICRO_BURST_V1_VERSION = '0.7.0-intelligent-exit';
export const MICRO_BURST_V1_STRATEGY_SHA256 =
  'dc3f5c54d7f70b79a1881ade667ee1c2b7da509b3b6b28a0c6933a273bd1b3e0';
export const MICRO_BURST_V1_CONFIG_SHA256 =
  '1279413477f094eb8d88f73e53fabf40fe694d139d563e07995a2f6b995c0223';
export const MICRO_BURST_V1_APPROVED_COMMIT = 'f0716a23dca8302bb41d0e9cba0088986a4f6e22';

export const MICRO_BURST_V1_SHADOW_AUTHORITY_ENABLED = true;
export const MICRO_BURST_V1_LIVE_AUTHORITY_ENABLED = true;

export function createMicroBurstV1Identity(
  codeCommitSha = MICRO_BURST_V1_APPROVED_COMMIT,
): StrategyIdentity {
  return {
    strategyId: 'MICRO_BURST_V1',
    strategyVersion: MICRO_BURST_V1_VERSION,
    freezeState: 'FROZEN_LIVE',
    strategyHash: `sha256:${MICRO_BURST_V1_STRATEGY_SHA256}`,
    configHash: `sha256:${MICRO_BURST_V1_CONFIG_SHA256}`,
    codeCommitSha,
  };
}

export function hasMicroBurstV1LiveAuthority(
  identity: StrategyIdentity,
  effectiveConfigSha256: string,
  deployedCodeCommitSha: string,
): boolean {
  return Boolean(
    hasLiveAuthority(identity, 'LIVE') &&
      /^[a-f0-9]{40}$/i.test(identity.codeCommitSha) &&
      deployedCodeCommitSha.toLowerCase() === identity.codeCommitSha.toLowerCase() &&
      identity.configHash === `sha256:${effectiveConfigSha256}`,
  );
}

/** Stable across processes and independent of insertion order for a chronological episode. */
export function createMicroBurstEpisodeId(
  symbol: string,
  side: string,
  startedAtMs: number,
  cohortId = '',
): string {
  const digest = crypto
    .createHash('sha256')
    .update(`${symbol}\u0000${side}\u0000${cohortId}\u0000${startedAtMs}`)
    .digest('hex')
    .slice(0, 24);
  return `MBV1-EP-${digest}`;
}
