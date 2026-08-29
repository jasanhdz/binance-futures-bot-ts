import { Side } from '../../../core/types';
import {
  StrategyExecutionIntent,
  StrategyProtectionExecutionPolicy,
} from '../../../core/strategy/StrategyExecution';
import { StrategyIdentity } from '../../../core/strategy/StrategyIdentity';

export interface ApprovedAegisExecution {
  identity: StrategyIdentity;
  signalId?: string;
  tradeId: string;
  symbol: string;
  side: Side;
  requestedAt: number;
  risk: {
    leverage: number;
    positionFraction: number;
  };
  protection: StrategyProtectionExecutionPolicy & {
    stopRoe?: number;
    takeProfitRoe?: number;
  };
  failureCloseReasons?: StrategyExecutionIntent['failureCloseReasons'];
  provenance: Record<string, unknown>;
}

export class AegisExecutionIntentFactory {
  static create(approved: ApprovedAegisExecution): StrategyExecutionIntent {
    return {
      identity: approved.identity,
      signalId: approved.signalId,
      tradeId: approved.tradeId,
      symbol: approved.symbol,
      side: approved.side,
      requestedAt: approved.requestedAt,
      leverage: approved.risk.leverage,
      positionFraction: approved.risk.positionFraction,
      stopRoe: approved.protection.stopRoe,
      takeProfitRoe: approved.protection.takeProfitRoe,
      protection: {
        requireStop: approved.protection.requireStop,
        requireTakeProfit: approved.protection.requireTakeProfit,
        // Legacy Aegis always fell through to its outer emergency close even
        // when close_if_bracket_fails was false.
        closeIfProtectionFails: true,
      },
      failureCloseReasons: approved.failureCloseReasons,
      metadata: { ...approved.provenance },
    };
  }
}
