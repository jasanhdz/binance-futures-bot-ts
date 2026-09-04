import type { BinanceDepthDiffEvent, BinanceDepthSnapshot } from '../src/app/ports/MarketData';
import type { Logger } from '../src/app/ports/Logger';
import { DepthSnapshotCoordinator } from '../src/core/market-data/DepthSnapshotCoordinator';
import { SynchronizedOrderBook } from '../src/core/market-data/SynchronizedOrderBook';
import { WebSocketManager } from '../src/infra/adapters/WebSocketManager';

const DEFAULT_SYMBOLS = ['ETHUSDT'];
const DEFAULT_DURATION_MS = 15_000;
const REST_URL = 'https://fapi.binance.com/fapi/v1/depth';

type SnapshotTiming = {
  requestedAt: number;
  startedAt?: number;
  completedAt?: number;
  lastUpdateId?: number;
};

const logger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (message, context) => console.error(JSON.stringify({ level: 'warn', message, context })),
  error: (message, context) => console.error(JSON.stringify({ level: 'error', message, context })),
};

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

async function fetchSnapshot(
  symbol: string,
  levels: number,
  timings: Map<string, SnapshotTiming[]>,
): Promise<BinanceDepthSnapshot> {
  const startedAt = Date.now();
  const timing = timings.get(symbol)?.find((item) => item.startedAt === undefined);
  if (timing) timing.startedAt = startedAt;
  const response = await fetch(`${REST_URL}?symbol=${symbol}&limit=${levels}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`depth snapshot HTTP ${response.status}`);
  const raw = (await response.json()) as {
    lastUpdateId: number;
    bids: [string, string][];
    asks: [string, string][];
  };
  const completedAt = Date.now();
  if (timing) {
    timing.completedAt = completedAt;
    timing.lastUpdateId = raw.lastUpdateId;
  }
  return { ...raw, receivedAtMs: completedAt };
}

async function run(symbols: string[], durationMs: number): Promise<void> {
  const startedAt = Date.now();
  const timings = new Map<string, SnapshotTiming[]>();
  const eventCounts = new Map<string, number>();
  const transitions = new Map<string, Array<{ at: number; health: string }>>();
  const firstHealthyAt = new Map<string, number>();
  const books = new Map<string, SynchronizedOrderBook>();

  const coordinator = new DepthSnapshotCoordinator(
    (symbol, levels) => fetchSnapshot(symbol, levels, timings),
    logger,
    {
      jitterMs: 0,
      maxWeightPerMinute: Number(process.env.BINANCE_MAX_REQUEST_WEIGHT_PER_MINUTE ?? 1_200),
    },
  );
  const ws = new WebSocketManager({} as never, logger, { combinedStreams: true, isTestnet: false });

  for (const symbol of symbols) {
    const normalized = symbol.toUpperCase();
    eventCounts.set(normalized, 0);
    transitions.set(normalized, []);
    timings.set(normalized, []);
    const book = new SynchronizedOrderBook(normalized, {
      snapshotSource: {
        getSnapshot: async (requestedSymbol, levels) => {
          timings.get(requestedSymbol)!.push({ requestedAt: Date.now() });
          return coordinator.request(requestedSymbol, levels);
        },
      },
      diffSource: {
        onDiff: (requestedSymbol, callback) =>
          ws.connectDepthDiff(requestedSymbol, '100ms', (event: BinanceDepthDiffEvent) => {
            eventCounts.set(normalized, (eventCounts.get(normalized) ?? 0) + 1);
            callback(event);
          }),
      },
      logger,
      clock: { now: Date.now },
    });
    books.set(normalized, book);
    book.start();
  }

  const poll = setInterval(() => {
    const now = Date.now();
    for (const [symbol, book] of books) {
      const health = book.getHealth();
      const history = transitions.get(symbol)!;
      if (history.at(-1)?.health !== health) history.push({ at: now, health });
      if (health === 'HEALTHY' && !firstHealthyAt.has(symbol)) firstHealthyAt.set(symbol, now);
    }
  }, 25);
  await new Promise((resolve) => setTimeout(resolve, durationMs));
  clearInterval(poll);
  const report = [...books.entries()].map(([symbol, book]) => {
    const snapshotTimings = timings.get(symbol)!;
    const latencies = snapshotTimings
      .filter((item) => item.startedAt !== undefined && item.completedAt !== undefined)
      .map((item) => item.completedAt! - item.startedAt!);
    const waits = snapshotTimings
      .filter((item) => item.startedAt !== undefined)
      .map((item) => item.startedAt! - item.requestedAt);
    const audit = book.getAuditMetrics();
    return {
      symbol,
      wsConnected: (eventCounts.get(symbol) ?? 0) > 0,
      diffEventsPerSec: Number(((eventCounts.get(symbol) ?? 0) / (durationMs / 1_000)).toFixed(2)),
      snapshots: snapshotTimings,
      snapshotLatencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) },
      snapshotWaitMs: { p50: percentile(waits, 0.5), p95: percentile(waits, 0.95) },
      healthTransitions: transitions.get(symbol),
      timeToHealthyMs: firstHealthyAt.has(symbol) ? firstHealthyAt.get(symbol)! - startedAt : null,
      finalState: book.getState(),
      audit,
    };
  });
  for (const book of books.values()) book.stop();
  ws.disconnectAll();
  coordinator.close();
  console.log(
    JSON.stringify(
      {
        version: 'BINANCE_USDM_ORDERBOOK_AUDIT_V1',
        symbols,
        durationMs,
        coordinator: coordinator.getMetrics(),
        symbolsReport: report,
      },
      null,
      2,
    ),
  );
}

const args = process.argv.slice(2);
const symbolsArg = args.find((arg) => arg.startsWith('--symbols='))?.slice('--symbols='.length);
const durationArg = args
  .find((arg) => arg.startsWith('--duration-ms='))
  ?.slice('--duration-ms='.length);
const symbols = (symbolsArg ? symbolsArg.split(',') : DEFAULT_SYMBOLS)
  .map((symbol) => symbol.trim())
  .filter(Boolean);
const durationMs = Number(durationArg ?? DEFAULT_DURATION_MS);

if (!symbols.length || !Number.isFinite(durationMs) || durationMs <= 0) {
  throw new Error(
    'Usage: npx tsx scripts/binance-usdm-orderbook-audit.ts [--symbols=ETHUSDT,BTCUSDT] [--duration-ms=15000]',
  );
}

void run(symbols, durationMs).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
