import { StrategyIdentity } from '../../strategy/StrategyIdentity';

const MICRO_BURST_V1_VERSION = '0.1.0-scaffold';

export function createMicroBurstV1Identity(codeCommitSha = 'UNFROZEN'): StrategyIdentity {
  return {
    strategyId: 'MICRO_BURST_V1',
    strategyVersion: MICRO_BURST_V1_VERSION,
    freezeState: 'DRAFT',
    codeCommitSha,
  };
}
