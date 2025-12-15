import { Strategy } from '../strategies/types';
import { MlProbability } from '../strategies/ml_probability';

export const STRATEGY_MAP: Record<string, () => Strategy> = {
  ml_probability: () => MlProbability,
};

export function loadStrategy(name: string): Strategy {
  const factory = STRATEGY_MAP[name];
  if (!factory) {
    throw new Error(`Strategy '${name}' not found.`);
  }
  return factory();
}

export const resolveStrategy = loadStrategy;

export function listStrategies(): string[] {
  return Object.keys(STRATEGY_MAP);
}
