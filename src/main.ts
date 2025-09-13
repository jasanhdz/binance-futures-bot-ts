// src/main.ts
import 'dotenv/config';
import { BinanceExchange } from './infra/binance/BinanceExchange';
import { FsStateStore } from './infra/fs/FsStateStore';
import { FsLogger } from './infra/fs/FsLogger';
import { CONFIG } from './infra/config';
import { StrategyRunner } from './app/strategy-runner';
import { startBot } from './app/bot';
import { StackClassic } from './strategies/stack_classic';

async function main() {
  const logger = new FsLogger();
  const exchange = new BinanceExchange(logger);
  const state = new FsStateStore();
  const strategy = StackClassic;

  const runner = new StrategyRunner({ exchange, logger, state, strategy });
  startBot({ runner, symbol: CONFIG.SYMBOL, exchange, state, logger, intervalSec: 5 });
}
main().catch(console.error);
