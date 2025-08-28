import { Exchange } from '../core/ports/Exchange';
import { BotState, Signal } from '../core/types';

import type { CONFIG as RuntimeConfig } from '../infra/config';
type BotConfig = typeof RuntimeConfig;

export type StrategyContext = {
  symbol: string;
  exchange: Exchange;
  config: BotConfig; // ⟵ en vez de any
  state: BotState;
  now: number;
};

export interface Strategy {
  name: string;
  timeframe: string;
  evaluate(ctx: StrategyContext): Promise<Signal>;
}
