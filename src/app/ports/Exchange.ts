/**
 * Exchange Port - Application Layer Interface
 * 
 * Defines the contract for exchange operations.
 * Implemented by BinanceAdapter in infrastructure layer.
 */

import { Candle, Side } from '../../domain/types';

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

export interface Exchange {
  getServerTime(): Promise<number>;
  getCandles(symbol: string, interval: string, limit: number): Promise<Candle[]>;
  getLastCandle(symbol: string): Promise<Candle | null>;
  subscribeToCandles(symbol: string): void;
  subscribeToPartialDepth?(symbol: string, levels: number, speed: '100ms' | '250ms' | '500ms', callback: (depth: any) => void): void;
  getMarkPrice(symbol: string): Promise<number>;
  getFundingRate(symbol: string): Promise<FundingSnapshot>;
  getBasisSnapshot(symbol: string): Promise<BasisSnapshot>;
  readLiquidationPrice(symbol: string, side: Side): Promise<number | null>;

  getUSDTBalance(): Promise<number>;
  setLeverage(symbol: string, leverage: number): Promise<void>;
  ensureMarginType(symbol: string, marginType?: 'ISOLATED' | 'CROSSED'): Promise<void>;
  getSymbolFilters(symbol: string, leverage: number): Promise<SymbolFilters>;

  hasOpenPosition(symbol: string, side: 'LONG' | 'SHORT' | 'ANY'): Promise<boolean>;
  readActivePosition(symbol: string, sideHint: Side): Promise<PositionInfo | null>;

  marketOpen(
    symbol: string,
    side: Side,
    quantity: number,
  ): Promise<{ avgPrice: number; orderId: string }>;
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
    }[]
  >;

  cancelOrderById(symbol: string, orderId: string): Promise<void>;

  getRecentFills(symbol: string, startTime?: number, limit?: number): Promise<TradeFill[]>;
}
