/**
 * Exchange Port - Application Layer Interface
 *
 * Defines the contract for exchange operations.
 * Implemented by BinanceAdapter in infrastructure layer.
 */

import { Candle, Side } from '../../domain/types';
import {
  BinanceDepthDiffEvent,
  BinanceDepthSnapshot,
} from '../../domain/strategies/micro-burst/MicroBurstMarketDataTypes';

export interface PositionInfo {
  sideMode: 'BOTH' | 'LONG' | 'SHORT';
  qtyAbs: number;
  entryPrice: number;
  leverage: number;
  isolatedMargin?: number;
  unrealizedPnl?: number;
  roePct?: number;
}

export type TradeFill = {
  orderId: string;
  side: 'BUY' | 'SELL';
  price: number;
  qty: number;
  realizedPnl?: number;
  commission?: number;
  commissionAsset?: string;
  time: number;
};

export interface SymbolFilters {
  tickSize: number;
  stepSize: number;
  pricePrecision: number;
  qtyPrecision: number;
  minNotional: number;
  notionalCap?: number;
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

export interface USDTAccountSnapshot {
  walletBalance?: number;
  availableBalance?: number;
  unrealizedPnlTotal?: number;
  equityTotal?: number;
}

export interface Exchange {
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
  ): () => void;
  getDepthSnapshot?(symbol: string, levels?: number): Promise<BinanceDepthSnapshot>;
  getMarkPrice(symbol: string): Promise<number>;
  getFundingRate(symbol: string): Promise<FundingSnapshot>;
  getBasisSnapshot(symbol: string): Promise<BasisSnapshot>;
  readLiquidationPrice(symbol: string, side: Side): Promise<number | null>;

  getUSDTBalance(): Promise<number>;
  getUSDTAccountSnapshot?(): Promise<USDTAccountSnapshot>;
  setLeverage(symbol: string, leverage: number): Promise<void>;
  ensureMarginType(symbol: string, marginType?: 'ISOLATED' | 'CROSSED'): Promise<void>;
  getSymbolFilters(symbol: string, leverage: number): Promise<SymbolFilters>;

  hasOpenPosition(symbol: string, side: 'LONG' | 'SHORT' | 'ANY'): Promise<boolean>;
  readActivePosition(symbol: string, sideHint: Side): Promise<PositionInfo | null>;

  marketOpen(
    symbol: string,
    side: Side,
    quantity: number,
    clientOrderId?: string,
  ): Promise<{ avgPrice: number; orderId: string }>;
  readMarketOpenByClientOrderId(
    symbol: string,
    clientOrderId: string,
  ): Promise<{ avgPrice: number; orderId: string } | null>;
  /** Optional exchange-specific evidence lookup used after an ambiguous submit. */
  readMarketOpenEvidence?(
    symbol: string,
    clientOrderId: string,
    since: number,
  ): Promise<{ avgPrice: number; orderId: string } | null>;
  placeStopClose(symbol: string, side: Side, stopPrice: number, qty?: number): Promise<boolean>;
  placeTpClose(symbol: string, side: Side, triggerPrice: number, qty?: number): Promise<boolean>;
  closeSideMarketSafe(
    symbol: string,
    side: Side,
    qtyAbs: number,
    sideMode: 'BOTH' | 'LONG' | 'SHORT',
    reason?: string,
  ): Promise<void>;

  openStopForSide(
    symbol: string,
    side: Side,
  ): Promise<{ stopPrice: number; orderId: string } | null>;

  listCloseOrdersForSide(
    symbol: string,
    side: Side,
  ): Promise<
    {
      orderId: string;
      type: 'STOP_MARKET' | 'STOP' | 'TAKE_PROFIT_MARKET' | 'TAKE_PROFIT';
      stopPrice: number;
      closePosition?: boolean;
      reduceOnly?: boolean;
      quantity?: number;
      side?: 'BUY' | 'SELL';
      positionSide?: 'BOTH' | 'LONG' | 'SHORT';
      workingType?: 'MARK_PRICE' | 'CONTRACT_PRICE';
      owner?: 'BOT' | 'UNKNOWN';
    }[]
  >;

  cancelOrderById(symbol: string, orderId: string): Promise<void>;

  getRecentFills(symbol: string, startTime?: number, limit?: number): Promise<TradeFill[]>;
}
