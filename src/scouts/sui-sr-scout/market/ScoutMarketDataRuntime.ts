import type { Logger } from '../../../app/ports/Logger';
import type { ScoutSymbol, SuiSrScoutConfig, SymbolHealth, FeedHealth } from '../domain/ScoutTypes';
import type { BuiltCandle } from './ThreeMinuteCandleBuilder';

// ── Ring buffer ───────────────────────────────────────────────────
export class RingBuffer<T> {
  private readonly buf: T[];
  private head = 0;
  private count = 0;

  constructor(private readonly capacity: number) {
    this.buf = new Array(capacity);
  }

  push(item: T): void {
    this.buf[(this.head + this.count) % this.capacity] = item;
    if (this.count < this.capacity) {
      this.count++;
    } else {
      this.head = (this.head + 1) % this.capacity;
    }
  }

  items(): T[] {
    const result: T[] = [];
    for (let i = 0; i < this.count; i++) {
      result.push(this.buf[(this.head + i) % this.capacity]);
    }
    return result;
  }

  last(): T | undefined {
    return this.count > 0 ? this.buf[(this.head + this.count - 1) % this.capacity] : undefined;
  }

  length(): number {
    return this.count;
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
  }
}

// ── Raw event types ───────────────────────────────────────────────
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
  readonly lastUpdateId: number;
  readonly eventTime: number;
  readonly receivedAtMs: number;
}

// ── Per-symbol state ──────────────────────────────────────────────
interface SymbolState {
  readonly candles1m: RingBuffer<BuiltCandle>;
  readonly candles3m: RingBuffer<BuiltCandle>;
  readonly aggTrades: RingBuffer<RawAggTradeEvent>;
  readonly depthBids: RingBuffer<RawDepthEvent>;
  readonly depthAsks: RingBuffer<RawDepthEvent>;
  lastEventAtMs: number;
  lastExchangeTime: number;
  eventCount: number;
  gapCount: number;
  outOfOrderCount: number;
  lastCandleTime: number;
  feed: FeedHealth;
}

function createSymbolState(cfg: SuiSrScoutConfig): SymbolState {
  return {
    candles1m: new RingBuffer<BuiltCandle>(240),
    candles3m: new RingBuffer<BuiltCandle>(240),
    aggTrades: new RingBuffer<RawAggTradeEvent>(900),
    depthBids: new RingBuffer<RawDepthEvent>(60),
    depthAsks: new RingBuffer<RawDepthEvent>(60),
    lastEventAtMs: 0,
    lastExchangeTime: 0,
    eventCount: 0,
    gapCount: 0,
    outOfOrderCount: 0,
    lastCandleTime: 0,
    feed: 'UNSYNCHRONIZED',
  };
}

// ── Market data runtime ───────────────────────────────────────────
export interface MarketDataCallbacks {
  onCandle?: (event: RawCandleEvent) => void;
  onAggTrade?: (event: RawAggTradeEvent) => void;
  onDepth?: (event: RawDepthEvent) => void;
}

export interface MarketDataRuntime {
  start(callbacks: MarketDataCallbacks): void;
  stop(): void;
  getState(symbol: ScoutSymbol): SymbolState;
  getHealth(symbol: ScoutSymbol): SymbolHealth;
  getAllHealth(): Record<ScoutSymbol, SymbolHealth>;
  isHealthy(symbol: ScoutSymbol): boolean;
}

interface WsUnsubscribe {
  (): void;
}

export function createScoutMarketDataRuntime(
  cfg: SuiSrScoutConfig,
  logger: Logger,
  wsSubscribe: (symbol: string, interval: string, cb: MarketDataCallbacks) => WsUnsubscribe[],
): MarketDataRuntime {
  const symbols: readonly ScoutSymbol[] = [cfg.symbol, cfg.contextSymbol];
  const states = new Map<ScoutSymbol, SymbolState>();
  const unsubscribes: WsUnsubscribe[] = [];
  let running = false;

  for (const s of symbols) {
    states.set(s, createSymbolState(cfg));
  }

  function updateFeedHealth(state: SymbolState, nowMs: number): void {
    const age = nowMs - state.lastEventAtMs;
    if (age > cfg.feedStaleThresholdMs * 3) {
      state.feed = 'UNSYNCHRONIZED';
    } else if (age > cfg.feedStaleThresholdMs) {
      state.feed = 'STALE';
    } else if (state.gapCount > 0) {
      state.feed = 'GAPPED';
    } else if (state.outOfOrderCount > 0) {
      state.feed = 'OUT_OF_ORDER';
    } else if (state.eventCount > 5) {
      state.feed = 'HEALTHY';
    }
  }

  function toBuiltCandle(event: RawCandleEvent): BuiltCandle {
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
      isClosed: event.isClosed,
      candleCount: 1,
    };
  }

  function handleCandle(event: RawCandleEvent): void {
    const state = states.get(event.symbol as ScoutSymbol);
    if (!state) return;
    const nowMs = Date.now();
    state.eventCount++;
    state.lastEventAtMs = nowMs;

    if (event.exchangeTime < state.lastExchangeTime && state.eventCount > 1) {
      state.outOfOrderCount++;
    }
    state.lastExchangeTime = Math.max(state.lastExchangeTime, event.exchangeTime);

    if (event.isClosed) {
      const built = toBuiltCandle(event);
      if (event.interval === '1m') {
        state.candles1m.push(built);
        state.lastCandleTime = event.openTime;
      } else if (event.interval === '3m') {
        state.candles3m.push(built);
      }
    }
    updateFeedHealth(state, nowMs);
  }

  function handleAggTrade(event: RawAggTradeEvent): void {
    const state = states.get(event.symbol as ScoutSymbol);
    if (!state) return;
    const nowMs = Date.now();
    state.eventCount++;
    state.lastEventAtMs = nowMs;
    state.aggTrades.push(event);
    updateFeedHealth(state, nowMs);
  }

  function handleDepth(event: RawDepthEvent): void {
    const state = states.get(event.symbol as ScoutSymbol);
    if (!state) return;
    const nowMs = Date.now();
    state.eventCount++;
    state.lastEventAtMs = nowMs;
    state.depthBids.push({ ...event, bids: event.bids });
    state.depthAsks.push({ ...event, asks: event.asks });
    updateFeedHealth(state, nowMs);
  }

  return {
    start(callbacks: MarketDataCallbacks): void {
      if (running) return;
      running = true;

      for (const symbol of symbols) {
        const unsubs = wsSubscribe(symbol, cfg.candleIntervals[0], {
          onCandle: (e) => {
            handleCandle(e);
            callbacks.onCandle?.(e);
          },
          onAggTrade: (e) => {
            handleAggTrade(e);
            callbacks.onAggTrade?.(e);
          },
          onDepth: (e) => {
            handleDepth(e);
            callbacks.onDepth?.(e);
          },
        });
        unsubscribes.push(...unsubs);
      }

      logger.info('scout_market_data_started', { symbols: [...symbols] });
    },

    stop(): void {
      for (const unsub of unsubscribes) {
        try {
          unsub();
        } catch {
          /* ignore */
        }
      }
      unsubscribes.length = 0;
      running = false;
      logger.info('scout_market_data_stopped');
    },

    getState(symbol: ScoutSymbol): SymbolState {
      return states.get(symbol)!;
    },

    getHealth(symbol: ScoutSymbol): SymbolHealth {
      const s = states.get(symbol)!;
      return {
        feed: s.feed,
        lastEventAtMs: s.lastEventAtMs,
        eventCount: s.eventCount,
        gapCount: s.gapCount,
        outOfOrderCount: s.outOfOrderCount,
        lastCandleTime: s.lastCandleTime,
      };
    },

    getAllHealth(): Record<ScoutSymbol, SymbolHealth> {
      const result = {} as Record<ScoutSymbol, SymbolHealth>;
      for (const s of symbols) {
        result[s] = this.getHealth(s);
      }
      return result;
    },

    isHealthy(symbol: ScoutSymbol): boolean {
      return states.get(symbol)!.feed === 'HEALTHY';
    },
  };
}
