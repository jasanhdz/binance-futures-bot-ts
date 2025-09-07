import 'dotenv/config';
import { BinanceExchange } from './infra/binance/BinanceExchange';
import { FsStateStore } from './infra/fs/FsStateStore';
import { FsLogger } from './infra/fs/FsLogger';
import { CONFIG } from './infra/config';
import { StrategyRunner } from './app/strategy-runner';
import { startBot } from './app/bot';
import { StackStrategy } from './strategies/stack';

async function main() {
  const exchange = new BinanceExchange();
  const state = new FsStateStore();
  const logger = new FsLogger();
  const strategy = StackStrategy;

  const runner = new StrategyRunner({ exchange, logger, state, strategy });
  startBot({ runner, symbol: CONFIG.SYMBOL, exchange, state, logger, intervalSec: 5 });
}
main().catch(console.error);
