import 'dotenv/config';
import { loadSuiSrScoutConfig, validateConfig } from './config/SuiSrScoutConfig';
import { createScoutMarketDataRuntime } from './market/ScoutMarketDataRuntime';
import { createThreeMinuteCandleBuilder } from './market/ThreeMinuteCandleBuilder';
import { createLevelDetector } from './domain/LevelDetector';
import { createFeatureVectorBuilder } from './domain/FeatureVector';
import { createBreakRiskPolicy } from './domain/BreakRiskPolicy';
import { createDecisionPolicy } from './domain/DecisionPolicy';
import { createRiskPolicy } from './domain/RiskPolicy';
import { createRuleBaselineModel } from './ml/RuleBaselineModel';
import { createLiveCanaryExecutor } from './application/LiveCanaryExecutor';
import { createAsyncEvidenceJournal } from './application/AsyncEvidenceJournal';
import { createScoutCoordinator } from './application/ScoutCoordinator';
import { createScoutStateReconciler } from './application/ScoutStateReconciler';
import { createBinanceScoutMarketDataSource } from './market/BinanceScoutMarketDataSource';
import type { Logger } from '../../app/ports/Logger';
import type { OrderPort } from './application/LiveCanaryExecutor';
import { BinanceExchange } from '../../infra/adapters/BinanceAdapter';

const consoleLogger: Logger = {
  debug: (msg, ctx) => console.debug(`[SCOUT:DEBUG] ${msg}`, ctx ?? ''),
  info: (msg, ctx) => console.info(`[SCOUT:INFO] ${msg}`, ctx ?? ''),
  warn: (msg, ctx) => console.warn(`[SCOUT:WARN] ${msg}`, ctx ?? ''),
  error: (msg, ctx) => console.error(`[SCOUT:ERROR] ${msg}`, ctx ?? ''),
};

async function main(): Promise<void> {
  const config = loadSuiSrScoutConfig();
  const errors = validateConfig(config);
  if (errors.length > 0) {
    console.error('[SCOUT] Configuration errors:', errors);
    process.exit(1);
  }

  console.log('[SCOUT] Configuration loaded:', {
    symbol: config.symbol,
    contextSymbol: config.contextSymbol,
    executionMode: config.executionMode,
    liveEnabled: config.liveEnabled,
    killSwitch: config.killSwitch,
    maxLeverage: config.maxLeverage,
    maxQuoteNotional: config.maxQuoteNotional,
  });

  if (config.executionMode !== 'OBSERVE' || config.liveEnabled) {
    throw new Error('This Scout phase is observation-only; LIVE_CANARY is intentionally disabled');
  }

  const orderPort: OrderPort | null = null;
  const executor = createLiveCanaryExecutor(consoleLogger, orderPort);
  const journal = createAsyncEvidenceJournal(consoleLogger);
  const model = createRuleBaselineModel();

  const candleBuilder = createThreeMinuteCandleBuilder();
  const levelDetector = createLevelDetector({
    srZoneAtrTolerance: config.srZoneAtrTolerance,
    srMinTouchCount: config.srMinTouchCount,
    srZoneScoreMin: config.srZoneScoreMin,
    breakConfirmationCandles: config.breakConfirmationCandles,
  });

  // BinanceExchange is used only through its public market-data and read-only account ports.
  // No TradingService, legacy strategy, or order mutation capability is passed to the coordinator.
  const exchange = new BinanceExchange(consoleLogger);
  const marketData = createScoutMarketDataRuntime(
    config,
    consoleLogger,
    createBinanceScoutMarketDataSource(exchange),
  );

  const featureVectorBuilder = createFeatureVectorBuilder();
  const breakRiskPolicy = createBreakRiskPolicy();
  const decisionPolicy = createDecisionPolicy({
    minNetRMultiple: config.minNetRMultiple,
    btcAggressiveThreshold: config.btcAggressiveThreshold,
  });
  const riskPolicy = createRiskPolicy();

  const coordinator = createScoutCoordinator({
    config,
    logger: consoleLogger,
    marketData,
    candleBuilder,
    levelDetector,
    featureVectorBuilder,
    breakRiskPolicy,
    decisionPolicy,
    riskPolicy,
    executor,
    journal,
    model,
    reconciler: createScoutStateReconciler(exchange),
  });

  await coordinator.start();

  const shutdown = async (): Promise<void> => {
    console.log('[SCOUT] Shutting down...');
    coordinator.stop();
    await journal.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  setInterval(() => {
    const health = coordinator.getHealth();
    console.log('[SCOUT] Health:', JSON.stringify(health, null, 2));
  }, 60_000);

  console.log('[SCOUT] SUI SR Scout started in', config.executionMode, 'mode');
}

main().catch((err) => {
  console.error('[SCOUT] Fatal error:', err);
  process.exit(1);
});
