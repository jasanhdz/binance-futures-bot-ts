import { hasLiveAuthority, StrategyIdentity } from '../../../core/strategy/StrategyIdentity';
import * as crypto from 'crypto';

export const MICRO_BURST_V1_VERSION = '0.8.0-expected-continuation-shadow';
export const MICRO_BURST_V1_STRATEGY_SHA256 = 'UNFROZEN';
export const MICRO_BURST_V1_CONFIG_SHA256 = 'UNFROZEN';
export const MICRO_BURST_V1_APPROVED_COMMIT = 'PENDING_BLACK_BOX_VALIDATION';

export const MICRO_BURST_V1_SHADOW_AUTHORITY_ENABLED: boolean = true;
export const MICRO_BURST_V1_LIVE_AUTHORITY_ENABLED: boolean = false;

export function createMicroBurstV1Identity(
  codeCommitSha = MICRO_BURST_V1_APPROVED_COMMIT,
): StrategyIdentity {
  return {
    strategyId: 'MICRO_BURST_V1',
    strategyVersion: MICRO_BURST_V1_VERSION,
    freezeState: 'SHADOW_CANDIDATE',
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
