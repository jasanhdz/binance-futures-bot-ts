import { BotState } from '../../domain/types';
import { StrategyIdentity, StrategyId } from '../../domain/strategy/StrategyIdentity';
import { resolveStrategyOwnership } from '../../domain/strategy/StrategyPositionOwnership';

export interface StrategyTelemetryIdentity {
  strategy: Extract<StrategyId, 'AEGIS_TURBO' | 'MOMENTUM_RIDE'>;
  strategy_version?: string;
  strategy_hash?: string;
  config_hash?: string;
  code_commit_sha?: string;
}

export function telemetryIdentityFromStrategy(identity: StrategyIdentity): StrategyTelemetryIdentity {
  if (identity.strategyId === 'MICRO_BURST_V1') {
    throw new Error('MICRO_BURST_TELEMETRY_NOT_ENABLED_YET');
  }
  return {
    strategy: identity.strategyId,
    strategy_version: identity.strategyVersion,
    strategy_hash: identity.strategyHash,
    config_hash: identity.configHash,
    code_commit_sha: identity.codeCommitSha,
  };
}

export function telemetryIdentityFromState(state: BotState): StrategyTelemetryIdentity {
  const ownership = resolveStrategyOwnership(state);
  const strategy = ownership.status === 'OWNED' && ownership.strategyId === 'MOMENTUM_RIDE'
    ? 'MOMENTUM_RIDE'
    : 'AEGIS_TURBO';

  return {
    strategy,
    strategy_version: state.lastStrategyVersion,
    strategy_hash: state.lastStrategyHash,
    config_hash: state.lastConfigHash,
    code_commit_sha: state.lastCodeCommitSha,
  };
}
