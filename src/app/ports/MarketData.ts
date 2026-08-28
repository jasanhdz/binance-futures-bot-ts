/** Neutral exchange market-data payloads and capability shared by consumers. */

import { Candle } from '../../domain/types';

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
  subscribeToCandles(symbol: string): () => void;
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
