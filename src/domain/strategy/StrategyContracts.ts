import type { StrategyRiskSnapshot } from '../risk/StrategyRiskLedger';
import { hasLiveAuthority, StrategyIdentity, StrategyMode } from './StrategyIdentity';
import type { StrategyOwnershipResolution } from './StrategyPositionOwnership';

/** Generic authority contract; the existing predicate remains the runtime implementation. */
export type StrategyExecutionAuthority = (
  identity: StrategyIdentity,
  mode: StrategyMode,
) => boolean;

export const defaultStrategyExecutionAuthority: StrategyExecutionAuthority = hasLiveAuthority;

/** Compatibility name for ownership results while persisted strategy IDs remain unchanged. */
export type PositionOwnership = StrategyOwnershipResolution;

export interface RiskLedgerContract {
  snapshot(strategyId: StrategyIdentity['strategyId'], now?: number): StrategyRiskSnapshot;
  recordOpen(strategyId: StrategyIdentity['strategyId'], openedAt?: number): StrategyRiskSnapshot;
  recordClose(
    strategyId: StrategyIdentity['strategyId'],
    tradeId: string,
    pnlUsdt: number,
    closedAt?: number,
  ): StrategyRiskSnapshot;
}
