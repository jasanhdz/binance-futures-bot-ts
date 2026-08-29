import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { Logger } from '../src/app/ports/Logger';
import { BinanceExchange } from '../src/infra/adapters/BinanceAdapter';
import { createReadOnlyAuditedExchange } from '../src/infra/adapters/ReadOnlyAuditedExchange';
import { SynchronizedOrderBook } from '../src/core/market-data/SynchronizedOrderBook';
import { OrderBookQuoteProvider } from '../src/core/market-data/OrderBookQuoteProvider';
import { RollingAggTradeBuffer } from '../src/core/market-data/RollingAggTradeBuffer';
import { AggTradeDataPlane } from '../src/core/market-data/AggTradeDataPlane';
import { MarketDataCandleProvider } from '../src/core/market-data/MarketDataCandleProvider';
import { ComposedBenchmarkMarketDataPort } from '../src/core/market-data/BenchmarkMarketData';
import {
  MarketDataCapabilityCatalog,
  composeMarketSnapshotRequest,
  defineMarketDataConsumerProfile,
} from '../src/core/market-data/MarketDataCapabilityComposition';
import { MarketSnapshotProvider } from '../src/core/market-data/MarketSnapshotProvider';

const symbols = ['BTCUSDT', 'ETHUSDT'] as const;
const durationSeconds = Number(process.env.PHASE_S_SOAK_SECONDS ?? 600);
const sampleEveryMs = Number(process.env.PHASE_S_SAMPLE_MS ?? 5_000);
const codeSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const startedAt = Date.now();

if (!Number.isFinite(durationSeconds) || durationSeconds < 360) {
  throw new Error('PHASE_S_DURATION_MUST_BE_AT_LEAST_360_SECONDS');
}

const logCounts = { debug: 0, info: 0, warn: 0, error: 0 };
const logger: Logger = {
  debug: (msg, ctx) => { logCounts.debug++; if (process.env.PHASE_S_VERBOSE === '1') console.log(JSON.stringify({ level: 'debug', msg, ctx })); },
  info: (msg, ctx) => { logCounts.info++; console.log(JSON.stringify({ level: 'info', msg, ctx })); },
  warn: (msg, ctx) => { logCounts.warn++; console.warn(JSON.stringify({ level: 'warn', msg, ctx })); },
  error: (msg, ctx) => { logCounts.error++; console.error(JSON.stringify({ level: 'error', msg, ctx })); },
};

const raw = new BinanceExchange(logger);
const audited = createReadOnlyAuditedExchange(raw, codeSha);
const exchange = audited.exchange;
const clock = { now: Date.now };

if (!exchange.getDepthSnapshot || !exchange.subscribeToDepthDiff || !exchange.subscribeToAggTrades) {
  throw new Error('PHASE_S_REQUIRED_PUBLIC_MARKET_DATA_CAPABILITY_MISSING');
}

const books = new Map<string, SynchronizedOrderBook>();
const quotes = new Map<string, OrderBookQuoteProvider>();
const aggGapCounts: Record<string, number> = {};
const aggEventCounts: Record<string, number> = {};

for (const symbol of symbols) {
  const book = new SynchronizedOrderBook(symbol, {
    snapshotSource: { getSnapshot: (s, levels) => exchange.getDepthSnapshot!(s, levels) },
    diffSource: { onDiff: (s, cb) => exchange.subscribeToDepthDiff!(s, '100ms', cb) },
    logger,
    clock,
  });
  books.set(symbol, book);
  quotes.set(symbol, new OrderBookQuoteProvider(symbol, book));
  aggGapCounts[symbol] = 0;
  aggEventCounts[symbol] = 0;
}

const aggPlane = new AggTradeDataPlane(
  (symbol) => new RollingAggTradeBuffer(clock, 50_000, 300_000, () => { aggGapCounts[symbol]++; }),
  {
    subscribe: (symbol, onEvent, onStatus) =>
      exchange.subscribeToAggTrades!(
        symbol,
        (trade) => {
          aggEventCounts[symbol]++;
          onEvent({
            eventTime: trade.eventTime,
            receivedAtMs: trade.receivedAtMs,
            price: Number(trade.price),
            quantity: Number(trade.quantity),
            isBuyerMaker: trade.isBuyerMaker,
            tradeTime: trade.tradeTime,
            aggregateTradeId: trade.aggregateTradeId,
            firstTradeId: trade.firstTradeId,
            lastTradeId: trade.lastTradeId,
          });
        },
        onStatus,
      ),
  },
);

const leases = new Map<string, ReturnType<typeof aggPlane.acquire>>();
for (const symbol of symbols) leases.set(symbol, aggPlane.acquire(symbol));

// Prove two consumers share one canonical AggTrade state/stream.
const secondBtcLease = aggPlane.acquire('BTCUSDT');
const sharedAggTradeIdentity = secondBtcLease.state === leases.get('BTCUSDT')!.state;
const btcReferenceCountDuringProbe = aggPlane.getReferenceCount('BTCUSDT');
secondBtcLease.release();

const candles = new MarketDataCandleProvider(exchange, clock);
const benchmark = new ComposedBenchmarkMarketDataPort({
  candles: () => candles,
  quote: (symbol) => quotes.get(symbol),
  orderBook: (symbol) => books.get(symbol),
});
const catalog = new MarketDataCapabilityCatalog();
for (const symbol of symbols) {
  catalog.registerSymbol(symbol, {
    quote: quotes.get(symbol),
    orderBook: books.get(symbol),
    aggTrade: leases.get(symbol)!.state,
  });
}
catalog.registerShared({ candles, benchmark });
const snapshots = new MarketSnapshotProvider(catalog.asSnapshotSources(), clock);
const profile = defineMarketDataConsumerProfile({
  id: 'PHASE_S_SHARED_MARKET_DATA_SOAK',
  primary: { quote: true, orderBookFeatures: true, aggTrade: true, candles: { interval: '1m', limit: 30 } },
  benchmark: { quote: true, orderBookFeatures: true, candles: { interval: '1m', limit: 30 } },
});

const metrics = {
  snapshots: 0,
  complete: 0,
  partial: 0,
  unavailable: 0,
  causalViolations: 0,
  unavailableCapabilities: 0,
  maxRssBytes: 0,
  minRssBytes: Number.POSITIVE_INFINITY,
  maxHeapUsedBytes: 0,
};

function inspectSnapshot(snapshot: Awaited<ReturnType<MarketSnapshotProvider['capture']>>) {
  metrics.snapshots++;
  if (snapshot.health === 'COMPLETE') metrics.complete++;
  else if (snapshot.health === 'PARTIAL') metrics.partial++;
  else metrics.unavailable++;
  const groups = [snapshot.primary, snapshot.benchmark?.data].filter(Boolean) as any[];
  for (const group of groups) {
    for (const capability of Object.values(group) as any[]) {
      if (!capability || typeof capability !== 'object' || !('status' in capability)) continue;
      if (capability.requested && capability.status === 'UNAVAILABLE') metrics.unavailableCapabilities++;
      if (capability.error === 'SOURCE_OBSERVED_AFTER_CAPTURE_BOUNDARY') metrics.causalViolations++;
    }
  }
}

async function main() {
  for (const book of books.values()) book.start();
  await new Promise((resolve) => setTimeout(resolve, 15_000));

  while (Date.now() - startedAt < durationSeconds * 1_000) {
    for (const symbol of symbols) {
      const request = composeMarketSnapshotRequest(profile, symbol, { id: 'PRIMARY_CRYPTO_BENCHMARK', symbol: 'BTCUSDT' });
      inspectSnapshot(await snapshots.capture(request));
    }
    const memory = process.memoryUsage();
    metrics.maxRssBytes = Math.max(metrics.maxRssBytes, memory.rss);
    metrics.minRssBytes = Math.min(metrics.minRssBytes, memory.rss);
    metrics.maxHeapUsedBytes = Math.max(metrics.maxHeapUsedBytes, memory.heapUsed);
    await new Promise((resolve) => setTimeout(resolve, sampleEveryMs));
  }

  const bookStates = Object.fromEntries(symbols.map((s) => [s, books.get(s)!.getState()]));
  const aggStates = Object.fromEntries(symbols.map((s) => [s, leases.get(s)!.state.getTakerFlow(300_000)]));
  const finalQuotes = Object.fromEntries(symbols.map((s) => [s, quotes.get(s)!.getQuote()]));

  for (const book of books.values()) book.stop();
  for (const lease of leases.values()) lease.release();
  aggPlane.close();
  (raw as any).wsManager?.disconnectAll?.();

  const rssGrowthBytes = metrics.maxRssBytes - metrics.minRssBytes;
  const blockers: string[] = [];
  for (const symbol of symbols) {
    const book = bookStates[symbol];
    const flow = aggStates[symbol];
    if (book.health !== 'HEALTHY') blockers.push(`${symbol}_ORDER_BOOK_${book.health}`);
    if (book.gapCount > 0) blockers.push(`${symbol}_ORDER_BOOK_GAPS_${book.gapCount}`);
    if (book.resyncCount > 0) blockers.push(`${symbol}_ORDER_BOOK_RESYNCS_${book.resyncCount}`);
    if (!flow.windowComplete) blockers.push(`${symbol}_AGGTRADE_WINDOW_INCOMPLETE`);
    if (!flow.gapFree) blockers.push(`${symbol}_AGGTRADE_GAPS`);
    if (flow.tradeCount <= 0) blockers.push(`${symbol}_AGGTRADE_EMPTY`);
    if (finalQuotes[symbol].health !== 'HEALTHY') blockers.push(`${symbol}_QUOTE_${finalQuotes[symbol].health}`);
  }
  if (!sharedAggTradeIdentity || btcReferenceCountDuringProbe !== 2) blockers.push('AGGTRADE_SHARED_STATE_PROBE_FAILED');
  if (audited.audit.totalMutationAttempts !== 0 || audited.audit.forwardedMutationCalls !== 0) blockers.push('EXCHANGE_MUTATION_NONZERO');
  if (audited.audit.readOnlyCalls.authenticated !== 0) blockers.push('AUTHENTICATED_READ_OCCURRED');
  if (metrics.causalViolations !== 0) blockers.push(`CAUSAL_VIOLATIONS_${metrics.causalViolations}`);
  if (metrics.snapshots < 20) blockers.push('INSUFFICIENT_SNAPSHOT_SAMPLES');
  if (rssGrowthBytes > 256 * 1024 * 1024) blockers.push(`RSS_GROWTH_TOO_HIGH_${rssGrowthBytes}`);

  const verdict = blockers.length === 0
    ? 'SHARED_MARKET_DATA_PHASE_S_SOAK_VERIFIED'
    : 'SHARED_MARKET_DATA_PHASE_S_BLOCKED';

  const report = {
    verdict,
    readyForPhaseT: blockers.length === 0,
    codeSha,
    durationSeconds,
    sampleEveryMs,
    symbols,
    startedAtUtc: new Date(startedAt).toISOString(),
    endedAtUtc: new Date().toISOString(),
    sharedAggTradeIdentity,
    btcReferenceCountDuringProbe,
    mutationAudit: audited.audit,
    logs: logCounts,
    snapshots: metrics,
    memory: { rssGrowthBytes, maxRssBytes: metrics.maxRssBytes, maxHeapUsedBytes: metrics.maxHeapUsedBytes },
    orderBook: bookStates,
    aggTrade: aggStates,
    aggGapCounts,
    aggEventCounts,
    quote: finalQuotes,
    blockers,
  };
  writeFileSync('phase-s-soak-report.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (blockers.length) process.exitCode = 1;
}

main().catch((error) => {
  writeFileSync('phase-s-soak-report.json', JSON.stringify({ verdict: 'SHARED_MARKET_DATA_PHASE_S_BLOCKED', readyForPhaseT: false, codeSha, error: String(error) }, null, 2) + '\n');
  console.error(error);
  process.exitCode = 1;
});
