import type { Logger } from '../../../app/ports/Logger';
import type {
  SuiSrScoutConfig,
  ScoutDecision,
  LevelCandidateEvent,
  FeatureVector,
  EvidenceEntry,
  ScoutHealth,
  ScoutSymbol,
  SrZone,
} from '../domain/ScoutTypes';
import { TRADEABLE_SYMBOL, FEATURE_SCHEMA_VERSION } from '../domain/ScoutTypes';
import type { MarketDataRuntime } from '../market/ScoutMarketDataRuntime';
import type { ThreeMinuteCandleBuilder, BuiltCandle } from '../market/ThreeMinuteCandleBuilder';
import type { LevelDetector } from '../domain/LevelDetector';
import type { FeatureVectorBuilder } from '../domain/FeatureVector';
import type { BreakRiskPolicy } from '../domain/BreakRiskPolicy';
import type { DecisionPolicy } from '../domain/DecisionPolicy';
import type { RiskPolicy } from '../domain/RiskPolicy';
import type { LiveCanaryExecutor } from './LiveCanaryExecutor';
import type { AsyncEvidenceJournal } from './AsyncEvidenceJournal';
import type { ModelArtifact } from '../domain/ScoutTypes';

let decisionIdCounter = 0;
function nextDecisionId(): string {
  return `dec_${++decisionIdCounter}_${Date.now().toString(36)}`;
}

export interface ScoutCoordinator {
  start(): void;
  stop(): void;
  getHealth(): ScoutHealth;
  getActiveZones(): SrZone[];
}

export interface ScoutCoordinatorDeps {
  readonly config: SuiSrScoutConfig;
  readonly logger: Logger;
  readonly marketData: MarketDataRuntime;
  readonly candleBuilder: ThreeMinuteCandleBuilder;
  readonly levelDetector: LevelDetector;
  readonly featureVectorBuilder: FeatureVectorBuilder;
  readonly breakRiskPolicy: BreakRiskPolicy;
  readonly decisionPolicy: DecisionPolicy;
  readonly riskPolicy: RiskPolicy;
  readonly executor: LiveCanaryExecutor;
  readonly journal: AsyncEvidenceJournal;
  readonly model: ModelArtifact;
}

export function createScoutCoordinator(deps: ScoutCoordinatorDeps): ScoutCoordinator {
  const {
    config,
    logger,
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
  } = deps;

  let running = false;
  let startedAtMs = 0;
  let tickTimer: ReturnType<typeof setInterval> | null = null;
  let activeZones: SrZone[] = [];
  let openPositionCount = 0;
  let consecutiveLosses = 0;
  let dailyLossBps = 0;
  let lastStopTimeMs = 0;
  const decisionsByOutcome: Record<ScoutDecision, number> = {
    ALLOW_REJECTION_LONG: 0,
    ALLOW_REJECTION_SHORT: 0,
    WAIT_BREAKOUT_PULLBACK: 0,
    BLOCK_BREAKOUT_RISK: 0,
    NO_TRADE: 0,
  };

  function processTick(): void {
    if (!running) return;

    const suiHealth = marketData.getHealth(config.symbol);
    const btcHealth = marketData.getHealth(config.contextSymbol);
    const feedHealthy = suiHealth.feed === 'HEALTHY' && btcHealth.feed === 'HEALTHY';

    if (!feedHealthy) {
      logger.debug('scout_tick_feed_unhealthy', {
        sui: suiHealth.feed,
        btc: btcHealth.feed,
      });
      return;
    }

    const suiState = marketData.getState(config.symbol);
    const btcState = marketData.getState(config.contextSymbol);

    const suiCandles1m = suiState.candles1m.items();
    const suiCandles3m = suiState.candles3m.items();
    const btcCandles1m = btcState.candles1m.items();
    const btcCandles3m = btcState.candles3m.items();

    if (suiCandles3m.length < 20 || btcCandles3m.length < 10) {
      logger.debug('scout_tick_insufficient_data', {
        suiCandles: suiCandles3m.length,
        btcCandles: btcCandles3m.length,
      });
      return;
    }

    const currentPrice = suiCandles1m[suiCandles1m.length - 1]?.close ?? 0;
    if (currentPrice <= 0) return;

    const atr = candleBuilder.getAtr('3m', 14);
    if (atr <= 0) return;

    activeZones = levelDetector.updateZones(
      activeZones,
      suiCandles3m[suiCandles3m.length - 1],
      atr,
      Date.now(),
    );

    const candidate = levelDetector.findCandidateEvent(activeZones, currentPrice, atr, Date.now());

    if (!candidate) return;

    const featureVector = featureVectorBuilder.build(
      candidate,
      suiCandles1m.slice(-240),
      suiCandles3m.slice(-240),
      suiState.aggTrades.items().slice(-900),
      suiState.depthBids.items().slice(-60),
      suiState.depthAsks.items().slice(-60),
      btcCandles1m.slice(-120),
      btcCandles3m.slice(-120),
      btcState.aggTrades.items().slice(-600),
      0,
      0,
      Date.now(),
    );

    const breakResult = breakRiskPolicy.evaluate(
      candidate,
      featureVector,
      suiCandles3m.slice(-config.breakConfirmationCandles - 1),
      config.breakConfirmationCandles,
    );

    let finalDecision: ScoutDecision;
    let blockReasons: string[] = [];

    if (breakResult.decision === 'BLOCK_BREAKOUT_RISK') {
      finalDecision = 'BLOCK_BREAKOUT_RISK';
      blockReasons = breakResult.reasons;
    } else {
      const decisionResult = decisionPolicy.evaluate(
        candidate,
        featureVector,
        suiCandles1m.slice(-10),
        suiCandles3m.slice(-10),
        suiState.aggTrades.items().slice(-300),
        suiState.depthBids.items().slice(-10),
        suiState.depthAsks.items().slice(-10),
      );

      if (decisionResult.decision === 'NO_TRADE') {
        finalDecision = 'NO_TRADE';
        blockReasons = decisionResult.reasons;
      } else {
        const riskCheck = riskPolicy.checkAllGates(candidate, featureVector, config, {
          feedHealthy,
          openPositionCount,
          consecutiveLosses,
          dailyLossBps,
          lastStopTimeMs,
          nowMs: Date.now(),
        });

        if (!riskCheck.allowed) {
          finalDecision = 'NO_TRADE';
          blockReasons = riskCheck.reasons;
        } else {
          finalDecision = decisionResult.decision;
          blockReasons = [];
        }
      }
    }

    decisionsByOutcome[finalDecision]++;

    const modelPrediction = model.predict(featureVector);

    const decisionId = nextDecisionId();
    const evidence: EvidenceEntry = {
      timestamp: Date.now(),
      decisionId,
      symbol: config.symbol,
      event: candidate,
      featureVector,
      baselineDecision: finalDecision,
      modelDecision: finalDecision,
      modelScore: modelPrediction.probability,
      modelArtifactId: modelPrediction.artifactId,
      finalDecision,
      blockReasons,
      intendedStop: null,
      intendedTarget: null,
      intendedRR: null,
      orderResult: null,
      mfe: null,
      mae: null,
      netResult: null,
      provenance: {
        featureSchemaVersion: FEATURE_SCHEMA_VERSION,
        modelArtifactId: modelPrediction.artifactId,
        modelVersion: model.version,
        configHash: '',
        evaluatedAtMs: Date.now(),
      },
    };

    journal.append(evidence);

    if (finalDecision === 'ALLOW_REJECTION_LONG' || finalDecision === 'ALLOW_REJECTION_SHORT') {
      logger.info('scout_candidate_decision', {
        decisionId,
        decision: finalDecision,
        zone: candidate.zone.id,
        side: candidate.zone.side,
        score: candidate.zone.score,
        touches: candidate.zone.touchCount,
        price: candidate.priceAtEvent,
        modelScore: modelPrediction.probability,
      });

      executor
        .execute(finalDecision, candidate, featureVector, config)
        .then((orderResult) => {
          if (orderResult) {
            openPositionCount++;
          }
        })
        .catch((err) => {
          logger.error('scout_execute_error', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }
  }

  return {
    start(): void {
      if (running) return;
      running = true;
      startedAtMs = Date.now();

      marketData.start({
        onCandle: (event) => {
          candleBuilder.onCandle(event);
        },
      });

      tickTimer = setInterval(processTick, config.tickIntervalMs);

      logger.info('scout_coordinator_started', {
        symbol: config.symbol,
        contextSymbol: config.contextSymbol,
        executionMode: config.executionMode,
        killSwitch: config.killSwitch,
      });
    },

    stop(): void {
      running = false;
      if (tickTimer) {
        clearInterval(tickTimer);
        tickTimer = null;
      }
      marketData.stop();
      journal.flush().catch(() => {});
      logger.info('scout_coordinator_stopped');
    },

    getHealth(): ScoutHealth {
      return {
        processState: running ? 'RUNNING' : 'STOPPED',
        symbols: marketData.getAllHealth(),
        activePosition: openPositionCount > 0,
        activeOrders: 0,
        modelArtifactId: model.id,
        modelSchemaVersion: model.featureSchemaVersion,
        decisionsByOutcome,
        killSwitch: config.killSwitch,
        uptimeMs: Date.now() - startedAtMs,
        startedAtMs,
      };
    },

    getActiveZones(): SrZone[] {
      return activeZones.filter((z) => !z.broken);
    },
  };
}
