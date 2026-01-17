// src/main.ts
import 'dotenv/config';
import { BinanceExchange } from './infra/binance/BinanceExchange';
import { TelegramService } from './infra/notifications/TelegramService';
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

  // --- SYSTEM HEALTH CHECK ---
  const mlClient = new (require('./ml/ml_probability_service').MlProbabilityServiceClient)();
  const mlHealth = await mlClient.checkHealth();
  let binanceHealth = false;
  try {
    await exchange.getServerTime();
    binanceHealth = true;
  } catch (e) {
    binanceHealth = false;
  }

  const healthIcon = (mlHealth && binanceHealth) ? '✅' : '⚠️';

  TelegramService.sendSystemLog(
    `🟢 *BOT STARTED* 🟢\n\n` +
    `*Network:* ${CONFIG.IS_TESTNET ? 'TESTNET' : 'PROD'}\n` +
    `*Strategy:* Berzerker Mode\n\n` +
    `*Health Check:* ${healthIcon}\n` +
    `• Binance API: ${binanceHealth ? 'Online' : 'OFFLINE ❌'}\n` +
    `• ML Service: ${mlHealth ? 'Online' : 'OFFLINE ❌'}\n\n` +
    `*Active Symbols (${symbolManager.getRunningCount()}):*\n` +
    `${symbolManager.getRunningDetails()}`
  );

  // Graceful shutdown
  process.on('SIGTERM', () => {
    logger.info('shutdown_signal', { signal: 'SIGTERM' });
    TelegramService.sendSystemLog(`🔴 *BOT STOPPING* (SIGTERM)`);
    symbolManager.stop();
    process.exit(0);
  });
}

main().catch(console.error);

