import { isMicroBurstStrategy } from './MicroBurstLegacy';
import { BotState } from '../types';
import { StrategyId } from './StrategyIdentity';

export type StrategyOwnershipResolution =
  | { status: 'OWNED'; strategyId: StrategyId }
  | { status: 'LEGACY_MIGRATABLE'; strategyId: 'AEGIS_TURBO' | 'MOMENTUM_RIDE' }
  | { status: 'AMBIGUOUS'; strategyIds: StrategyId[] }
  | { status: 'EXTERNAL' }
  | { status: 'UNKNOWN' };

export function resolveStrategyOwnership(state: BotState): StrategyOwnershipResolution {
  if (state.positionOwner === 'EXTERNAL' || state.tradeOrigin === 'MANUAL_EXTERNAL') {
    return { status: 'EXTERNAL' };
  }

  const evidence = new Set<StrategyId>();
  if (
    state.lastStrategy === 'AEGIS_TURBO' ||
    state.lastStrategy === 'MOMENTUM_RIDE' ||
    isMicroBurstStrategy(state.lastStrategy)
  ) {
    evidence.add(isMicroBurstStrategy(state.lastStrategy) ? 'MICRO_BURST' : state.lastStrategy!);
  }
  if (state.lastTradeId?.startsWith('MOMENTUM-RIDE-')) evidence.add('MOMENTUM_RIDE');
  if (state.lastTradeId?.startsWith('AEGIS-TURBO-')) evidence.add('AEGIS_TURBO');
  if (state.lastTradeId?.startsWith('MICRO-BURST-')) evidence.add('MICRO_BURST');

  const strategyIds = [...evidence];
  if (strategyIds.length > 1) return { status: 'AMBIGUOUS', strategyIds };
  if (strategyIds.length === 0) {
    if (
      state.positionOwner === 'AEGIS' &&
      state.tradeOrigin === 'BOT' &&
      state.ownershipStatus === 'VERIFIED'
    ) {
      return { status: 'LEGACY_MIGRATABLE', strategyId: 'AEGIS_TURBO' };
    }
    return { status: 'UNKNOWN' };
  }

  const strategyId = strategyIds[0];
  if (state.positionOwner === 'BOT') {
    return { status: 'OWNED', strategyId };
  }

  if (
    strategyId !== 'MICRO_BURST' &&
    (state.positionOwner === 'AEGIS' || state.tradeOrigin === 'BOT')
  ) {
    return { status: 'LEGACY_MIGRATABLE', strategyId };
  }

  return { status: 'UNKNOWN' };
}
