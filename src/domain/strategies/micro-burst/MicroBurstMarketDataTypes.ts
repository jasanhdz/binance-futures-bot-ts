// ── M1 Market Data Plane Types ─────────────────────────────
// Unit convention preserved:
//   price returns: decimal  (0.001 = 0.1% = 10 bps)
//   bps:           10 = 0.1%
//   ROE:           decimal  (0.10 = 10% ROE = priceReturn * leverage)
// ───────────────────────────────────────────────────────────

import { Side } from '../../types';
import { BookDataStatus, BtcDataStatus } from './MicroBurstTypes';
import {
  OrderBookHealth as SharedOrderBookHealth,
  OrderBookState,
  TemporalOrderBookObservation,
  ORDER_BOOK_SNAPSHOT_DEPTH,
} from '../../../app/ports/MarketData';
export type { BinanceDepthDiffEvent, BinanceDepthSnapshot } from '../../../app/ports/MarketData';

// ── Order Book Synchronization ──────────────────────────────

export type OrderBookHealth = SharedOrderBookHealth;

export type SynchronizedOrderBookState = OrderBookState;

export const SYNCHRONIZED_ORDER_BOOK_SNAPSHOT_DEPTH = ORDER_BOOK_SNAPSHOT_DEPTH;
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

export type TemporalBookSnapshot = TemporalOrderBookObservation;

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
