import { StrategyIdentity } from '../../strategy/StrategyIdentity';

const MICRO_BURST_V1_VERSION = '0.4.0-prospective-validation';

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
