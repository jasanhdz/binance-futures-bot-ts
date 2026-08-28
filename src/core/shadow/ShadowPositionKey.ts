import { StrategyId } from '../../domain/strategy/StrategyIdentity';

export interface ShadowPositionKey {
  readonly strategyId: StrategyId;
  readonly symbol: string;
}

export function shadowPositionKey(strategyId: StrategyId, symbol: string): ShadowPositionKey {
  if (!strategyId || !symbol.trim()) throw new Error('SHADOW_POSITION_KEY_INVALID');
  return Object.freeze({ strategyId, symbol: symbol.trim().toUpperCase() });
}

export function serializeShadowPositionKey(key: ShadowPositionKey): string {
  return `${key.strategyId}:${key.symbol}`;
}
