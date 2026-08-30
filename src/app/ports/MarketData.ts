/** Neutral exchange market-data payloads and capability shared by consumers. */

import { Candle } from '../../core/types';

export interface BinanceDepthDiffEvent {
  /** First update ID in this USD-M diff-depth event (Binance `U`). */
  U: number;
  /** Final update ID in this USD-M diff-depth event (Binance `u`). */
  u: number;
  /** Final update ID of the preceding event (Binance `pu`). */
  pu: number;
  bids: [string, string][];
  asks: [string, string][];
  /** Event time (Binance `E`). */
  E: number;
  /** Transaction time (Binance `T`). */
  T: number;
  /** Local receive time. */
  receivedAtMs: number;
}

export interface BinanceDepthSnapshot {
  lastUpdateId: number;
  bids: [string, string][];
  asks: [string, string][];
  receivedAtMs?: number;
}

export interface AggTradeEvent {
  eventTime: number;
  receivedAtMs?: number;
  price: number;
  quantity: number;
  isBuyerMaker: boolean;
  tradeTime?: number;
  aggregateTradeId?: number;
  firstTradeId?: number;
  lastTradeId?: number;
}

export interface LiveCandleUpdate {
  readonly symbol: string;
  readonly interval: string;
  readonly candle: Candle;
  /** Local receive time of the WebSocket update. */
  readonly observedAtMs: number;
  readonly source: 'WEBSOCKET';
}

export interface OrderBookDepthLevel {
  price: number;
  qty: number;
}

export type OrderBookHealth = 'HEALTHY' | 'UNAVAILABLE' | 'STALE' | 'UNSYNCED' | 'ANOMALOUS';

export type QuoteHealth = OrderBookHealth;

export interface QuoteSnapshot {
  readonly symbol: string;
  readonly bid: number | null;
  readonly ask: number | null;
  readonly mid: number | null;
  readonly spread: number | null;
  readonly spreadBps: number | null;
  readonly health: QuoteHealth;
  /** Local receive time of the underlying synchronized order-book observation. */
  readonly observedAtMs: number | null;
  readonly source: 'SYNCHRONIZED_ORDER_BOOK';
}

export interface QuotePort {
  getQuote(): QuoteSnapshot;
}

export type CandleStatus = 'OPEN' | 'CLOSED';
export type CandleHealth = 'HEALTHY' | 'UNAVAILABLE' | 'STALE' | 'GAPPED' | 'ANOMALOUS';
export type CandleGapCheck = 'CHECKED' | 'UNSUPPORTED';

export interface CandleObservation {
  readonly symbol: string;
  readonly interval: string;
  readonly openTime: number;
  readonly closeTime: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  /** Preserved from the existing source without reinterpretation. */
  readonly buyVolume: number;
  readonly status: CandleStatus;
  /** Local receive time of the source response. */
  readonly observedAtMs: number;
  readonly source: 'REST';
}

export interface CandleSeriesSnapshot {
  readonly symbol: string;
  readonly interval: string;
  readonly candles: readonly CandleObservation[];
  readonly health: CandleHealth;
  readonly observedAtMs: number | null;
  readonly exchangeSnapshotTimeMs: number | null;
  readonly gapCount: number;
  readonly hasGaps: boolean | null;
  readonly gapCheck: CandleGapCheck;
  readonly source: 'REST';
}

export interface CandlePort {
  getSeries(symbol: string, interval: string, limit: number): Promise<CandleSeriesSnapshot>;
}

export interface TemporalOrderBookObservation {
  observedAtMs: number;
  signedTopOfBookImbalance: number;
  topOfBookImbalance: number;
  bestBidQty: number;
  bestAskQty: number;
  bidTop5Qty: number;
  askTop5Qty: number;
  spreadBps: number;
}

export interface OrderBookState {
  bids: OrderBookDepthLevel[];
  asks: OrderBookDepthLevel[];
  lastUpdateId: number;
  health: OrderBookHealth;
  observedAtMs: number;
  lastSyncAtMs: number;
  lastDiffAtMs: number;
  gapCount: number;
  resyncCount: number;
}

export interface OrderBookSnapshot {
  bidDepth: OrderBookDepthLevel[];
  askDepth: OrderBookDepthLevel[];
  observedAtMs: number;
  status: 'HEALTHY';
  lastUpdateId: number;
  temporalHistory: TemporalOrderBookObservation[];
}

export interface OrderBookPort {
  start(): void;
  stop(): void;
  getState(): OrderBookState;
  getHealth(): OrderBookHealth;
  getSnapshot(): OrderBookSnapshot | undefined;
}

export const ORDER_BOOK_SNAPSHOT_DEPTH = 1000;
export const ORDER_BOOK_FEATURE_DEPTH = 20;

export interface FundingSnapshot {
  rate: number;
  nextFundingTime?: number;
}

export interface BasisSnapshot {
  markPrice: number;
  indexPrice: number;
  basisPct: number;
}

export interface MarketDataPort {
  getServerTime(): Promise<number>;
  getCandles(symbol: string, interval: string, limit: number): Promise<Candle[]>;
  getLastCandle(symbol: string): Promise<Candle | null>;
  getCachedCandles?(symbol: string, interval: string, limit: number): Candle[];
  /** Legacy 5m candle subscription retained for existing consumers. */
  subscribeToCandles(symbol: string): () => void;
  /** Neutral live kline stream used by the application-owned shared candle plane. */
  subscribeToKlineCandles?(
    symbol: string,
    interval: string,
    callback: (update: LiveCandleUpdate) => void,
  ): () => void;
  subscribeToPartialDepth?(
    symbol: string,
    levels: number,
    speed: '100ms' | '250ms' | '500ms',
    callback: (depth: any) => void,
  ): () => void;
  subscribeToDepthDiff?(
    symbol: string,
    speed: '100ms' | '250ms' | '500ms',
    callback: (depth: BinanceDepthDiffEvent) => void,
  ): () => void;
  subscribeToAggTrades?(
    symbol: string,
    callback: (trade: {
      isBuyerMaker: boolean;
      quantity: string;
      price: string;
      eventTime: number;
      receivedAtMs?: number;
      tradeTime?: number;
      aggregateTradeId?: number;
      firstTradeId?: number;
      lastTradeId?: number;
    }) => void,
    onStatus?: (status: 'connecting' | 'open' | 'reconnecting') => void,
  ): () => void;
  getDepthSnapshot?(symbol: string, levels?: number): Promise<BinanceDepthSnapshot>;
  getMarkPrice(symbol: string): Promise<number>;
  getFundingRate(symbol: string): Promise<FundingSnapshot>;
  getBasisSnapshot(symbol: string): Promise<BasisSnapshot>;
}
