/**
 * Exchange capability ports.
 *
 * `Exchange` remains the compatibility composite. New consumers should depend
 * on the narrowest capability they actually use.
 */

import { Side } from '../../core/types';
import { MarketDataPort } from './MarketData';

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

export interface USDTAccountSnapshot {
  walletBalance?: number;
  availableBalance?: number;
  unrealizedPnlTotal?: number;
  equityTotal?: number;
}

export interface ExchangeAccountReadPort {
  readLiquidationPrice(symbol: string, side: Side): Promise<number | null>;
  getUSDTBalance(): Promise<number>;
  getUSDTAccountSnapshot?(): Promise<USDTAccountSnapshot>;
  getSymbolFilters(symbol: string, leverage: number): Promise<SymbolFilters>;
  hasOpenPosition(symbol: string, side: 'LONG' | 'SHORT' | 'ANY'): Promise<boolean>;
  readActivePosition(symbol: string, sideHint: Side): Promise<PositionInfo | null>;
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
  getRecentFills(symbol: string, startTime?: number, limit?: number): Promise<TradeFill[]>;
}

export interface TradingExchangePort extends MarketDataPort, ExchangeAccountReadPort {
  setLeverage(symbol: string, leverage: number): Promise<void>;
  ensureMarginType(symbol: string, marginType?: 'ISOLATED' | 'CROSSED'): Promise<void>;
  marketOpen(
    symbol: string,
    side: Side,
    quantity: number,
    clientOrderId?: string,
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
  cancelOrderById(symbol: string, orderId: string): Promise<void>;
}

export interface Exchange extends MarketDataPort, TradingExchangePort {}

export type {
  BasisSnapshot,
  BinanceDepthDiffEvent,
  BinanceDepthSnapshot,
  FundingSnapshot,
  MarketDataPort,
} from './MarketData';
