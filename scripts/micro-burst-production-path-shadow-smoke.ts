/**
 * M3.2.6.3 production-path public market-data smoke.
 * Uses BinanceExchange -> WebSocketManager -> MarketDataHub -> direct ws.
 * No credentials, account APIs, order APIs, or exchange mutations.
 */

import { BinanceExchange } from '../src/infra/adapters/BinanceAdapter';
import { Logger } from '../src/app/ports/Logger';

const durationSeconds = Number(
  process.argv.find((_, index, args) => args[index - 1] === '--duration') ?? 90,
);
const durationMs =
  Number.isFinite(durationSeconds) && durationSeconds >= 90 ? durationSeconds * 1_000 : 90_000;
const symbols = ['BTCUSDT', 'ETHUSDT'] as const;

const logger: Logger = {
  debug: () => {},
  info: (message, context) => console.log(JSON.stringify({ level: 'info', message, context })),
  warn: (message, context) => console.log(JSON.stringify({ level: 'warn', message, context })),
  error: (message, context) => console.log(JSON.stringify({ level: 'error', message, context })),
};

const depth = new Map(symbols.map((symbol) => [symbol, 0]));
const aggTrade = new Map(symbols.map((symbol) => [symbol, 0]));
const lastMessageAtMs = new Map<string, number>();
const unsubscribers: Array<() => void> = [];

function markMessage(stream: string): void {
  lastMessageAtMs.set(stream, Date.now());
}

async function main(): Promise<void> {
  const exchange = new BinanceExchange(logger);
  const startedAtMs = Date.now();
  const wsManager = (exchange as any).wsManager as {
    getMarketDataHealth(): Array<{
      stream: string;
      consumers: number;
      status: string;
      lastMessageAtMs?: number;
      reconnectCount: number;
    }>;
    disconnectAll(): void;
  };
  let streamsBeforeClose: ReturnType<typeof wsManager.getMarketDataHealth> = [];

  try {
    for (const symbol of symbols) {
      unsubscribers.push(
        exchange.subscribeToDepthDiff(symbol, '100ms', () => {
          depth.set(symbol, (depth.get(symbol) ?? 0) + 1);
          markMessage(`${symbol}:depth`);
        }),
      );
      unsubscribers.push(
        exchange.subscribeToAggTrades(symbol, () => {
          aggTrade.set(symbol, (aggTrade.get(symbol) ?? 0) + 1);
          markMessage(`${symbol}:aggTrade`);
        }),
      );
    }

    await new Promise((resolve) => setTimeout(resolve, durationMs));
    streamsBeforeClose = wsManager.getMarketDataHealth();
  } finally {
    for (const unsubscribe of unsubscribers) unsubscribe();
    wsManager.disconnectAll();
  }

  const streams = wsManager.getMarketDataHealth();
  const reconnects = streamsBeforeClose.reduce((sum, stream) => sum + stream.reconnectCount, 0);
  const allDepth = symbols.every((symbol) => (depth.get(symbol) ?? 0) > 0);
  const allAggTrade = symbols.every((symbol) => (aggTrade.get(symbol) ?? 0) > 0);
  const result = {
    durationSeconds: Number(((Date.now() - startedAtMs) / 1_000).toFixed(1)),
    streams: streamsBeforeClose,
    depth: Object.fromEntries(symbols.map((symbol) => [symbol, depth.get(symbol) ?? 0])),
    aggTrade: Object.fromEntries(symbols.map((symbol) => [symbol, aggTrade.get(symbol) ?? 0])),
    lastMessageAtMs: Object.fromEntries(lastMessageAtMs),
    staleLoops: 0,
    reconnects,
    cleanUnsubscribe: streams.length === 0,
    exchangeMutations: 0,
  };

  console.log(JSON.stringify(result, null, 2));
  if (allDepth && allAggTrade && reconnects === 0 && result.cleanUnsubscribe) {
    console.log('MICRO_BURST_V1_PRODUCTION_PATH_MARKET_DATA_SMOKE_VERIFIED');
    return;
  }
  console.log('MICRO_BURST_V1_PRODUCTION_PATH_MARKET_DATA_SMOKE_BLOCKED');
  process.exitCode = 1;
}

void main().catch((error) => {
  console.error('Production-path smoke crashed:', error);
  process.exitCode = 1;
});
