import { Side } from '../types';
import { StrategyIdentity } from './StrategyIdentity';

/**
 * Strategy-owned request handed to the shared execution plane.
 * Strategies may describe WHAT they want to do, but they never call Binance.
 */
export interface StrategyExecutionIntent {
  identity: StrategyIdentity;
  signalId?: string;
  tradeId: string;
  symbol: string;
  side: Side;
  requestedAt: number;
  leverage: number;
  positionFraction: number;
  stopRoe?: number;
  takeProfitRoe?: number;
  structuralStopPrice?: number;
  destinationPrice?: number;
  protection: StrategyProtectionExecutionPolicy;
  failureCloseReasons?: {
    positionConfirmation: string;
    protection: string;
    unexpected: string;
  };
  metadata: Record<string, unknown>;
}

export interface StrategyProtectionExecutionPolicy {
  requireStop: boolean;
  requireTakeProfit: boolean;
  closeIfProtectionFails: boolean;
}

export type ExecutionDenialReason =
  | 'SHARED_SAFETY_DENIED'
  | 'POSITION_ALREADY_OPEN'
  | 'INVALID_SIZE'
  | 'INVALID_LEVERAGE'
  | 'SYMBOL_NOT_EXECUTABLE'
  | 'STRATEGY_NOT_LIVE'
  | 'STRATEGY_IDENTITY_INVALID'
  | 'EXCHANGE_REJECTED'
  | 'MARKET_OPEN_AMBIGUOUS'
  | 'BRACKETS_FAILED'
  | 'POSITION_CONFIRMATION_FAILED';

export type StrategyExecutionResult =
  | {
      status: 'OPENED';
      identity: StrategyIdentity;
      tradeId: string;
      symbol: string;
      side: Side;
      orderId: string;
      entryPrice: number;
      quantity: number;
      leverage: number;
      positionFraction: number;
      openedAt: number;
      metadata: Record<string, unknown>;
    }
  | {
      status: 'DENIED';
      identity: StrategyIdentity;
      tradeId: string;
      symbol: string;
      reason: ExecutionDenialReason;
      metadata: Record<string, unknown>;
    }
  | {
      status: 'FAILED';
      identity: StrategyIdentity;
      tradeId: string;
      symbol: string;
      reason: ExecutionDenialReason;
      metadata: Record<string, unknown>;
    };

export interface StrategyExecutionPort {
  execute(intent: StrategyExecutionIntent): Promise<StrategyExecutionResult>;
}
