import { StrategyExecutionIntent } from '../../strategy/StrategyExecution';
import { MicroBurstApprovedEntry } from './MicroBurstTypes';

export function createMicroBurstExecutionIntent(
  approved: MicroBurstApprovedEntry,
): StrategyExecutionIntent {
  return {
    identity: approved.identity,
    signalId: approved.signalId,
    tradeId: approved.tradeId,
    symbol: approved.symbol,
    requestedAt: approved.requestedAt,
    side: approved.side,
    leverage: approved.leverage,
    positionFraction: approved.positionFraction,
    structuralStopPrice: approved.stopInvalidationPrice,
    destinationPrice: approved.targetPrice,
    protection: {
      requireStop: true,
      requireTakeProfit: false,
      closeIfProtectionFails: true,
    },
    metadata: {
      strategy: 'MICRO_BURST_V1',
      leverageTier: approved.leverage > 30 ? 'HIGH' : 'MEDIUM',
    },
  };
}
