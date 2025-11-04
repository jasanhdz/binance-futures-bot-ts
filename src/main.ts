// src/main.ts
import 'dotenv/config';
import { BinanceExchange } from './infra/binance/BinanceExchange';
import { FsStateStore } from './infra/fs/FsStateStore';
import { FsLogger } from './infra/fs/FsLogger';
import { CONFIG } from './infra/config';
import { StrategyRunner } from './app/strategy-runner';
import { startBot } from './app/bot';
import { composeStrategies } from './strategies/composite';
import { BreakRetest } from './strategies/break_retest';
import { ImpulsePullbackContinuation } from './strategies/impulse_pullback_continuation';
import { StackingClassicStrategy } from './strategies/stacking_classic';

async function main() {
  const logger = new FsLogger();
  const exchange = new BinanceExchange(logger);
  const strategy = composeStrategies([
    { name: ImpulsePullbackContinuation.name, strategy: ImpulsePullbackContinuation },
    { name: BreakRetest.name, strategy: BreakRetest },
    { name : StackingClassicStrategy.name, strategy: StackingClassicStrategy },
  ])

  logger.info('environment_boot', {
    network: CONFIG.IS_TESTNET ? 'TESTNET' : 'PROD',
    http: CONFIG.HTTP_FUTURES,
    ws: CONFIG.WS_FUTURES,
  });

  const uniqueSymbols = Array.from(
    new Set(CONFIG.SYMBOLS && CONFIG.SYMBOLS.length ? CONFIG.SYMBOLS : [CONFIG.SYMBOL]),
  );

  if (!uniqueSymbols.length) {
    logger.error('no_symbols_configured');
    return;
  }

  uniqueSymbols.forEach((symbol, idx) => {
    const allocation = CONFIG.SYMBOL_ALLOCATIONS[symbol] ?? 0;
    const capitalUsage =
      allocation > 0 ? allocation : CONFIG.CAPITAL_USAGE_PCT;
    const leverage = CONFIG.SYMBOL_LEVERAGE[symbol] ?? CONFIG.LEVERAGE;

    const baseRisk = (CONFIG.MAX_RISK_PCT ?? 0) as number;
    const usageRatio =
      CONFIG.CAPITAL_USAGE_PCT > 0
        ? capitalUsage / CONFIG.CAPITAL_USAGE_PCT
        : 1;
    const riskPct =
      baseRisk > 0 ? Math.max(0, Math.min(baseRisk * usageRatio, baseRisk)) : baseRisk;

    const stateScope = CONFIG.IS_TESTNET ? 'testnet' : 'prod';
    const state = new FsStateStore(symbol, stateScope);
    const perSymbolConfig: typeof CONFIG = {
      ...CONFIG,
      SYMBOL: symbol,
      SYMBOL_SHARE: capitalUsage,
      LEVERAGE: leverage,
      CAPITAL_USAGE_PCT: capitalUsage,
      MAX_RISK_PCT: riskPct,
    };

    logger.info('symbol_runner_start', {
      symbol,
      capitalUsage,
      leverage,
    });

    const runner = new StrategyRunner({ exchange, logger, state, strategy, config: perSymbolConfig });
    startBot({
      runner,
      symbol,
      exchange,
      state,
      logger,
      intervalSec: Math.max(5, CONFIG.BOT_INTERVAL_SEC),
      initialDelayMs: idx * Math.max(500, CONFIG.BOT_STAGGER_MS),
    });
  });

}
main().catch(console.error);
