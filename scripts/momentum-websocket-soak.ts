import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import type { Logger } from '../src/app/ports/Logger';
import { BinanceExchange } from '../src/infra/adapters/BinanceAdapter';
import { createReadOnlyAuditedExchange } from '../src/infra/adapters/ReadOnlyAuditedExchange';
import { SharedMarketDataRuntime } from '../src/app/services/SharedMarketDataRuntime';
import { MomentumRealtimeMarketState } from '../src/strategies/momentum/application/MomentumRealtimeMarketState';
import { MomentumCandleState } from '../src/strategies/momentum/application/MomentumCandleState';

const symbols = ['BTCUSDT', 'ETHUSDT'] as const;
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
    if (process.env.MOMENTUM_WS_VERBOSE === '1') console.log(JSON.stringify({ level: 'debug', message, context }));
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
  maxRealtimeAgeMs: number;
  maxAggTradeAgeMs: number;
  postChaosFreshAtMs?: number;
};

const perSymbol: Record<string, SymbolMetrics> = Object.fromEntries(
  symbols.map((symbol) => [symbol, {
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
    maxRealtimeAgeMs: 0,
    maxAggTradeAgeMs: 0,
  }]),
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
      chaosTriggeredAtMs = Date.now();
      console.log(JSON.stringify({ event: 'CONTROLLED_WS_RECONNECT', at: new Date(chaosTriggeredAtMs).toISOString() }));
      raw.simulateChaos(5_000);
    }

    for (const symbol of symbols) {
      const metric = perSymbol[symbol];
      const candle = await candles.read(symbol, 300);
      const market = realtime.read(symbol);
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
      metric.maxRealtimeAgeMs = Math.max(metric.maxRealtimeAgeMs, market.ageMs ?? 0);
      metric.maxAggTradeAgeMs = Math.max(metric.maxAggTradeAgeMs, market.aggTradeAgeMs ?? 0);

      if (
        chaosTriggeredAtMs &&
        metric.postChaosFreshAtMs === undefined &&
        Date.now() > chaosTriggeredAtMs &&
        candle.status === 'FRESH' &&
        candle.source === 'WEBSOCKET' &&
        market.status === 'FRESH'
      ) {
        metric.postChaosFreshAtMs = Date.now();
      }
    }

    const memory = process.memoryUsage().rss;
    rssMin = Math.min(rssMin, memory);
    rssMax = Math.max(rssMax, memory);
    await new Promise((resolve) => setTimeout(resolve, sampleMs));
  }

  const finalCandleRefs = Object.fromEntries(symbols.map((s) => [s, shared.candleDataPlane.getReferenceCount(s, '5m')]));
  const finalBookRefs = Object.fromEntries(symbols.map((s) => [s, shared.orderBookDataPlane.getReferenceCount(s)]));
  const finalAggRefs = Object.fromEntries(symbols.map((s) => [s, shared.aggTradeDataPlane.getReferenceCount(s)]));

  candles.close();
  realtime.close();
  shared.close();
  (raw as any).wsManager?.disconnectAll?.();

  const blockers: string[] = [];
  for (const symbol of symbols) {
    const m = perSymbol[symbol];
    if (m.samples < 100) blockers.push(`${symbol}_INSUFFICIENT_SAMPLES_${m.samples}`);
    if (pct(m.candleFresh, m.samples) < 0.95) blockers.push(`${symbol}_CANDLE_FRESH_RATE_${pct(m.candleFresh, m.samples).toFixed(3)}`);
    if (m.candleWebsocketSource === 0) blockers.push(`${symbol}_NO_WEBSOCKET_CANDLE_SOURCE`);
    if (pct(m.realtimeFresh, m.samples) < 0.90) blockers.push(`${symbol}_REALTIME_FRESH_RATE_${pct(m.realtimeFresh, m.samples).toFixed(3)}`);
    if (m.candleFallbackReads > 3) blockers.push(`${symbol}_EXCESSIVE_REST_RECOVERY_${m.candleFallbackReads}`);
    if (!m.postChaosFreshAtMs) blockers.push(`${symbol}_DID_NOT_RECOVER_AFTER_RECONNECT`);
    else if (chaosTriggeredAtMs && m.postChaosFreshAtMs - chaosTriggeredAtMs > 45_000) {
      blockers.push(`${symbol}_RECONNECT_RECOVERY_TOO_SLOW_${m.postChaosFreshAtMs - chaosTriggeredAtMs}`);
    }
  }
  if (!chaosTriggeredAtMs) blockers.push('CONTROLLED_RECONNECT_NOT_TRIGGERED');
  if (audited.audit.totalMutationAttempts !== 0 || audited.audit.forwardedMutationCalls !== 0) blockers.push('EXCHANGE_MUTATION_NONZERO');
  if (audited.audit.readOnlyCalls.authenticated !== 0) blockers.push('AUTHENTICATED_READ_OCCURRED');
  const rssGrowthBytes = rssMax - rssMin;
  if (rssGrowthBytes > 256 * 1024 * 1024) blockers.push(`RSS_GROWTH_TOO_HIGH_${rssGrowthBytes}`);

  const report = {
    verdict: blockers.length === 0 ? 'MOMENTUM_WEBSOCKET_SOAK_VERIFIED' : 'MOMENTUM_WEBSOCKET_SOAK_BLOCKED',
    readyForAegisWebsocketMigration: blockers.length === 0,
    codeSha,
    durationSeconds,
    sampleMs,
    chaosAtSeconds,
    startedAtUtc: new Date(startedAt).toISOString(),
    endedAtUtc: new Date().toISOString(),
    mutationAudit: audited.audit,
    logs,
    perSymbol,
    referenceCountsBeforeClose: {
      candles: finalCandleRefs,
      orderBook: finalBookRefs,
      aggTrades: finalAggRefs,
    },
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
    error: error instanceof Error ? error.stack ?? error.message : String(error),
  };
  writeFileSync('momentum-websocket-soak-report.json', JSON.stringify(report, null, 2) + '\n');
  console.error(error);
  process.exitCode = 1;
});
