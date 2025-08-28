import { Candle, Side } from '../types';

export interface PositionInfo {
  sideMode: 'BOTH' | 'LONG' | 'SHORT';
  qtyAbs: number; // cantidad absoluta del lado activo
  entryPrice: number;
  leverage: number;
}

export interface SymbolFilters {
  tickSize: number;
  stepSize: number;
  pricePrecision: number;
  qtyPrecision: number;
  minNotional: number;
  notionalCap?: number; // del risk bracket según leverage
}

export interface Exchange {
  getServerTime(): Promise<number>;
  getCandles(symbol: string, interval: string, limit: number): Promise<Candle[]>;
  getMarkPrice(symbol: string): Promise<number>;
  readLiquidationPrice(symbol: string, side: Side): Promise<number | null>;

  getUSDTBalance(): Promise<number>;
  setLeverage(symbol: string, leverage: number): Promise<void>;
  getSymbolFilters(symbol: string, leverage: number): Promise<SymbolFilters>;

  hasOpenPosition(symbol: string, side: 'LONG' | 'SHORT' | 'ANY'): Promise<boolean>;
  readActivePosition(symbol: string, sideHint: Side): Promise<PositionInfo | null>;

  marketOpen(
    symbol: string,
    side: Side,
    quantity: number,
  ): Promise<{ avgPrice: number; orderId: string }>;
  placeStopClose(symbol: string, side: Side, stopPrice: number): Promise<void>;
  placeTpClose(symbol: string, side: Side, triggerPrice: number): Promise<void>;
  closeSideMarketSafe(
    symbol: string,
    side: Side,
    qtyAbs: number,
    sideMode: 'BOTH' | 'LONG' | 'SHORT',
  ): Promise<void>;

  openStopForSide(symbol: string, side: Side): Promise<{ stopPrice: number } | null>; // para upsert
  cancelOrderById(symbol: string, orderId: string): Promise<void>;
}
