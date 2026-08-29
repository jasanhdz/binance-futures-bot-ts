import path from 'path';
import { CONFIG } from '../../infra/config/environment';
import { StrategyLossStateRegistry } from '../../infra/state/StrategyLossStateRegistry';
import { AegisMLService } from '../../strategies/aegis/application/AegisMLService';
import { TradingService, type TradingServiceConfig } from '../services/TradingService';
import type { ApplicationInfrastructure } from './ApplicationInfrastructure';

export function composeStrategyRuntime(infrastructure: ApplicationInfrastructure) {
  const { exchange, logger, stateStore, notifier, configManager } = infrastructure;

  const mlService = new AegisMLService();
  const lossStates = new StrategyLossStateRegistry({
    legacyAegisFilePath: path.join(
      process.cwd(),
      'data',
      'runtime',
      'aegis_consecutive_loss_state.json',
    ),
  });

  configManager.validateSingleLiveAegisSymbol();
  const primarySymbols = configManager.getActiveAegisSymbols();
  const legacySymbols = configManager.getActiveSymbols();
  const symbols = primarySymbols.length > 0 ? primarySymbols : legacySymbols;
  if (symbols.length === 0) {
    throw new Error('STARTUP_NO_ACTIVE_SYMBOLS: configure at least one enabled strategy symbol');
  }

  const config: TradingServiceConfig = {
    symbols,
    tickIntervalMs: configManager.system.tick_interval_ms ?? 10_000,
    maxTradesPerDay: configManager.system.max_trades_per_day ?? 100,
    tradingMode: CONFIG.TRADING_MODE,
  };

  const service = new TradingService(
    {
      exchange,
      mlService,
      logger,
      state: stateStore,
      notifier,
      configManager,
      consecutiveLossStateStore: lossStates.storeFor('AEGIS_TURBO'),
    },
    config,
  );

  return { service, config, mlService, lossStates };
}
