import 'dotenv/config';
import { BinanceExchange } from './infra/binance/BinanceExchange';
import { FsStateStore } from './infra/fs/FsStateStore';
import { FsLogger } from './infra/fs/FsLogger';
import { CONFIG } from './infra/config';
import { StrategyRunner } from './app/strategy-runner';
import { IptStrategy } from './strategies/ipt';
import { startBot } from './app/bot';
import { RangeReversionStrategy } from './strategies/range-reversion';
import { makeStrategyRouter } from './strategies/router';

async function main() {
  const exchange = new BinanceExchange();
  const state = new FsStateStore();
  const logger = new FsLogger();
  const strategy = makeStrategyRouter(IptStrategy, RangeReversionStrategy);

  const runner = new StrategyRunner({ exchange, logger, state, strategy });
  startBot({ runner, symbol: CONFIG.SYMBOL, exchange, state, logger, intervalSec: 5 });
}
main().catch(console.error);
