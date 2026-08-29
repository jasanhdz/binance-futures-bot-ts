import {
  CURRENT_BRAIN_BUNDLE_SHA256,
  CURRENT_BRAIN_CONFIGURATION_SHA256,
  CURRENT_BRAIN_MODEL_ID,
} from '../../services/CurrentBrainCanonicalDecision';
import { StrategyIdentity } from '../../strategy/StrategyIdentity';

/**
 * Current Aegis scientific artifacts are hash-bound, but the migrated TS
 * runtime commit has not been frozen yet. Keep that fact explicit instead of
 * fabricating FROZEN_LIVE authority during the architecture migration.
 */
export function createAegisMigrationIdentity(
  runtimeCommitSha = 'UNFROZEN_TS_RUNTIME',
): StrategyIdentity {
  return {
    strategyId: 'AEGIS_TURBO',
    strategyVersion: CURRENT_BRAIN_MODEL_ID,
    freezeState: 'FROZEN_LIVE_CANDIDATE',
    strategyHash: `sha256:${CURRENT_BRAIN_BUNDLE_SHA256}`,
    configHash: `sha256:${CURRENT_BRAIN_CONFIGURATION_SHA256}`,
    codeCommitSha: runtimeCommitSha,
  };
}
