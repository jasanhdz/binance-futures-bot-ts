// src/main.ts
import 'dotenv/config';
import { BinanceExchange } from './infra/binance/BinanceExchange';
import { FsLogger } from './infra/fs/FsLogger';
import { CONFIG } from './infra/config';
import { MlProbability } from './strategies/ml_probability';
import { SymbolManager } from './app/SymbolManager';

async function main() {
  const logger = new FsLogger();
  const exchange = new BinanceExchange(logger);
  const strategy = MlProbability;

  logger.info('environment_boot', {
    network: CONFIG.IS_TESTNET ? 'TESTNET' : 'PROD',
    http: CONFIG.HTTP_FUTURES,
    ws: CONFIG.WS_FUTURES,
  });

  // Initialize SymbolManager for dynamic hot-reload
  const symbolManager = new SymbolManager({
    logger,
    exchange,
    strategy,
  });

  // Start watching for model changes and initialize active symbols
  symbolManager.start();

  logger.info('symbol_manager_initialized', {
    runningSymbols: symbolManager.getRunningCount(),
  });

  // Graceful shutdown
  process.on('SIGTERM', () => {
    logger.info('shutdown_signal', { signal: 'SIGTERM' });
    symbolManager.stop();
    process.exit(0);
  });
}

main().catch(console.error);

