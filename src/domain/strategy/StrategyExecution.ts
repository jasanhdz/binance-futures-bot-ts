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
  metadata: Record<string, unknown>;
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
      status: 'DENIED' | 'FAILED';
      identity: StrategyIdentity;
      tradeId: string;
      symbol: string;
      reason: ExecutionDenialReason;
      metadata: Record<string, unknown>;
    };

export interface StrategyExecutionPort {
  execute(intent: StrategyExecutionIntent): Promise<StrategyExecutionResult>;
}
