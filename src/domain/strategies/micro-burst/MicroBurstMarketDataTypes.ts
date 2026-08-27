// ── M1 Market Data Plane Types ─────────────────────────────
// Unit convention preserved:
//   price returns: decimal  (0.001 = 0.1% = 10 bps)
//   bps:           10 = 0.1%
//   ROE:           decimal  (0.10 = 10% ROE = priceReturn * leverage)
// ───────────────────────────────────────────────────────────

import { Side } from '../../types';
import { BookDataStatus, BtcDataStatus, OrderBookDepthLevel } from './MicroBurstTypes';

// ── Order Book Synchronization ──────────────────────────────

export type OrderBookHealth = 'HEALTHY' | 'UNAVAILABLE' | 'STALE' | 'UNSYNCED' | 'ANOMALOUS';

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
  /** Local receive time. This is the only timestamp used for staleness. */
  receivedAtMs: number;
}

export interface BinanceDepthSnapshot {
  lastUpdateId: number;
  bids: [string, string][];
  asks: [string, string][];
  receivedAtMs?: number;
}

export interface SynchronizedOrderBookState {
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

export const SYNCHRONIZED_ORDER_BOOK_SNAPSHOT_DEPTH = 1000;
export const BOOK_PRESSURE_FEATURE_DEPTH = 20;

// ── BTC Context Provider ────────────────────────────────────

export interface BtcCandleObservation {
  close: number;
  closeTime: number;
  openTime: number;
}

export interface BtcReturnSet {
  /** Decimal price return: 0.001 = 0.1% = 10 bps. */
  ret1m: number;
  /** Decimal price return: 0.001 = 0.1% = 10 bps. */
  ret3m: number;
  /** Decimal price return: 0.001 = 0.1% = 10 bps. */
  ret5m: number;
  /** Decimal acceleration: change in return rate (ret1m - ret3m scaled). */
  acceleration: number;
  direction: Side | 'NEUTRAL';
  observedAtMs: number;
}

// ── AggTrade Buffer ─────────────────────────────────────────

export interface AggTradeEvent {
  eventTime: number;
  receivedAtMs?: number;
  price: number;
  quantity: number;
  isBuyerMaker: boolean;
  aggregateTradeId?: number;
  firstTradeId?: number;
  lastTradeId?: number;
}

// ── Reference Price ─────────────────────────────────────────

export type ReferencePriceSource = 'MARK_PRICE' | 'MIDPOINT' | 'BEST_BID_ASK';

export interface MicroBurstReferencePrice {
  price: number;
  source: ReferencePriceSource;
  observedAtMs: number;
  /** Whether this price is from a live runtime source (vs. candle close). */
  isLiveRuntime: boolean;
}

// ── Temporal Book History ───────────────────────────────────

export interface TemporalBookSnapshot {
  observedAtMs: number;
  /** Positive values indicate bid-side pressure; negative values indicate ask-side pressure. */
  signedTopOfBookImbalance: number;
  /** Direction-free size of the top-of-book imbalance. */
  topOfBookImbalance: number;
  bestBidQty: number;
  bestAskQty: number;
  bidTop5Qty: number;
  askTop5Qty: number;
  spreadBps: number;
}

// ── Shadow Evaluation ───────────────────────────────────────

export interface MicroBurstShadowEvaluationInput {
  symbol: string;
  snapshotAtMs: number;
}

export interface MicroBurstShadowEvaluationResult {
  strategyId: string;
  strategyVersion: string;
  symbol: string;
  snapshotAtMs: number;
  decision: 'NO_TRADE' | 'ENTRY_INTENT';
  side?: Side;
  confidence: number;
  referencePrice: number;
  supportPrice: number | null;
  resistancePrice: number | null;
  structuralInvalidation: number | null;
  destinationPrice: number | null;
  roomToTargetBps: number | null;
  riskToInvalidationBps: number | null;
  rewardRisk: number | null;
  momentum: {
    direction: Side | 'NEUTRAL';
    strength: number;
    continuationScore: number;
  };
  book: {
    status: BookDataStatus;
    ageMs: number | null;
    imbalance: number;
    imbalanceSlope: number | null;
  };
  btc: {
    status: BtcDataStatus;
    ageMs: number | null;
    ret1m: number | null;
    ret3m: number | null;
    ret5m: number | null;
    conflict: boolean;
  };
  microRegime: string;
  dataQuality: {
    contextValid: boolean;
    invalidReasons: string[];
  };
  wouldEnter: boolean;
  liveExecution: false;
  shadowSignalId: string;
  duplicateSuppressed: boolean;
  firstObservedAt: number;
  lastObservedAt: number;
  diagnostics: Record<string, unknown>;
}

// ── Shadow Telemetry Log ────────────────────────────────────

export interface MicroBurstShadowTelemetryLog {
  strategyId: string;
  strategyVersion: string;
  symbol: string;
  snapshotAtMs: number;
  decision: 'NO_TRADE' | 'ENTRY_INTENT';
  side?: Side;
  confidence: number;
  referencePrice: number;
  support: number | null;
  resistance: number | null;
  structuralInvalidation: number | null;
  target: number | null;
  roomToTargetBps: number | null;
  riskToInvalidationBps: number | null;
  rewardRisk: number | null;
  momentum: {
    direction: Side | 'NEUTRAL';
    strength: number;
    continuationScore: number;
  };
  bookStatus: BookDataStatus;
  bookAgeMs: number | null;
  bookImbalance: number;
  imbalanceSlope: number | null;
  btcStatus: BtcDataStatus;
  btcAgeMs: number | null;
  btcRet1m: number | null;
  btcRet3m: number | null;
  btcRet5m: number | null;
  btcConflict: boolean;
  microRegime: string;
  dataQualityContextValid: boolean;
  invalidReasons: string[];
  wouldEnter: boolean;
  liveExecution: false;
  shadowSignalId: string;
  duplicateSuppressed: boolean;
  firstObservedAt: number;
  lastObservedAt: number;
}

// ── Config ──────────────────────────────────────────────────

export interface MicroBurstSymbolConfig {
  enabled: boolean;
  btcConflictThresholdBps?: number;
  bookDepthLevels?: number;
  bookDepthSpeed?: '100ms' | '250ms' | '500ms';
}

export interface MicroBurstRuntimeConfig {
  enabled: boolean;
  mode: 'OFF' | 'SHADOW' | 'LIVE';
  symbols: Record<string, MicroBurstSymbolConfig>;
  prospectiveValidation?: {
    enabled: boolean;
    cohortId?: string;
    horizonsMs?: number[];
    conservativeEntrySlippageBps?: number;
  };
  marketArchive?: {
    enabled: boolean;
    rootDir?: string;
    sqlitePath?: string;
    tradeRetentionMs?: number;
    bookCheckpointIntervalMs?: number;
    rawTradeArchive?: boolean;
    rawDepthArchive?: boolean;
    compression?: 'gzip';
    maxActiveSegmentRecords?: number;
    maxActiveSegmentBytes?: number;
    maxActiveSegmentDurationMs?: number;
    durabilityFlushIntervalMs?: number;
  };
}
