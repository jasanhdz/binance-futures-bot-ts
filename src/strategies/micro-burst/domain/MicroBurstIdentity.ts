import { StrategyIdentity } from '../../../core/strategy/StrategyIdentity';
import * as crypto from 'crypto';

export const MICRO_BURST_V1_VERSION = '0.7.0-intelligent-exit';

export const MICRO_BURST_V1_SHADOW_AUTHORITY_ENABLED = true;
export const MICRO_BURST_V1_LIVE_AUTHORITY_ENABLED = false;

export function createMicroBurstV1Identity(codeCommitSha = 'UNFROZEN'): StrategyIdentity {
  return {
    strategyId: 'MICRO_BURST_V1',
    strategyVersion: MICRO_BURST_V1_VERSION,
    freezeState: 'DRAFT',
    codeCommitSha,
  };
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
