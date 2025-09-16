import { StackClassic } from '../strategies/stack_classic';
import { MeanReversion } from '../strategies/mean_reversion';
import { StackStrategy } from '../strategies/stack';

export const strategyMap = {
  StackClassic,
  MeanReversion,
  StackPro: StackStrategy,
} as const;

export type StrategyName = keyof typeof strategyMap;
