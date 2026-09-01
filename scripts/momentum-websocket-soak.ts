import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import type { Logger } from '../src/app/ports/Logger';
import { BinanceExchange } from '../src/infra/adapters/BinanceAdapter';
import { createReadOnlyAuditedExchange } from '../src/infra/adapters/ReadOnlyAuditedExchange';
import { SharedMarketDataRuntime } from '../src/app/services/SharedMarketDataRuntime';
import { MomentumRealtimeMarketState } from '../src/strategies/momentum/application/MomentumRealtimeMarketState';
import { MomentumCandleState } from '../src/strategies/momentum/application/MomentumCandleState';
import { getRateLimitMetrics } from '../src/infra/adapters/rate-limit';

const symbols = [
  'BTCUSDT',
  'ETHUSDT',
  'SOLUSDT',
  'BNBUSDT',
  'XRPUSDT',
  'DOGEUSDT',
  'ADAUSDT',
  'AVAXUSDT',
  'LINKUSDT',
  'SUIUSDT',
  'LTCUSDT',
] as const;
const durationSeconds = Number(process.env.MOMENTUM_WS_SOAK_SECONDS ?? 420);
const sampleMs = Number(process.env.MOMENTUM_WS_SAMPLE_MS ?? 2_000);
const chaosAtSeconds = Number(process.env.MOMENTUM_WS_CHAOS_AT_SECONDS ?? 180);
const codeSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const startedAt = Date.now();

if (!Number.isFinite(durationSeconds) || durationSeconds < 360) {
  throw new Error('MOMENTUM_WS_SOAK_MUST_BE_AT_LEAST_360_SECONDS');
}

const logs = { debug: 0, info: 0, warn: 0, error: 0 };
const logger: Logger = {
  debug: (message, context) => {
    logs.debug++;
    if (process.env.MOMENTUM_WS_VERBOSE === '1')
      console.log(JSON.stringify({ level: 'debug', message, context }));
  },
  info: (message, context) => {
    logs.info++;
    console.log(JSON.stringify({ level: 'info', message, context }));
  },
  warn: (message, context) => {
    logs.warn++;
    console.warn(JSON.stringify({ level: 'warn', message, context }));
  },
  error: (message, context) => {
    logs.error++;
    console.error(JSON.stringify({ level: 'error', message, context }));
  },
};

type SymbolMetrics = {
  samples: number;
  candleFresh: number;
  candleStale: number;
  candleNoData: number;
  candleWebsocketSource: number;
  candleRestWarmupSource: number;
  candleRestRecoverySource: number;
  candleFallbackReads: number;
  maxCandleAgeMs: number;
  realtimeFresh: number;
  realtimeStale: number;
  realtimeNoData: number;
  orderBookHealthy: number;
  aggTradeGapFree: number;
  maxRealtimeAgeMs: number;
  maxAggTradeAgeMs: number;
  maxGapCount: number;
  maxResyncCount: number;
  postChaosTransportRecoveredAtMs?: number;
  postChaosStrategyFreshAtMs?: number;
};

const perSymbol: Record<string, SymbolMetrics> = Object.fromEntries(
  symbols.map((symbol) => [
    symbol,
    {
      samples: 0,
      candleFresh: 0,
      candleStale: 0,
      candleNoData: 0,
      candleWebsocketSource: 0,
      candleRestWarmupSource: 0,
      candleRestRecoverySource: 0,
      candleFallbackReads: 0,
      maxCandleAgeMs: 0,
      realtimeFresh: 0,
      realtimeStale: 0,
      realtimeNoData: 0,
      orderBookHealthy: 0,
      aggTradeGapFree: 0,
      maxRealtimeAgeMs: 0,
      maxAggTradeAgeMs: 0,
      maxGapCount: 0,
      maxResyncCount: 0,
    },
  ]),
);

const raw = new BinanceExchange(logger);
const audited = createReadOnlyAuditedExchange(raw, codeSha);
const shared = new SharedMarketDataRuntime({
  exchange: audited.exchange,
  logger,
  clock: { now: () => Date.now() },
});
const realtime = new MomentumRealtimeMarketState({
  sharedMarketData: shared,
  clock: { now: () => Date.now() },
});
const candles = new MomentumCandleState(shared, '5m', 320);

let chaosTriggeredAtMs: number | undefined;
const preChaosBookCounters = new Map<string, { gapCount: number; resyncCount: number }>();
let rssMin = Number.POSITIVE_INFINITY;
let rssMax = 0;

function pct(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

async function main(): Promise<void> {
  realtime.start(symbols);
  candles.start(symbols);

  // Warm history and give live streams time to become healthy before scoring.
  for (const symbol of symbols) await candles.read(symbol, 300);
  await new Promise((resolve) => setTimeout(resolve, 15_000));

  while (Date.now() - startedAt < durationSeconds * 1_000) {
    const elapsedMs = Date.now() - startedAt;
    if (!chaosTriggeredAtMs && elapsedMs >= chaosAtSeconds * 1_000) {
      for (const symbol of symbols) {
        const state = shared.orderBookDataPlane.get(symbol)?.getState();
        if (state) {
          preChaosBookCounters.set(symbol, {
            gapCount: state.gapCount,
            resyncCount: state.resyncCount,
          });
        }
      }
      chaosTriggeredAtMs = Date.now();
      console.log(
        JSON.stringify({
          event: 'CONTROLLED_WS_RECONNECT',
          at: new Date(chaosTriggeredAtMs).toISOString(),
        }),
      );
      raw.simulateChaos(5_000);
    }

    for (const symbol of symbols) {
      const metric = perSymbol[symbol];
      const candle = await candles.read(symbol, 300);
      const market = realtime.read(symbol);
      const bookState = shared.orderBookDataPlane.get(symbol)?.getState();
      metric.samples++;

      if (candle.status === 'FRESH') metric.candleFresh++;
      else if (candle.status === 'STALE') metric.candleStale++;
      else metric.candleNoData++;
      if (candle.source === 'WEBSOCKET') metric.candleWebsocketSource++;
      else if (candle.source === 'REST_WARMUP') metric.candleRestWarmupSource++;
      else if (candle.source === 'REST_RECOVERY') metric.candleRestRecoverySource++;
      if (candle.usedRestFallback) metric.candleFallbackReads++;
      metric.maxCandleAgeMs = Math.max(metric.maxCandleAgeMs, candle.ageMs ?? 0);

      if (market.status === 'FRESH') metric.realtimeFresh++;
      else if (market.status === 'STALE') metric.realtimeStale++;
      else metric.realtimeNoData++;
      if (market.orderBookHealth === 'HEALTHY') metric.orderBookHealthy++;
      if (market.aggTradeGapFree) metric.aggTradeGapFree++;
      metric.maxRealtimeAgeMs = Math.max(metric.maxRealtimeAgeMs, market.ageMs ?? 0);
      metric.maxAggTradeAgeMs = Math.max(metric.maxAggTradeAgeMs, market.aggTradeAgeMs ?? 0);
      metric.maxGapCount = Math.max(metric.maxGapCount, bookState?.gapCount ?? 0);
      metric.maxResyncCount = Math.max(metric.maxResyncCount, bookState?.resyncCount ?? 0);

      if (
        chaosTriggeredAtMs &&
        metric.postChaosTransportRecoveredAtMs === undefined &&
        Date.now() > chaosTriggeredAtMs &&
        candle.status === 'FRESH' &&
        candle.source === 'WEBSOCKET' &&
        market.orderBookHealth === 'HEALTHY' &&
        market.aggTradeGapFree
      ) {
        metric.postChaosTransportRecoveredAtMs = Date.now();
      }
      if (
        chaosTriggeredAtMs &&
        metric.postChaosStrategyFreshAtMs === undefined &&
        Date.now() > chaosTriggeredAtMs &&
        candle.status === 'FRESH' &&
        candle.source === 'WEBSOCKET' &&
        market.status === 'FRESH'
      ) {
        metric.postChaosStrategyFreshAtMs = Date.now();
      }
    }

    const memory = process.memoryUsage().rss;
    rssMin = Math.min(rssMin, memory);
    rssMax = Math.max(rssMax, memory);
    await new Promise((resolve) => setTimeout(resolve, sampleMs));
  }

  const finalCandleRefs = Object.fromEntries(
    symbols.map((s) => [s, shared.candleDataPlane.getReferenceCount(s, '5m')]),
  );
  const finalBookRefs = Object.fromEntries(
    symbols.map((s) => [s, shared.orderBookDataPlane.getReferenceCount(s)]),
  );
  const finalAggRefs = Object.fromEntries(
    symbols.map((s) => [s, shared.aggTradeDataPlane.getReferenceCount(s)]),
  );
  const finalBookStates = Object.fromEntries(
    symbols.map((symbol) => {
      const state = shared.orderBookDataPlane.get(symbol)?.getState();
      return [
        symbol,
        state
          ? {
              health: state.health,
              observedAtMs: state.observedAtMs,
              lastDiffAtMs: state.lastDiffAtMs,
              gapCount: state.gapCount,
              resyncCount: state.resyncCount,
            }
          : null,
      ];
    }),
  );
  const finalRealtimeStates = Object.fromEntries(
    symbols.map((symbol) => [symbol, realtime.read(symbol)]),
  );
  const finalStreamHealth = ((raw as any).wsManager?.getMarketDataHealth?.() ?? []) as Array<{
    stream: string;
    consumers: number;
    status: 'connecting' | 'open' | 'reconnecting';
    lastMessageAtMs?: number;
    reconnectCount: number;
  }>;
  const requestMetrics = raw.getRequestMetrics();
  const rateLimitMetrics = getRateLimitMetrics();
  const depthSnapshotMetrics = shared.getDepthSnapshotMetrics();

  candles.close();
  realtime.close();
  shared.close();
  (raw as any).wsManager?.disconnectAll?.();
  const referenceCountsAfterClose = {
    candles: Object.fromEntries(
      symbols.map((s) => [s, shared.candleDataPlane.getReferenceCount(s, '5m')]),
    ),
    orderBook: Object.fromEntries(
      symbols.map((s) => [s, shared.orderBookDataPlane.getReferenceCount(s)]),
    ),
    aggTrades: Object.fromEntries(
      symbols.map((s) => [s, shared.aggTradeDataPlane.getReferenceCount(s)]),
    ),
  };

  const blockers: string[] = [];
  for (const symbol of symbols) {
    const m = perSymbol[symbol];
    if (m.samples < 100) blockers.push(`${symbol}_INSUFFICIENT_SAMPLES_${m.samples}`);
    if (pct(m.candleFresh, m.samples) < 0.95)
      blockers.push(`${symbol}_CANDLE_FRESH_RATE_${pct(m.candleFresh, m.samples).toFixed(3)}`);
    if (m.candleWebsocketSource === 0) blockers.push(`${symbol}_NO_WEBSOCKET_CANDLE_SOURCE`);
    if (!m.postChaosTransportRecoveredAtMs)
      blockers.push(`${symbol}_TRANSPORT_DID_NOT_RECOVER_AFTER_RECONNECT`);
    else if (
      chaosTriggeredAtMs &&
      m.postChaosTransportRecoveredAtMs - chaosTriggeredAtMs > 45_000
    ) {
      blockers.push(
        `${symbol}_TRANSPORT_RECOVERY_TOO_SLOW_${m.postChaosTransportRecoveredAtMs - chaosTriggeredAtMs}`,
      );
    }
    const finalBook = finalBookStates[symbol];
    const beforeChaos = preChaosBookCounters.get(symbol);
    if (!finalBook || !beforeChaos) blockers.push(`${symbol}_MISSING_BOOK_RECOVERY_EVIDENCE`);
    else {
      const gapDelta = finalBook.gapCount - beforeChaos.gapCount;
      const resyncDelta = finalBook.resyncCount - beforeChaos.resyncCount;
      if (gapDelta > 1) blockers.push(`${symbol}_REPEATED_POST_CHAOS_GAPS_${gapDelta}`);
      if (resyncDelta > 1) blockers.push(`${symbol}_REPEATED_POST_CHAOS_RESYNCS_${resyncDelta}`);
    }
  }
  const expectedStreams = symbols.flatMap((symbol) => {
    const normalized = symbol.toLowerCase();
    return [`${normalized}@depth@100ms`, `${normalized}@aggTrade`, `${normalized}@kline_5m`];
  });
  const healthByStream = new Map(finalStreamHealth.map((health) => [health.stream, health]));
  if (healthByStream.size !== finalStreamHealth.length)
    blockers.push('DUPLICATE_COMBINED_STREAM_HEALTH');
  for (const stream of expectedStreams) {
    const health = healthByStream.get(stream);
    if (!health) blockers.push(`MISSING_STREAM_${stream}`);
    else {
      if (health.status !== 'open') blockers.push(`STREAM_NOT_OPEN_${stream}_${health.status}`);
      if (health.reconnectCount > 1)
        blockers.push(`UNEXPECTED_STREAM_RECONNECTS_${stream}_${health.reconnectCount}`);
    }
  }
  if (!chaosTriggeredAtMs) blockers.push('CONTROLLED_RECONNECT_NOT_TRIGGERED');
  if (audited.audit.totalMutationAttempts !== 0 || audited.audit.forwardedMutationCalls !== 0)
    blockers.push('EXCHANGE_MUTATION_NONZERO');
  if (audited.audit.readOnlyCalls.authenticated !== 0) blockers.push('AUTHENTICATED_READ_OCCURRED');
  if (logs.error !== 0) blockers.push(`MARKET_DATA_ERROR_LOGS_${logs.error}`);
  if (rateLimitMetrics.rateLimitEvents !== 0)
    blockers.push(`RATE_LIMIT_EVENTS_${rateLimitMetrics.rateLimitEvents}`);
  if (rateLimitMetrics.circuitBreakerActivations !== 0)
    blockers.push(`RATE_LIMIT_CIRCUIT_BREAKERS_${rateLimitMetrics.circuitBreakerActivations}`);
  if (depthSnapshotMetrics.failures !== 0)
    blockers.push(`DEPTH_SNAPSHOT_FAILURES_${depthSnapshotMetrics.failures}`);
  if (depthSnapshotMetrics.circuitBreakerActivations !== 0)
    blockers.push(`DEPTH_CIRCUIT_BREAKERS_${depthSnapshotMetrics.circuitBreakerActivations}`);
  if (depthSnapshotMetrics.requestsExecutedDuringBan !== 0)
    blockers.push(`DEPTH_REQUESTS_DURING_BAN_${depthSnapshotMetrics.requestsExecutedDuringBan}`);
  if (
    Object.values(referenceCountsAfterClose).some((counts) =>
      Object.values(counts).some((count) => count !== 0),
    )
  ) {
    blockers.push('MARKET_DATA_REFERENCES_NOT_RELEASED');
  }
  const rssGrowthBytes = rssMax - rssMin;
  if (rssGrowthBytes > 256 * 1024 * 1024) blockers.push(`RSS_GROWTH_TOO_HIGH_${rssGrowthBytes}`);

  const report = {
    verdict:
      blockers.length === 0
        ? 'MOMENTUM_WEBSOCKET_SOAK_VERIFIED'
        : 'MOMENTUM_WEBSOCKET_SOAK_BLOCKED',
    readyForAegisWebsocketMigration: blockers.length === 0,
    codeSha,
    durationSeconds,
    sampleMs,
    chaosAtSeconds,
    startedAtUtc: new Date(startedAt).toISOString(),
    endedAtUtc: new Date().toISOString(),
    mutationAudit: audited.audit,
    acceptanceBasis: {
      transportFreshnessSeparatedFromMarketActivity: true,
      strategyRealtimeFreshnessRetainedAsDiagnostic: true,
      postChaosTransportGate:
        'WEBSOCKET candle fresh + order book healthy + aggTrade continuity gap-free',
    },
    logs,
    perSymbol,
    finalBookStates,
    finalRealtimeStates,
    finalStreamHealth,
    requestMetrics,
    rateLimitMetrics,
    depthSnapshotMetrics,
    referenceCountsBeforeClose: {
      candles: finalCandleRefs,
      orderBook: finalBookRefs,
      aggTrades: finalAggRefs,
    },
    referenceCountsAfterClose,
    memory: { rssGrowthBytes, rssMin, rssMax },
    blockers,
  };

  writeFileSync('momentum-websocket-soak-report.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (blockers.length) process.exitCode = 1;
}

main().catch((error) => {
  const report = {
    verdict: 'MOMENTUM_WEBSOCKET_SOAK_BLOCKED',
    readyForAegisWebsocketMigration: false,
    codeSha,
    error: error instanceof Error ? (error.stack ?? error.message) : String(error),
  };
  writeFileSync('momentum-websocket-soak-report.json', JSON.stringify(report, null, 2) + '\n');
  console.error(error);
  process.exitCode = 1;
});
