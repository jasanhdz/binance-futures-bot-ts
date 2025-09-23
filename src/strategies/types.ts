import { Logger } from 'src/core/ports/Logger';
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
  logger?: Logger;
};

export interface Strategy {
  name: string;
  timeframe: string;
  evaluate(ctx: StrategyContext): Promise<Signal>;
}
