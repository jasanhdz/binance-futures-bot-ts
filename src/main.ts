// src/main.ts
import 'dotenv/config';
import { BinanceExchange } from './infra/binance/BinanceExchange';
import { FsStateStore } from './infra/fs/FsStateStore';
import { FsLogger } from './infra/fs/FsLogger';
import { CONFIG } from './infra/config';
import { StrategyRunner } from './app/strategy-runner';
import { startBot } from './app/bot';
import { MomentumBreakout } from './strategies/momentum_breakout';

async function main() {
  const logger = new FsLogger();
  const exchange = new BinanceExchange(logger);
  const strategy = MomentumBreakout;

  const uniqueSymbols = Array.from(
    new Set(CONFIG.SYMBOLS && CONFIG.SYMBOLS.length ? CONFIG.SYMBOLS : [CONFIG.SYMBOL]),
  );

  if (!uniqueSymbols.length) {
    logger.error('no_symbols_configured');
    return;
  }

  for (const symbol of uniqueSymbols) {
    const share = CONFIG.SYMBOL_ALLOCATIONS[symbol] ?? 0;
    if (share <= 0) {
      logger.warn('symbol_skipped_zero_share', { symbol });
      continue;
    }

    const state = new FsStateStore(symbol);
    const perSymbolConfig: typeof CONFIG = {
      ...CONFIG,
      SYMBOL: symbol,
      SYMBOL_SHARE: share,
      CAPITAL_USAGE_PCT: CONFIG.CAPITAL_USAGE_PCT * share,
      MAX_RISK_PCT: (CONFIG.MAX_RISK_PCT ?? 0) * share,
    };

    logger.info('symbol_runner_start', { symbol, share });

    const runner = new StrategyRunner({ exchange, logger, state, strategy, config: perSymbolConfig });
    startBot({ runner, symbol, exchange, state, logger, intervalSec: 5 });
  }
}
main().catch(console.error);
