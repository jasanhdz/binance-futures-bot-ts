import { Side } from '../types';
import { StrategyIdentity, StrategyMode } from './StrategyIdentity';

export type StrategyEntryDecision = 'NO_TRADE' | 'ENTRY_INTENT';

export interface StrategyDecisionEnvelope {
  identity: StrategyIdentity;
  mode: StrategyMode;
  symbol: string;
  timestamp: number;
  decision: StrategyEntryDecision;
  side?: Side;
  reason: string;
  confidence?: number;
  structuralInvalidation?: number;
  destinationPrice?: number;
  requestedRisk?: number;
  diagnostics: Record<string, unknown>;
}

export type PositionLifecycleAction = 'HOLD' | 'MOVE_STOP' | 'CLOSE_MARKET' | 'NO_ACTION';

export interface PositionLifecycleDecision {
  identity: StrategyIdentity;
  tradeId: string;
  decision: PositionLifecycleAction;
  reason: string;
  requestedStopPrice?: number;
  diagnostics: Record<string, unknown>;
}

export type StrategyEvaluationResult = Omit<StrategyDecisionEnvelope, 'identity' | 'mode'>;
export type PositionManagementResult = Omit<PositionLifecycleDecision, 'identity'>;
