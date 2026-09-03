import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BinanceExchange } from '../src/infra/adapters/BinanceAdapter';
import type { Logger } from '../src/app/ports/Logger';
import { createBinanceScoutMarketDataSource } from '../src/scouts/sui-sr-scout/market/BinanceScoutMarketDataSource';
import { createScoutMarketDataRuntime } from '../src/scouts/sui-sr-scout/market/ScoutMarketDataRuntime';
import { loadSuiSrScoutConfig } from '../src/scouts/sui-sr-scout/config/SuiSrScoutConfig';
import { createThreeMinuteCandleBuilder } from '../src/scouts/sui-sr-scout/market/ThreeMinuteCandleBuilder';
import { createLevelDetector } from '../src/scouts/sui-sr-scout/domain/LevelDetector';
import { createFeatureVectorBuilder } from '../src/scouts/sui-sr-scout/domain/FeatureVector';
import { createBreakRiskPolicy } from '../src/scouts/sui-sr-scout/domain/BreakRiskPolicy';
import { createDecisionPolicy } from '../src/scouts/sui-sr-scout/domain/DecisionPolicy';
import { createRiskPolicy } from '../src/scouts/sui-sr-scout/domain/RiskPolicy';
import { createRuleBaselineModel } from '../src/scouts/sui-sr-scout/ml/RuleBaselineModel';
import { createLiveCanaryExecutor } from '../src/scouts/sui-sr-scout/application/LiveCanaryExecutor';
import { createAsyncEvidenceJournal } from '../src/scouts/sui-sr-scout/application/AsyncEvidenceJournal';
import { createScoutStateReconciler } from '../src/scouts/sui-sr-scout/application/ScoutStateReconciler';
import { createScoutCoordinator } from '../src/scouts/sui-sr-scout/application/ScoutCoordinator';

const logger: Logger = {
  debug: (message, context) => console.debug('[sui-scout]', message, context ?? ''),
  info: (message, context) => console.info('[sui-scout]', message, context ?? ''),
  warn: (message, context) => console.warn('[sui-scout]', message, context ?? ''),
  error: (message, context) => console.error('[sui-scout]', message, context ?? ''),
};

async function main(): Promise<void> {
  const minutes = Number(process.env.SUI_SR_SCOUT_SOAK_MINUTES ?? 25);
  if (!Number.isFinite(minutes) || minutes < 20 || minutes > 30) {
    throw new Error('SUI_SR_SCOUT_SOAK_MINUTES must be between 20 and 30');
  }
  const config = loadSuiSrScoutConfig();
  if (config.executionMode !== 'OBSERVE' || config.liveEnabled) {
    throw new Error('The observation soak refuses LIVE_CANARY');
  }

  const exchange = new BinanceExchange(logger);
  const marketData = createScoutMarketDataRuntime(
    config,
    logger,
    createBinanceScoutMarketDataSource(exchange),
  );
  const journal = createAsyncEvidenceJournal(logger);
  const coordinator = createScoutCoordinator({
    config,
    logger,
    marketData,
    candleBuilder: createThreeMinuteCandleBuilder(),
    levelDetector: createLevelDetector(config),
    featureVectorBuilder: createFeatureVectorBuilder(),
    breakRiskPolicy: createBreakRiskPolicy(),
    decisionPolicy: createDecisionPolicy(config),
    riskPolicy: createRiskPolicy(),
    // No order port is ever supplied to the soak.
    executor: createLiveCanaryExecutor(logger, null),
    journal,
    model: createRuleBaselineModel(),
    reconciler: createScoutStateReconciler(exchange),
  });

  const startedAtMs = Date.now();
  await coordinator.start();
  await new Promise<void>((resolve) => setTimeout(resolve, minutes * 60_000));
  const health = coordinator.getHealth();
  const report = {
    startedAtMs,
    endedAtMs: Date.now(),
    durationMs: Date.now() - startedAtMs,
    universe: ['BTCUSDT', 'SUIUSDT'],
    executionMode: 'OBSERVE',
    warmup: health.warmup,
    streams: health.symbols,
    levelsDetected: coordinator.getActiveZones().length,
    decisions: health.decisionsByOutcome,
    journalEntries: journal.getEntryCount(),
    shutdown: 'clean',
  };
  coordinator.stop();
  await journal.close();
  const outputDir = join(process.cwd(), 'data', 'sui-sr-scout', 'soaks');
  await mkdir(outputDir, { recursive: true });
  const stem = `observe-soak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  await writeFile(join(outputDir, `${stem}.json`), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(
    join(outputDir, `${stem}.md`),
    `# SUI SR Scout Observation Soak\n\n- Duration: ${Math.round(report.durationMs / 1000)}s\n- Universe: BTCUSDT (context), SUIUSDT (candidate)\n- Warmup ready: ${report.warmup.ready}\n- Levels detected: ${report.levelsDetected}\n- Journal entries: ${report.journalEntries}\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`,
  );
  console.info(JSON.stringify(report, null, 2));
  // The existing combined-hub transport retains a reconnect timer after all
  // consumers release. Coordinator.stop already released every subscription;
  // exit only after durable report/journal shutdown to keep this CLI bounded.
  process.exit(0);
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
