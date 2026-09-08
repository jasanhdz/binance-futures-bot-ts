/**
 * Exchange capability ports.
 *
 * `Exchange` remains the compatibility composite. New consumers should depend
 * on the narrowest capability they actually use.
 */

import { Side } from '../../core/types';
import { MarketDataPort } from './MarketData';
import type {
  MicroBurstSettlementEvidence,
  MicroBurstSettlementIdentity,
} from '../../strategies/micro-burst/domain/MicroBurstSettlement';

export interface PositionInfo {
  sideMode: 'BOTH' | 'LONG' | 'SHORT';
  qtyAbs: number;
  entryPrice: number;
  leverage: number;
  isolatedMargin?: number;
  unrealizedPnl?: number;
  roePct?: number;
}

export interface EntryRecoveryExpectation {
  side: Side;
  quantity: number;
  notBeforeMs: number;
}

/** Bounded, current attribution; not a verified PnL outcome or an atomic account snapshot. */
export interface RecoverableEntryPosition {
  source: 'BINANCE_ORDER_AND_TRADES_V1';
  observedAt: number;
  symbol: string;
  side: Side;
  clientOrderId: string;
  orderId: string;
  filledAt: number;
  fillIds: string[];
  position: PositionInfo;
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
  /** Exhaustive exact-order accounting; null is unknown, never a zero-cost settlement. */
  readMicroBurstSettlement?(
    identity: MicroBurstSettlementIdentity,
  ): Promise<MicroBurstSettlementEvidence | null>;
  readLiquidationPrice(symbol: string, side: Side): Promise<number | null>;
  getUSDTBalance(): Promise<number>;
  getUSDTAccountSnapshot?(): Promise<USDTAccountSnapshot>;
  getSymbolFilters(symbol: string, leverage: number): Promise<SymbolFilters>;
  hasOpenPosition(symbol: string, side: 'LONG' | 'SHORT' | 'ANY'): Promise<boolean>;
  readActivePosition(symbol: string, sideHint: Side): Promise<PositionInfo | null>;
  /** Uncached validated observation; absence is only represented by explicit null. */
  readFreshActivePosition?(symbol: string, sideHint: Side): Promise<PositionInfo | null>;
  readMarketOpenByClientOrderId(
    symbol: string,
    clientOrderId: string,
    expected?: EntryRecoveryExpectation,
  ): Promise<{ avgPrice: number; orderId: string } | null>;
  /** Null/errors mean attribution is insufficient: never infer ownership from matching side alone. */
  readRecoverableEntryPosition?(
    symbol: string,
    clientOrderId: string,
    expected: EntryRecoveryExpectation,
  ): Promise<RecoverableEntryPosition | null>;
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

export interface IdentifiedCloseRequest {
  symbol: string;
  side: Side;
  positionSide: 'BOTH' | 'LONG' | 'SHORT';
  quantity: number;
  clientOrderId: string;
  notBeforeMs: number;
}

export interface IdentifiedCloseEvidence {
  clientOrderId: string;
  orderId: string;
  status: 'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELED' | 'EXPIRED';
  executedQuantity: number;
}

/** Single transport attempt; lookup evidence is not a position-flat or accounting verdict. */
export interface IdentifiedClosePort {
  sendMarketCloseOnce(request: IdentifiedCloseRequest): Promise<void>;
  readMarketCloseByClientOrderId(
    request: IdentifiedCloseRequest,
  ): Promise<IdentifiedCloseEvidence | null>;
}

export interface TradingExchangePort
  extends MarketDataPort,
    ExchangeAccountReadPort,
    Partial<IdentifiedClosePort> {
  /** Exact target lookup, including BOT prefix and close-order context. Null is unknown. */
  readCancelTarget?(request: CancelTarget): Promise<'NEW' | 'CANCELED' | 'FILLED' | null>;
  /** Conditional algo endpoint only; no fallback or resend. Missing capability fails closed. */
  sendStopCloseOnce?(request: IdentifiedStopRequest): Promise<StopOrderReceipt>;
  /** Positive result requires exact identity and a currently NEW, BOT-owned covering stop. */
  readStopCloseByClientOrderId?(request: IdentifiedStopRequest): Promise<StopOrderReceipt | null>;
  /** Exact identity; only NEW or definitively CANCELED are understood, all others unknown. */
  readStopCloseState?(request: IdentifiedStopRequest): Promise<StopOrderState | null>;
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

export interface CancelTarget {
  symbol: string;
  side: Side;
  orderId: string;
  type: 'STOP_MARKET' | 'STOP' | 'TAKE_PROFIT_MARKET' | 'TAKE_PROFIT';
  positionSide: 'BOTH' | 'LONG' | 'SHORT';
  stopPrice: number;
}

export interface IdentifiedStopRequest {
  symbol: string;
  side: Side;
  positionSide: 'BOTH' | 'LONG' | 'SHORT';
  triggerPrice: number;
  closePosition: true;
  workingType: 'MARK_PRICE';
  clientOrderId: string;
}

export interface StopOrderReceipt {
  clientOrderId: string;
  orderId: string;
}

export interface StopOrderState extends StopOrderReceipt {
  status: 'NEW' | 'CANCELED';
}

export type {
  BasisSnapshot,
  BinanceDepthDiffEvent,
  BinanceDepthSnapshot,
  FundingSnapshot,
  MarketDataPort,
} from './MarketData';
