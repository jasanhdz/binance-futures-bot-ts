import type { CandlePort, OrderBookPort } from '../../../app/ports/MarketData';
import {
  MarketSnapshotProvider,
  type AggTradeFeatureReader,
} from '../../../core/market-data/MarketSnapshotProvider';
import { OrderBookQuoteProvider } from '../../../core/market-data/OrderBookQuoteProvider';
import {
  ComposedBenchmarkMarketDataPort,
  type BenchmarkMarketDataPort,
} from '../../../core/market-data/BenchmarkMarketData';
import {
  BlackBoxStrategyDecisionObservation,
  type StrategyDecisionObservationHook,
} from '../../../core/blackbox/StrategyDecisionObservation';
import {
  StrategyDecisionBlackBox,
  type DecisionEvidenceSink,
  type MarketSnapshotEvidenceSink,
} from '../../../core/blackbox/StrategyDecisionBlackBox';
import type { MicroBurstStrategyContext } from '../domain/MicroBurstStrategy';
import { randomUUID } from 'node:crypto';
import {
  BoundedObservationQueue,
  copyObservation,
} from '../../../core/blackbox/BoundedObservationQueue';
import {
  MICRO_EVIDENCE_LIMITS,
  MICRO_INPUT_COPY_LIMITS,
  encodeMicroReplay,
  type MicroBurstExactReplay,
} from '../domain/MicroBurstExactReplay';
import { createDecisionEvidenceV2 } from '../../../core/blackbox/StrategyDecisionBlackBox';
import type { MarketSnapshotV1 } from '../../../core/market-data/MarketSnapshotProvider';
import type { StrategyDecisionEnvelope } from '../../../core/strategy/StrategyDecision';
import {
  calculateAggTradeFeaturesV1,
  calculateOrderBookFeaturesV1,
  calculateQuoteFeaturesV1,
} from '../../../core/market-data/SharedNeutralMarketFeatures';
import type { SnapshotCapability } from '../../../core/market-data/MarketSnapshotProvider';

export interface MicroBurstBlackBoxObservationDeps {
  readonly clock: { now(): number };
  readonly candles: CandlePort;
  readonly orderBookFor: (symbol: string) => OrderBookPort | undefined;
  readonly aggTradeFor: (symbol: string) => AggTradeFeatureReader | undefined;
  readonly decisionSink: DecisionEvidenceSink;
  readonly marketSnapshotSink: MarketSnapshotEvidenceSink;
  readonly benchmark?: BenchmarkMarketDataPort;
}

/**
 * Phase T observational composition for Micro Burst.
 * It reuses runtime-owned shared market state and has no exchange/execution authority.
 */
export function createMicroBurstBlackBoxObservation(
  deps: MicroBurstBlackBoxObservationDeps,
): StrategyDecisionObservationHook<MicroBurstStrategyContext> {
  const quoteFor = (symbol: string) => {
    const book = deps.orderBookFor(symbol.toUpperCase());
    return book ? new OrderBookQuoteProvider(symbol.toUpperCase(), book) : undefined;
  };
  const benchmark =
    deps.benchmark ??
    new ComposedBenchmarkMarketDataPort({
      candles: () => deps.candles,
      quote: quoteFor,
      orderBook: (symbol) => deps.orderBookFor(symbol.toUpperCase()),
    });
  const snapshotProvider = new MarketSnapshotProvider(
    {
      quoteFor,
      orderBookFor: (symbol) => deps.orderBookFor(symbol.toUpperCase()),
      aggTradeFor: (symbol) => deps.aggTradeFor(symbol.toUpperCase()),
      candles: deps.candles,
      benchmark,
    },
    deps.clock,
  );
  const blackBox = new StrategyDecisionBlackBox(
    deps.decisionSink,
    () => deps.clock.now(),
    deps.marketSnapshotSink,
  );

  const legacy = new BlackBoxStrategyDecisionObservation<MicroBurstStrategyContext>(
    snapshotProvider,
    blackBox,
    (strategyId, context) => {
      if (strategyId !== 'MICRO_BURST') return null;
      return {
        symbol: context.symbol,
        quote: true,
        orderBookFeatures: true,
        aggTrade: true,
        candles: { interval: '1m', limit: 30 },
        // The Micro Burst runtime always owns benchmark candles, but it only owns a BTC
        // order-book lease when BTCUSDT itself is enabled. Do not create a hidden feed merely
        // for evidence collection; optional benchmark depth can be added by shared composition later.
        benchmark: {
          descriptor: { id: 'PRIMARY_CRYPTO_BENCHMARK', symbol: 'BTCUSDT' },
          candles: { interval: '1m', limit: 30 },
        },
      };
    },
  );
  const queue = new BoundedObservationQueue<{
    snapshot: MarketSnapshotV1;
    decision: StrategyDecisionEnvelope;
  }>(MICRO_EVIDENCE_LIMITS, async ({ snapshot: originalSnapshot, decision }) => {
    const persistenceStartedAtMs = deps.clock.now();
    const persistenceStartedMono = performance.now();
    const replay = decision.diagnostics.strategyInputReplay as MicroBurstExactReplay | undefined;
    const snapshot = replay
      ? enrichFromExactInput(originalSnapshot, replay, deps.clock.now())
      : originalSnapshot;
    const reference = await deps.marketSnapshotSink.append(snapshot);
    const timing = decision.diagnostics.evaluationTiming as { evaluationFinishedAtMs: number };
    const serializationStartedMono = performance.now();
    const record = createDecisionEvidenceV2(
      snapshot,
      {
        ...decision,
        diagnostics: {
          ...decision.diagnostics,
          ...(decision.diagnostics.strategyInputReplay
            ? {
                strategyInputReplay: encodeMicroReplay(
                  decision.diagnostics.strategyInputReplay as MicroBurstExactReplay,
                ),
              }
            : {}),
          persistenceStartedAtMs,
          persistenceClock: 'LOCAL_RECEIVE_TIME',
          originalInputSource: 'ROUTER_SUPPLIED_MICRO_CONTEXT',
          postEvaluationEnrichment: replay ? 'POST_EVALUATION_FROM_EXACT_INPUTS' : 'NONE',
        },
      },
      {
        marketSnapshotId: reference.snapshotId,
        marketSnapshotStored: reference.stored,
        marketSnapshotContentHash: reference.contentHash,
      },
      deps.clock.now(),
      timing.evaluationFinishedAtMs,
    );
    const serializationDurationMs = performance.now() - serializationStartedMono;
    await deps.decisionSink.append(record);
    await deps.decisionSink.appendPersistenceTiming?.({
      schema: 'DECISION_PERSISTENCE_TIMING',
      schemaVersion: 1,
      decisionId: record.decisionId,
      persistenceStartedAtMs,
      persistenceFinishedAtMs: deps.clock.now(),
      persistenceDurationMs: performance.now() - persistenceStartedMono,
      serializationDurationMs,
      timestampClock: 'LOCAL_RECEIVE_TIME',
      durationClock: 'MONOTONIC',
      completionBoundary: 'SINK_ACK_NOT_FSYNC_ATTESTATION',
    });
  });
  return {
    beforeEvaluation: legacy.beforeEvaluation.bind(legacy),
    afterEvaluation: legacy.afterEvaluation.bind(legacy),
    captureExactInput(strategyId, context) {
      if (strategyId !== 'MICRO_BURST') return null;
      const captureStartedAtMs = deps.clock.now();
      const captureStartedMono = performance.now();
      const captured = copyObservation(context, MICRO_INPUT_COPY_LIMITS).value;
      const capturedAtMs = deps.clock.now();
      const absent = {
        requested: false,
        status: 'NOT_REQUESTED' as const,
        health: 'NOT_REQUESTED' as const,
        value: null,
        sourceTimestampMs: null,
        sourceTimestampDomain: 'NONE' as const,
      };
      const snapshot: MarketSnapshotV1 = {
        schemaVersion: 1,
        snapshotId: randomUUID(),
        symbol: captured.symbol,
        captureStartedAtMs,
        capturedAtMs,
        primary: {
          quote: absent,
          orderBookFeatures: absent,
          aggTrade: { ...absent, requestedWindowMs: null },
          candles: { ...absent, interval: null, limit: null },
        },
        health: 'UNAVAILABLE',
        provenance: {
          snapshotSchemaVersion: 1,
          featureSchema: 'SHARED_MARKET_FEATURES_V1',
          symbol: captured.symbol,
          request: { symbol: captured.symbol },
        },
      };
      return {
        context: {
          ...captured,
          inputCaptureTiming: {
            captureStartedAtMs,
            capturedAtMs,
            captureDurationMs: performance.now() - captureStartedMono,
            timestampClock: 'LOCAL_RECEIVE_TIME',
            durationClock: 'MONOTONIC',
          },
        },
        snapshot,
      };
    },
    enqueueExactDecision(snapshot, decision) {
      return queue.enqueue({ snapshot, decision });
    },
    close: () => queue.close(),
    observationHealth: () => ({ ...queue.health() }),
  };
}

/** Generic features derived after evaluation, exclusively from the frozen original sources. */
function enrichFromExactInput(
  snapshot: MarketSnapshotV1,
  replay: MicroBurstExactReplay,
  derivedAtReceivedMs: number,
): MarketSnapshotV1 {
  const { context } = replay;
  const book = context.executionBook;
  const flow = context.aggTradeFlow;
  const capability = <T extends { health: SnapshotCapability<T>['health'] }>(
    value: T,
    sourceTimestampMs: number | null,
    sourceTimestampDomain: 'LOCAL_CAPTURE' | 'EVENT_TIME',
  ): SnapshotCapability<T> => ({
    requested: true,
    status: value.health === 'UNAVAILABLE' ? 'UNAVAILABLE' : 'AVAILABLE',
    health: value.health,
    value,
    sourceTimestampMs,
    sourceTimestampDomain,
  });
  const primary = { ...snapshot.primary };
  if (book) {
    const bid = book.bidDepth[0]?.price ?? null;
    const ask = book.askDepth[0]?.price ?? null;
    const valid =
      bid !== null && ask !== null && bid > 0 && ask >= bid && [bid, ask].every(Number.isFinite);
    const health =
      book.status !== 'HEALTHY'
        ? book.status
        : !valid
          ? 'ANOMALOUS'
          : snapshot.capturedAtMs - book.observedAtMs > replay.config.bookFreshnessMaxMs
            ? 'STALE'
            : 'HEALTHY';
    primary.quote = capability(
      calculateQuoteFeaturesV1({
        symbol: context.symbol,
        bid,
        ask,
        mid: valid ? (bid! + ask!) / 2 : null,
        spread: valid ? ask! - bid! : null,
        spreadBps: valid ? ((ask! - bid!) / ((bid! + ask!) / 2)) * 10_000 : null,
        health,
        observedAtMs: book.observedAtMs,
        source: 'SYNCHRONIZED_ORDER_BOOK',
      }),
      book.observedAtMs,
      'LOCAL_CAPTURE',
    );
    primary.orderBookFeatures = capability(
      calculateOrderBookFeaturesV1({
        state: {
          bids: book.bidDepth,
          asks: book.askDepth,
          health,
          observedAtMs: book.observedAtMs,
        },
      }),
      book.observedAtMs,
      'LOCAL_CAPTURE',
    );
  }
  if (flow)
    primary.aggTrade = {
      ...capability(
        calculateAggTradeFeaturesV1({
          ...flow,
          buyVolume: flow.buyTakerVolume,
          sellVolume: flow.sellTakerVolume,
          netTakerVolume: flow.netTakerFlow,
        }),
        flow.eventWatermarkMs,
        'EVENT_TIME',
      ),
      requestedWindowMs: flow.requestedWindowMs,
    };
  return {
    ...snapshot,
    primary,
    health: book || flow ? 'PARTIAL' : 'UNAVAILABLE',
    provenance: {
      ...snapshot.provenance,
      request: {
        symbol: context.symbol,
        quote: !!book,
        orderBookFeatures: !!book,
        aggTrade: flow ? { windowMs: flow.requestedWindowMs } : false,
      },
      derivation: { kind: 'POST_EVALUATION_FROM_EXACT_INPUTS', derivedAtReceivedMs },
    },
  };
}
