import type { Logger } from '../../../app/ports/Logger';
import type {
  FeedHealth,
  ScoutSymbol,
  SuiSrScoutConfig,
  SymbolHealth,
  WarmupStatus,
} from '../domain/ScoutTypes';
import type { BuiltCandle } from './ThreeMinuteCandleBuilder';
import type { ScoutMarketDataSource } from './BinanceScoutMarketDataSource';

export class RingBuffer<T> {
  private readonly values: T[] = [];

  constructor(private readonly capacity: number) {}

  push(item: T): void {
    this.values.push(item);
    if (this.values.length > this.capacity)
      this.values.splice(0, this.values.length - this.capacity);
  }

  items(): T[] {
    return [...this.values];
  }

  last(): T | undefined {
    return this.values[this.values.length - 1];
  }

  length(): number {
    return this.values.length;
  }

  clear(): void {
    this.values.length = 0;
  }
}

export interface RawCandleEvent {
  readonly symbol: string;
  readonly interval: string;
  readonly openTime: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly closeTime: number;
  readonly isClosed: boolean;
  readonly exchangeTime: number;
  readonly receivedAtMs: number;
}

export interface RawAggTradeEvent {
  readonly symbol: string;
  readonly price: number;
  readonly quantity: number;
  readonly isBuyerMaker: boolean;
  readonly tradeTime: number;
  readonly receivedAtMs: number;
  readonly aggregateTradeId: number;
}

export interface RawDepthEvent {
  readonly symbol: string;
  readonly bids: ReadonlyArray<readonly [number, number]>;
  readonly asks: ReadonlyArray<readonly [number, number]>;
  readonly firstUpdateId: number;
  readonly previousUpdateId: number;
  readonly lastUpdateId: number;
  readonly eventTime: number;
  readonly receivedAtMs: number;
}

export interface MarketDataCallbacks {
  onCandle?: (event: RawCandleEvent) => void;
  onAggTrade?: (event: RawAggTradeEvent) => void;
  onDepth?: (event: RawDepthEvent) => void;
  onStreamStatus?: (
    symbol: string,
    stream: string,
    status: 'connecting' | 'open' | 'reconnecting',
  ) => void;
}

export interface ScoutFuturesContext {
  readonly markPrice: number | null;
  readonly markPriceObservedAtMs: number | null;
  readonly fundingRate: number | null;
  readonly fundingObservedAtMs: number | null;
  readonly unavailable: readonly string[];
}

export interface SymbolState {
  readonly candles1m: RingBuffer<BuiltCandle>;
  readonly candles3m: RingBuffer<BuiltCandle>;
  readonly aggTrades: RingBuffer<RawAggTradeEvent>;
  readonly depth: RingBuffer<RawDepthEvent>;
  lastEventAtMs: number;
  lastCandleExchangeTime: number;
  lastAggTradeTime: number;
  lastDepthEventTime: number;
  lastAggTradeId: number | null;
  lastDepthUpdateId: number | null;
  pendingCandle: RawCandleEvent | null;
  eventCount: number;
  acceptedEventCount: number;
  rejectedEventCount: number;
  gapCount: number;
  outOfOrderCount: number;
  reconnectionCount: number;
  lastCandleTime: number;
  feed: FeedHealth;
  ready: boolean;
  futures: ScoutFuturesContext;
}

export interface MarketDataRuntime {
  start(callbacks: MarketDataCallbacks): Promise<WarmupStatus>;
  stop(): void;
  getState(symbol: ScoutSymbol): SymbolState;
  getHealth(symbol: ScoutSymbol): SymbolHealth;
  getAllHealth(): Record<ScoutSymbol, SymbolHealth>;
  getWarmupStatus(): WarmupStatus;
  isReady(): boolean;
  isHealthy(symbol: ScoutSymbol): boolean;
}

function buildCandle(event: RawCandleEvent): BuiltCandle {
  return {
    openTime: event.openTime,
    open: event.open,
    high: event.high,
    low: event.low,
    close: event.close,
    volume: event.volume,
    buyVolume: event.volume * 0.5,
    closeTime: event.closeTime,
    interval: event.interval,
    isClosed: true,
    candleCount: 1,
  };
}

function initialFuturesContext(): ScoutFuturesContext {
  return {
    markPrice: null,
    markPriceObservedAtMs: null,
    fundingRate: null,
    fundingObservedAtMs: null,
    unavailable: ['mark_price_missing', 'funding_missing', 'open_interest_unsupported'],
  };
}

function createState(): SymbolState {
  return {
    candles1m: new RingBuffer<BuiltCandle>(240),
    candles3m: new RingBuffer<BuiltCandle>(240),
    aggTrades: new RingBuffer<RawAggTradeEvent>(900),
    depth: new RingBuffer<RawDepthEvent>(600),
    lastEventAtMs: 0,
    lastCandleExchangeTime: 0,
    lastAggTradeTime: 0,
    lastDepthEventTime: 0,
    lastAggTradeId: null,
    lastDepthUpdateId: null,
    pendingCandle: null,
    eventCount: 0,
    acceptedEventCount: 0,
    rejectedEventCount: 0,
    gapCount: 0,
    outOfOrderCount: 0,
    reconnectionCount: 0,
    lastCandleTime: 0,
    feed: 'UNSYNCHRONIZED',
    ready: false,
    futures: initialFuturesContext(),
  };
}

export function createScoutMarketDataRuntime(
  cfg: SuiSrScoutConfig,
  logger: Logger,
  source: ScoutMarketDataSource,
): MarketDataRuntime {
  const symbols: readonly ScoutSymbol[] = [cfg.contextSymbol, cfg.symbol];
  const states = new Map<ScoutSymbol, SymbolState>(
    symbols.map((symbol) => [symbol, createState()]),
  );
  const unsubscribes: Array<() => void> = [];
  let callbacks: MarketDataCallbacks = {};
  let running = false;
  let warmup: WarmupStatus = {
    ready: false,
    completedAtMs: null,
    failureReason: null,
    candles1m: { BTCUSDT: 0, SUIUSDT: 0 },
    candles3m: { BTCUSDT: 0, SUIUSDT: 0 },
  };

  function noteRejected(
    state: SymbolState,
    reason: string,
    context: Record<string, unknown>,
  ): void {
    state.rejectedEventCount++;
    logger.warn('scout_market_event_rejected', { reason, ...context });
  }

  function refreshHealth(state: SymbolState, nowMs: number): void {
    const age = nowMs - state.lastEventAtMs;
    if (!state.ready || state.lastEventAtMs === 0) state.feed = 'UNSYNCHRONIZED';
    else if (state.gapCount > 0) state.feed = 'GAPPED';
    else if (state.outOfOrderCount > 0) state.feed = 'OUT_OF_ORDER';
    else if (age > cfg.feedStaleThresholdMs) state.feed = 'STALE';
    else state.feed = 'HEALTHY';
  }

  function acceptEvent(
    state: SymbolState,
    stream: 'candle' | 'agg_trade' | 'depth',
    exchangeTime: number,
    receivedAtMs: number,
  ): boolean {
    state.eventCount++;
    const timeField =
      stream === 'candle'
        ? 'lastCandleExchangeTime'
        : stream === 'agg_trade'
          ? 'lastAggTradeTime'
          : 'lastDepthEventTime';
    const previous = state[timeField];
    if (previous > 0 && exchangeTime < previous) {
      state.outOfOrderCount++;
      noteRejected(state, 'out_of_order_exchange_time', { stream, exchangeTime, previous });
      refreshHealth(state, receivedAtMs);
      return false;
    }
    state[timeField] = Math.max(previous, exchangeTime);
    state.lastEventAtMs = receivedAtMs;
    state.acceptedEventCount++;
    refreshHealth(state, receivedAtMs);
    return true;
  }

  function ingestClosedCandle(event: RawCandleEvent): void {
    const state = states.get(event.symbol as ScoutSymbol);
    if (!state || !acceptEvent(state, 'candle', event.exchangeTime, event.receivedAtMs)) return;
    const candle = buildCandle({ ...event, isClosed: true });
    if (event.interval === '1m') {
      const previous = state.candles1m.last();
      // REST warmup can include the currently open Binance candle. The first
      // WebSocket rollover may therefore close that same openTime; dedupe it.
      if (previous && event.openTime === previous.openTime) return;
      if (previous && event.openTime < previous.openTime) {
        state.outOfOrderCount++;
        noteRejected(state, 'out_of_order_closed_candle', {
          symbol: event.symbol,
          openTime: event.openTime,
        });
        return;
      }
      if (previous && event.openTime !== previous.openTime + 60_000) {
        state.gapCount++;
        logger.warn('scout_candle_gap', {
          symbol: event.symbol,
          expected: previous.openTime + 60_000,
          got: event.openTime,
        });
      }
      state.candles1m.push(candle);
      state.lastCandleTime = event.openTime;
    } else if (event.interval === '3m') {
      state.candles3m.push(candle);
    }
  }

  function ingestLiveCandle(event: RawCandleEvent): void {
    const state = states.get(event.symbol as ScoutSymbol);
    if (!state) return;
    const previous = state.pendingCandle;
    if (previous && event.openTime > previous.openTime) {
      ingestClosedCandle({ ...previous, isClosed: true });
    } else if (previous && event.openTime < previous.openTime) {
      state.outOfOrderCount++;
      noteRejected(state, 'out_of_order_candle_open', {
        symbol: event.symbol,
        openTime: event.openTime,
      });
      return;
    }
    state.pendingCandle = event;
    if (acceptEvent(state, 'candle', event.exchangeTime, event.receivedAtMs))
      callbacks.onCandle?.(event);
  }

  function ingestAggTrade(event: RawAggTradeEvent): void {
    const state = states.get(event.symbol as ScoutSymbol);
    if (!state || !acceptEvent(state, 'agg_trade', event.tradeTime, event.receivedAtMs)) return;
    if (event.aggregateTradeId >= 0 && state.lastAggTradeId !== null) {
      if (event.aggregateTradeId <= state.lastAggTradeId) {
        state.outOfOrderCount++;
        noteRejected(state, 'out_of_order_agg_trade', {
          symbol: event.symbol,
          id: event.aggregateTradeId,
        });
        return;
      }
      if (event.aggregateTradeId > state.lastAggTradeId + 1) {
        state.gapCount++;
        logger.warn('scout_agg_trade_gap', {
          symbol: event.symbol,
          expected: state.lastAggTradeId + 1,
          got: event.aggregateTradeId,
        });
      }
    }
    if (event.aggregateTradeId >= 0) state.lastAggTradeId = event.aggregateTradeId;
    state.aggTrades.push(event);
    callbacks.onAggTrade?.(event);
  }

  function ingestDepth(event: RawDepthEvent): void {
    const state = states.get(event.symbol as ScoutSymbol);
    if (!state || !acceptEvent(state, 'depth', event.eventTime, event.receivedAtMs)) return;
    if (state.lastDepthUpdateId !== null && event.previousUpdateId !== state.lastDepthUpdateId) {
      state.gapCount++;
      logger.warn('scout_depth_gap', {
        symbol: event.symbol,
        expectedPrevious: state.lastDepthUpdateId,
        receivedPrevious: event.previousUpdateId,
      });
    }
    if (event.lastUpdateId <= (state.lastDepthUpdateId ?? -1)) {
      state.outOfOrderCount++;
      noteRejected(state, 'out_of_order_depth', { symbol: event.symbol, id: event.lastUpdateId });
      return;
    }
    state.lastDepthUpdateId = event.lastUpdateId;
    state.depth.push(event);
    callbacks.onDepth?.(event);
  }

  async function warmSymbol(symbol: ScoutSymbol): Promise<void> {
    const [candles1m, candles3m, mark, funding] = await Promise.allSettled([
      source.getCandles(symbol, '1m', 240),
      source.getCandles(symbol, '3m', 80),
      source.getMarkPrice(symbol),
      source.getFundingRate(symbol),
    ]);
    if (candles1m.status !== 'fulfilled' || candles3m.status !== 'fulfilled') {
      throw new Error(`${symbol} candle warmup failed`);
    }
    if (candles1m.value.length < 240 || candles3m.value.length < 20) {
      throw new Error(
        `${symbol} warmup incomplete: 1m=${candles1m.value.length}, 3m=${candles3m.value.length}`,
      );
    }
    const state = states.get(symbol)!;
    for (const candle of candles1m.value) {
      state.candles1m.push(
        buildCandle({
          symbol,
          interval: '1m',
          openTime: candle.openTime,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          volume: candle.volume,
          closeTime: candle.closeTime,
          isClosed: true,
          exchangeTime: candle.closeTime,
          receivedAtMs: Date.now(),
        }),
      );
    }
    for (const candle of candles3m.value) {
      state.candles3m.push(
        buildCandle({
          symbol,
          interval: '3m',
          openTime: candle.openTime,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          volume: candle.volume,
          closeTime: candle.closeTime,
          isClosed: true,
          exchangeTime: candle.closeTime,
          receivedAtMs: Date.now(),
        }),
      );
    }
    state.lastCandleTime = candles1m.value[candles1m.value.length - 1].openTime;
    const unavailable: string[] = ['open_interest_unsupported'];
    state.futures = {
      markPrice: mark.status === 'fulfilled' ? mark.value : null,
      markPriceObservedAtMs: mark.status === 'fulfilled' ? Date.now() : null,
      fundingRate: funding.status === 'fulfilled' ? funding.value.rate : null,
      fundingObservedAtMs: funding.status === 'fulfilled' ? Date.now() : null,
      unavailable: [
        ...(mark.status === 'fulfilled' ? [] : ['mark_price_missing']),
        ...(funding.status === 'fulfilled' ? [] : ['funding_missing']),
        ...unavailable,
      ],
    };
    state.ready = true;
  }

  return {
    async start(nextCallbacks: MarketDataCallbacks): Promise<WarmupStatus> {
      if (running) return warmup;
      callbacks = nextCallbacks;
      try {
        await Promise.all(symbols.map(warmSymbol));
        warmup = {
          ready: true,
          completedAtMs: Date.now(),
          failureReason: null,
          candles1m: {
            BTCUSDT: states.get('BTCUSDT')!.candles1m.length(),
            SUIUSDT: states.get('SUIUSDT')!.candles1m.length(),
          },
          candles3m: {
            BTCUSDT: states.get('BTCUSDT')!.candles3m.length(),
            SUIUSDT: states.get('SUIUSDT')!.candles3m.length(),
          },
        };
      } catch (error) {
        warmup = {
          ...warmup,
          failureReason: error instanceof Error ? error.message : String(error),
        };
        logger.error('scout_warmup_failed', { error: warmup.failureReason });
        return warmup;
      }
      for (const symbol of symbols) {
        unsubscribes.push(
          ...source.subscribe(symbol, {
            onCandle: ingestLiveCandle,
            onAggTrade: ingestAggTrade,
            onDepth: ingestDepth,
            onStreamStatus: (streamSymbol, stream, status) => {
              const state = states.get(streamSymbol as ScoutSymbol);
              if (!state) return;
              if (status === 'reconnecting') {
                state.reconnectionCount++;
                state.gapCount++;
                logger.warn('scout_stream_reconnecting', { symbol: streamSymbol, stream });
              }
            },
          }),
        );
      }
      running = true;
      logger.info('scout_market_data_ready', { symbols, warmup });
      return warmup;
    },
    stop(): void {
      for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
      running = false;
      logger.info('scout_market_data_stopped');
    },
    getState(symbol: ScoutSymbol): SymbolState {
      return states.get(symbol)!;
    },
    getHealth(symbol: ScoutSymbol): SymbolHealth {
      const state = states.get(symbol)!;
      refreshHealth(state, Date.now());
      return {
        feed: state.feed,
        lastEventAtMs: state.lastEventAtMs,
        eventCount: state.eventCount,
        gapCount: state.gapCount,
        outOfOrderCount: state.outOfOrderCount,
        lastCandleTime: state.lastCandleTime,
        reconnectionCount: state.reconnectionCount,
        ready: state.ready,
      };
    },
    getAllHealth(): Record<ScoutSymbol, SymbolHealth> {
      return { BTCUSDT: this.getHealth('BTCUSDT'), SUIUSDT: this.getHealth('SUIUSDT') };
    },
    getWarmupStatus(): WarmupStatus {
      return warmup;
    },
    isReady(): boolean {
      return running && warmup.ready;
    },
    isHealthy(symbol: ScoutSymbol): boolean {
      return this.getHealth(symbol).feed === 'HEALTHY';
    },
  };
}
