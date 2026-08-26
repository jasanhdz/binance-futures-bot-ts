import { BotState } from '../types';
import { StrategyId } from './StrategyIdentity';

export type StrategyOwnershipResolution =
  | { status: 'OWNED'; strategyId: StrategyId }
  | { status: 'EXTERNAL_OR_MANUAL' }
  | { status: 'LEGACY_UNKNOWN' };

export function resolveStrategyOwnership(state: BotState): StrategyOwnershipResolution {
  if (state.positionOwner === 'EXTERNAL' || state.tradeOrigin === 'MANUAL_EXTERNAL') {
    return { status: 'EXTERNAL_OR_MANUAL' };
  }

  if (state.lastStrategy === 'AEGIS_TURBO' || state.lastStrategy === 'MOMENTUM_RIDE') {
    return { status: 'OWNED', strategyId: state.lastStrategy };
  }

  if (state.lastStrategy === 'MICRO_BURST_V1') {
    return { status: 'OWNED', strategyId: 'MICRO_BURST_V1' };
  }

  if (
    typeof state.lastTradeId === 'string' &&
    state.lastTradeId.startsWith('MOMENTUM-RIDE-')
  ) {
    return { status: 'OWNED', strategyId: 'MOMENTUM_RIDE' };
  }

  if (
    typeof state.lastTradeId === 'string' &&
    state.lastTradeId.startsWith('AEGIS-TURBO-')
  ) {
    return { status: 'OWNED', strategyId: 'AEGIS_TURBO' };
  }

  return { status: 'LEGACY_UNKNOWN' };
}
