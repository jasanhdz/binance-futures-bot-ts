import type { SharedMarketDataRuntime } from '../services/SharedMarketDataRuntime';
import type { Candle } from '../../core/types';
import type { RateLimitDetails } from '../../infra/adapters/rate-limit';

export const MARKET_DATA_DIAGNOSTICS_VERSION = 'MARKET_DATA_DIAGNOSTICS_V1' as const;

export interface MarketDataHealthStream {
  readonly stream: string;
  readonly consumers: number;
  readonly status: string;
  readonly lastMessageAtMs?: number;
  readonly reconnectCount: number;
}

export interface MarketDataDiagnosticsOptions {
  readonly symbols: readonly string[];
  readonly now?: number;
  readonly streams?: readonly MarketDataHealthStream[];
  readonly rateLimit?: {
    readonly rateLimitEvents: number;
    readonly cooldownBlockedRequests: number;
    readonly circuitBreakerActivations: number;
    readonly lastStatus?: number;
    readonly banUntil: number;
  };
}

type SafeCandle = Pick<Candle, 'openTime' | 'closeTime'>;

function age(now: number, timestamp: number | undefined): number | undefined {
  return timestamp === undefined || timestamp <= 0 ? undefined : Math.max(0, now - timestamp);
}

function lastClosedCandle(candles: readonly Candle[], now: number): SafeCandle | undefined {
  const closed = candles.filter((candle) => candle.closeTime < now);
  const candle = closed[closed.length - 1];
  return candle ? { openTime: candle.openTime, closeTime: candle.closeTime } : undefined;
}

function streamFor(
  streams: readonly MarketDataHealthStream[],
  symbol: string,
  suffix: string,
): MarketDataHealthStream | undefined {
  return streams.find((stream) => stream.stream === `${symbol.toLowerCase()}${suffix}`);
}

function symbolReason(input: {
  bookHealth: string;
  bookAgeMs?: number;
  aggAgeMs?: number;
  aggCount: number;
  gapFree: boolean;
  candleCount: number;
  candleStatus: string;
  candleSource?: string;
  bookStream?: MarketDataHealthStream;
  aggStream?: MarketDataHealthStream;
}): string | null {
  if (!input.bookStream || !input.aggStream) return 'STREAM_NOT_ACQUIRED';
  if (input.bookHealth === 'UNSYNCED') return 'ORDER_BOOK_BOOTSTRAP_OR_BRIDGE_WAIT';
  if (input.bookHealth === 'UNAVAILABLE') return 'ORDER_BOOK_UNAVAILABLE';
  if (input.bookHealth === 'ANOMALOUS') return 'ORDER_BOOK_ANOMALOUS';
  if (input.bookHealth === 'STALE' || (input.bookAgeMs ?? Infinity) > 10_000)
    return 'ORDER_BOOK_STALE';
  if (!input.gapFree) return 'AGG_TRADE_GAP_OR_CONTINUITY_UNCERTAIN';
  if (input.aggCount === 0) {
    return input.aggStream.status === 'open'
      ? 'MARKET_SILENT_NO_RECENT_AGG_TRADES'
      : 'AGG_TRADE_TRANSPORT_NOT_OPEN';
  }
  if ((input.aggAgeMs ?? Infinity) > 3_000)
    return input.aggStream.status === 'open'
      ? 'LOW_ACTIVITY_OR_STALE_AGG_TRADE'
      : 'AGG_TRADE_TRANSPORT_STALE';
  if (input.candleCount === 0) return 'CANDLES_MISSING';
  if (input.candleCount < 96) return 'CANDLES_INSUFFICIENT_CLOSED_HISTORY';
  if (input.candleStatus !== 'FRESH') return 'CANDLES_STALE';
  if (input.candleSource !== 'WEBSOCKET') return 'CANDLES_WAITING_FOR_WEBSOCKET_OBSERVATION';
  return null;
}

export function buildMarketDataDiagnostics(
  runtime: SharedMarketDataRuntime,
  options: MarketDataDiagnosticsOptions,
): Record<string, unknown> {
  const now = options.now ?? Date.now();
  const streams = options.streams ?? [];
  const rows = options.symbols.map((rawSymbol) => {
    const symbol = rawSymbol.toUpperCase();
    const book = runtime.orderBookDataPlane.get(symbol);
    const bookState = book?.getState();
    const agg = runtime.aggTradeDataPlane.get(symbol);
    const recentTrades = agg?.getRecent(5_000) ?? [];
    const flow = agg?.getTakerFlow(5_000);
    const candles = runtime.candleDataPlane.read(symbol, '5m', 320);
    const lastTradeAtMs =
      recentTrades[recentTrades.length - 1]?.receivedAtMs ?? flow?.eventWatermarkMs ?? undefined;
    const bookStream = streamFor(streams, symbol, '@depth@100ms');
    const aggStream = streamFor(streams, symbol, '@aggTrade');
    const lastClosed = lastClosedCandle(candles.candles, now);
    const reason = symbolReason({
      bookHealth: bookState?.health ?? 'UNAVAILABLE',
      bookAgeMs: age(now, bookState?.observedAtMs),
      aggAgeMs: age(now, lastTradeAtMs),
      aggCount: flow?.tradeCount ?? 0,
      gapFree: flow?.gapFree ?? false,
      candleCount: candles.candles.filter((candle) => candle.closeTime < now).length,
      candleStatus: candles.status,
      candleSource: candles.source,
      bookStream,
      aggStream,
    });
    const candleCount = candles.candles.filter((candle) => candle.closeTime < now).length;
    const fresh = reason === null;
    return {
      symbol,
      status: fresh ? 'FRESH' : 'NOT_FRESH',
      orderBook: {
        health: bookState?.health ?? 'UNAVAILABLE',
        lastUpdateId: bookState?.lastUpdateId ?? 0,
        lastUpdateAgeMs: age(now, bookState?.observedAtMs),
        lastDiffAgeMs: age(now, bookState?.lastDiffAtMs),
        gapCount: bookState?.gapCount ?? 0,
        resyncCount: bookState?.resyncCount ?? 0,
      },
      aggTrades: {
        lastTradeAgeMs: age(now, lastTradeAtMs),
        gapFree: flow?.gapFree ?? false,
        tradeCount: flow?.tradeCount ?? 0,
        windowComplete: flow?.windowComplete ?? false,
      },
      candles: {
        interval: '5m',
        lastClosedCandle: lastClosed,
        closedCount: candleCount,
        status: candles.status,
        source: candles.source,
        observedAgeMs: age(now, candles.observedAtMs),
        restFallbackCount: candles.restFallbackCount,
      },
      streams: {
        orderBook: bookStream
          ? {
              status: bookStream.status,
              reconnectCount: bookStream.reconnectCount,
              lastMessageAgeMs: age(now, bookStream.lastMessageAtMs),
            }
          : null,
        aggTrades: aggStream
          ? {
              status: aggStream.status,
              reconnectCount: aggStream.reconnectCount,
              lastMessageAgeMs: age(now, aggStream.lastMessageAtMs),
            }
          : null,
      },
      timestamp: {
        commonClosedCandleMs: lastClosed?.closeTime ?? null,
        aligned: true,
      },
      reason,
      recentErrors: [],
    };
  });
  const allClosed = rows
    .map((row) => (row.candles as { lastClosedCandle?: SafeCandle }).lastClosedCandle?.closeTime)
    .filter((value): value is number => value !== undefined);
  const commonTimestamp =
    allClosed.length === rows.length && new Set(allClosed).size === 1 ? allClosed[0] : null;
  const normalizedRows = rows.map((row) => ({
    ...row,
    timestamp: {
      ...(row.timestamp as Record<string, unknown>),
      commonClosedCandleMs: commonTimestamp,
      aligned: commonTimestamp !== null,
    },
  }));
  const healthy = normalizedRows.filter((row) => row.status === 'FRESH').length;
  const routeStreams = streams.filter((stream) => stream.consumers > 0);
  const reconnects = routeStreams.reduce((sum, stream) => sum + stream.reconnectCount, 0);
  const rateLimit = options.rateLimit ?? {
    rateLimitEvents: 0,
    cooldownBlockedRequests: 0,
    circuitBreakerActivations: 0,
    banUntil: 0,
  };
  return {
    version: MARKET_DATA_DIAGNOSTICS_VERSION,
    timestamp: new Date(now).toISOString(),
    symbols: normalizedRows,
    summary: {
      symbolCount: rows.length,
      healthySymbols: healthy,
      unhealthySymbols: rows.length - healthy,
      expectedStreams: rows.length * 3,
      activeStreams: routeStreams.length,
      reconnects,
      commonClosedCandleMs: commonTimestamp,
      candlesAligned: commonTimestamp !== null,
      watchdog: { status: routeStreams.length > 0 ? 'ACTIVE' : 'NO_ACTIVE_STREAMS' },
      recoveryLatencyMs: null,
      restFallbackCount: rows.reduce(
        (sum, row) => sum + (row.candles as { restFallbackCount: number }).restFallbackCount,
        0,
      ),
      rateLimit,
    },
  };
}

export function safeRateLimitDetails(
  details: RateLimitDetails | undefined,
): Record<string, unknown> {
  return details ? { status: details.status, retryAfterMs: details.retryAfterMs } : {};
}
