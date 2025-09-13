import { StackClassic } from '../strategies/stack_classic';
import { MeanReversion } from '../strategies/mean_reversion';

export const strategyMap = {
  StackClassic,
  MeanReversion,
} as const;

export type StrategyName = keyof typeof strategyMap;
