import { describe, expect, it, vi } from 'vitest';
import { buildMarketDataDiagnostics } from './MarketDataDiagnostics';

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
];

function runtimeFor(symbolsToUse = symbols) {
  const now = 1_700_000_000_000;
  const candle = {
    openTime: now - 300_000,
    closeTime: now - 1,
    open: 1,
    high: 1,
    low: 1,
    close: 1,
    volume: 1,
    buyVolume: 1,
  };
  const getState = vi.fn(() => ({
    bids: [{ price: 1, qty: 1 }],
    asks: [{ price: 1.1, qty: 1 }],
    lastUpdateId: 42,
    health: 'HEALTHY',
    observedAtMs: now - 100,
    lastSyncAtMs: now - 1_000,
    lastDiffAtMs: now - 100,
    gapCount: 0,
    resyncCount: 0,
  }));
  const flow = vi.fn(() => ({
    tradeCount: 2,
    eventWatermarkMs: now - 100,
    gapFree: true,
    windowComplete: true,
  }));
  const runtime = {
    orderBookDataPlane: {
      get: (symbol: string) =>
        symbolsToUse.includes(symbol)
          ? {
              getState,
              getHealth: vi.fn(() => {
                throw new Error('must not call getHealth');
              }),
            }
          : undefined,
    },
    aggTradeDataPlane: {
      get: (symbol: string) =>
        symbolsToUse.includes(symbol)
          ? { getRecent: () => [{ receivedAtMs: now - 100 }], getTakerFlow: flow }
          : undefined,
    },
    candleDataPlane: {
      read: (symbol: string) =>
        symbolsToUse.includes(symbol)
          ? {
              symbol,
              interval: '5m',
              candles: Array.from({ length: 96 }, (_, index) => ({
                ...candle,
                openTime: candle.openTime - index * 300_000,
                closeTime: candle.closeTime - index * 300_000,
              })),
              source: 'WEBSOCKET',
              status: 'FRESH',
              observedAtMs: now - 100,
              restFallbackCount: 0,
            }
          : { symbol, interval: '5m', candles: [], status: 'NO_DATA', restFallbackCount: 0 },
    },
  };
  return { runtime: runtime as any, now, getState, flow };
}

const streams = symbols.flatMap((symbol) => [
  {
    stream: `${symbol.toLowerCase()}@depth@100ms`,
    consumers: 1,
    status: 'open',
    lastMessageAtMs: 1_699_999_999_900,
    reconnectCount: 0,
  },
  {
    stream: `${symbol.toLowerCase()}@aggTrade`,
    consumers: 1,
    status: 'open',
    lastMessageAtMs: 1_699_999_999_900,
    reconnectCount: 0,
  },
]);

describe('buildMarketDataDiagnostics', () => {
  it('reports all canonical symbols without invoking mutating health paths', () => {
    const { runtime, getState, flow } = runtimeFor();
    const result = buildMarketDataDiagnostics(runtime, {
      symbols,
      now: 1_700_000_000_000,
      streams,
    });
    const rows = result.symbols as Array<Record<string, any>>;

    expect(rows).toHaveLength(11);
    expect(rows.every((row) => row.status === 'FRESH')).toBe(true);
    expect(getState).toHaveBeenCalledTimes(11);
    expect(flow).toHaveBeenCalledTimes(11);
  });

  it('distinguishes a silent open market from missing transport', () => {
    const { runtime } = runtimeFor();
    const silentRuntime = {
      ...runtime,
      aggTradeDataPlane: {
        get: () => ({
          getRecent: () => [],
          getTakerFlow: () => ({
            tradeCount: 0,
            eventWatermarkMs: null,
            gapFree: true,
            windowComplete: false,
          }),
        }),
      },
    } as any;
    const result = buildMarketDataDiagnostics(silentRuntime, {
      symbols: ['BTCUSDT'],
      now: 1_700_000_000_000,
      streams,
    });
    const row = (result.symbols as Array<Record<string, any>>)[0];

    expect(row.status).toBe('NOT_FRESH');
    expect(row.reason).toBe('MARKET_SILENT_NO_RECENT_AGG_TRADES');
    expect((result.summary as Record<string, any>).unhealthySymbols).toBe(1);
  });

  it('reports an unacquired symbol clearly without REST or Binance calls', () => {
    const { runtime } = runtimeFor([]);
    const result = buildMarketDataDiagnostics(runtime, {
      symbols: ['LTCUSDT'],
      now: 1_700_000_000_000,
    });
    const row = (result.symbols as Array<Record<string, any>>)[0];

    expect(row.reason).toBe('STREAM_NOT_ACQUIRED');
    expect(row.candles.closedCount).toBe(0);
    expect((result.summary as Record<string, any>).restFallbackCount).toBe(0);
  });
});
