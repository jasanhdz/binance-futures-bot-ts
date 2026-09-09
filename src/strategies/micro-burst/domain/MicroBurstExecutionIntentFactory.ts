import { StrategyExecutionIntent } from '../../../core/strategy/StrategyExecution';
import { MicroBurstApprovedEntry } from './MicroBurstTypes';
import { isMicroBurstTradePolicy } from './MicroBurstTradePolicy';

export function createMicroBurstExecutionIntent(
  approved: MicroBurstApprovedEntry,
): StrategyExecutionIntent {
  if (
    approved.contextualPolicy &&
    !isMicroBurstTradePolicy(approved.contextualPolicy, approved.identity)
  )
    throw new Error('MICRO_TRADE_POLICY_INVALID');
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
      strategy: 'MICRO_BURST',
      signalSnapshotAtMs: approved.signalSnapshotAtMs,
      leverageTier: approved.leverage === 30 ? 'HIGH' : 'MEDIUM',
      ...(approved.episodeId ? { episodeId: approved.episodeId } : {}),
      ...(approved.contextualPolicy
        ? { contextualPolicy: structuredClone(approved.contextualPolicy) }
        : {}),
    },
  };
}
