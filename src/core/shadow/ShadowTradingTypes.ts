import { Side } from '../types';
import { StrategyId } from '../strategy/StrategyIdentity';
import { ShadowPositionKey } from './ShadowPositionKey';

export type ShadowPositionState =
  | 'OPEN_SHADOW'
  | 'MANAGING'
  | 'CLOSED'
  | 'DATA_UNCERTAIN'
  | 'RECOVERY_BLOCKED';

export interface ShadowProvenance {
  readonly strategyVersion: string;
  readonly codeCommitSha: string;
  readonly configHash?: string;
  readonly cohortId?: string;
}

export interface ShadowEntryIntent {
  readonly strategyId: StrategyId;
  readonly strategyVersion: string;
  readonly symbol: string;
  readonly side: Side;
  readonly decisionAtMs: number;
  readonly decisionReceivedAtMs: number;
  readonly referencePrice: number;
  readonly structuralStop?: number;
  readonly destination?: number;
  readonly leverage?: number;
  readonly positionFraction?: number;
  readonly parentDecisionId: string;
  readonly provenance: ShadowProvenance;
  readonly diagnostics?: Record<string, unknown>;
}

export interface ShadowMarketQuote {
  readonly bestBid: number;
  readonly bestAsk: number;
  readonly observedAtMs: number;
  /** Local receive time. Exchange event time, when available, is provenance only. */
  readonly exchangeTimeMs?: number;
  readonly status: 'HEALTHY' | 'STALE' | 'UNSYNCED' | 'UNAVAILABLE' | 'ANOMALOUS';
}

export interface ShadowManagementObservation {
  readonly exchangeTimeMs: number;
  readonly receivedAtMs: number;
  readonly currentPrice: number;
  readonly quote?: ShadowMarketQuote;
  readonly marketDataQuality: 'HEALTHY' | 'STALE' | 'UNSYNCED' | 'UNAVAILABLE' | 'ANOMALOUS';
  readonly strategyContext?: unknown;
}

export type ShadowPolicyDecision =
  | { action: 'HOLD'; reason?: string; diagnostics?: Record<string, unknown> }
  | { action: 'MOVE_STOP'; stop: number; reason?: string; diagnostics?: Record<string, unknown> }
  | { action: 'CLOSE'; reason: string; diagnostics?: Record<string, unknown> };

export interface ShadowCostScenario {
  readonly feeBps: number;
  readonly additionalSlippageBps: number;
}

export interface ShadowPosition {
  readonly schemaVersion: 2;
  readonly key: ShadowPositionKey;
  readonly strategyId: StrategyId;
  readonly strategyVersion: string;
  readonly symbol: string;
  readonly side: Side;
  readonly tradeId: string;
  readonly parentDecisionId: string;
  readonly decisionAtMs: number;
  readonly decisionReceivedAtMs: number;
  readonly openedAtMs: number;
  readonly openedReceivedAtMs: number;
  readonly entryDecisionPrice: number;
  readonly entryExecutablePrice: number;
  readonly entryPrice: number;
  /** Immutable entry invalidation; `stop` may later become a profit lock. */
  readonly initialStructuralStop?: number;
  readonly stop?: number;
  readonly destination?: number;
  readonly leverage?: number;
  readonly positionFraction?: number;
  readonly state: ShadowPositionState;
  readonly lastObservedAtMs: number;
  readonly peakPrice: number;
  readonly troughPrice: number;
  readonly mfeBps: number;
  readonly maeBps: number;
  readonly closedAtMs?: number;
  readonly closedReceivedAtMs?: number;
  readonly exitExecutablePrice?: number;
  readonly exitReason?: string;
  readonly grossBps?: number;
  readonly netBpsByCostScenario?: Record<string, number>;
  readonly provenance: ShadowProvenance;
  readonly diagnostics?: Record<string, unknown>;
  /** Latest policy assessment persisted for deterministic black-box attribution. */
  readonly latestManagementDecision?: {
    readonly action: ShadowPolicyDecision['action'];
    readonly reason?: string;
    readonly observedAtMs: number;
    readonly diagnostics?: Record<string, unknown>;
  };
}

export interface ShadowTradeEvent {
  readonly schemaVersion: 1;
  readonly event:
    | 'OPENED'
    | 'ENTRY_SUPPRESSED'
    | 'UNFILLED_DATA_UNCERTAIN'
    | 'STOP_MOVED'
    | 'DATA_UNCERTAIN'
    | 'RECOVERY_BLOCKED'
    | 'CLOSED';
  readonly eventAtMs: number;
  readonly tradeId?: string;
  readonly strategyId: StrategyId;
  readonly symbol: string;
  readonly state: ShadowPositionState;
  readonly reason?: string;
  readonly parentDecisionId?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface ShadowStrategyPolicy {
  readonly strategyId: StrategyId;
  evaluateLifecycle(
    position: ShadowPosition,
    observation: ShadowManagementObservation,
  ): ShadowPolicyDecision;
}
