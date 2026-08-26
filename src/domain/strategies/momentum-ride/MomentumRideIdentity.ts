import { StrategyIdentity } from '../../strategy/StrategyIdentity';
import { MAIN_STACKING_MOMENTUM_AUTHORITY } from '../../services/MainStackingMomentumStrategy';

const AUTHORITY_PREFIX = 'origin/main@';

export function createMomentumRideLegacyIdentity(): StrategyIdentity {
  const codeCommitSha = MAIN_STACKING_MOMENTUM_AUTHORITY.startsWith(AUTHORITY_PREFIX)
    ? MAIN_STACKING_MOMENTUM_AUTHORITY.slice(AUTHORITY_PREFIX.length)
    : MAIN_STACKING_MOMENTUM_AUTHORITY;

  return {
    strategyId: 'MOMENTUM_RIDE',
    strategyVersion: `main-stacking-${codeCommitSha.slice(0, 7)}-unfrozen`,
    freezeState: 'DRAFT',
    codeCommitSha,
  };
}
