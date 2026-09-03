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
import type { Logger } from '../../app/ports/Logger';
import type {
  RawCandleEvent,
  RawAggTradeEvent,
  RawDepthEvent,
  MarketDataCallbacks,
} from './market/ScoutMarketDataRuntime';
import type { OrderPort } from './application/LiveCanaryExecutor';

const consoleLogger: Logger = {
  debug: (msg, ctx) => console.debug(`[SCOUT:DEBUG] ${msg}`, ctx ?? ''),
  info: (msg, ctx) => console.info(`[SCOUT:INFO] ${msg}`, ctx ?? ''),
  warn: (msg, ctx) => console.warn(`[SCOUT:WARN] ${msg}`, ctx ?? ''),
  error: (msg, ctx) => console.error(`[SCOUT:ERROR] ${msg}`, ctx ?? ''),
};

function createWsSubscribeFunction(): (
  symbol: string,
  interval: string,
  callbacks: MarketDataCallbacks,
) => (() => void)[] {
  return (symbol: string, interval: string, callbacks: MarketDataCallbacks) => {
    const unsubs: (() => void)[] = [];
    console.log(
      `[SCOUT] Would subscribe to ${symbol} ${interval} (WS not connected in this build)`,
    );
    return unsubs;
  };
}

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

  if (config.executionMode === 'LIVE_CANARY' && config.liveEnabled) {
    console.warn('[SCOUT] ⚠ LIVE CANARY MODE ENABLED — REAL CAPITAL AT RISK');
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

  const wsSubscribe = createWsSubscribeFunction();
  const marketData = createScoutMarketDataRuntime(config, consoleLogger, wsSubscribe);

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
  });

  coordinator.start();

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
