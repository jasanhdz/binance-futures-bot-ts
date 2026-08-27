import { Candle, Side } from '../../types';
import { StrategyIdentity } from '../../strategy/StrategyIdentity';
import {
  StrategyExecutionIntent,
  StrategyProtectionExecutionPolicy,
} from '../../strategy/StrategyExecution';

// ── Unit convention ──────────────────────────────────────────
// price returns: decimal  (0.001 = 0.1% = 10 bps)
// bps:           10 = 0.1%
// ROE:           decimal  (0.10 = 10% ROE = priceReturn * leverage)
// ─────────────────────────────────────────────────────────────

export type LeverageTier = 'HIGH_CONFIRMATION' | 'MEDIUM_CONFIRMATION' | 'NO_TRADE';

export type MicroRegime = 'TRENDING_UP' | 'TRENDING_DOWN' | 'RANGING' | 'VOLATILE';

export type StructuralPosition = 'near_support' | 'near_resistance' | 'mid_range';

export type BookDataStatus = 'HEALTHY' | 'UNAVAILABLE' | 'STALE' | 'UNSYNCED' | 'ANOMALOUS';

export type MicroBurstExitReason =
  | 'HARD_INVALIDATION'
  | 'ANOMALY'
  | 'BTC_REVERSAL'
  | 'EARLY_FAILURE'
  | 'TARGET'
  | 'TRAILING'
  | 'BREAK_EVEN'
  | 'MAX_HOLD'
  | 'HOLD';

// ── S/R ──────────────────────────────────────────────────────

export interface SupportResistanceLevel {
  price: number;
  type: 'support' | 'resistance';
  strength: number;
  touches: number;
  lastTouchIndex: number;
  /** Candle index where the right-confirmation bars completed and level became available. */
  availableAtCandleIndex: number;
  volumeAtLevel: number;
}

export interface NearestLevels {
  support: SupportResistanceLevel | null;
  resistance: SupportResistanceLevel | null;
  distanceToSupportBps: number;
  distanceToResistanceBps: number;
  corridorWidthBps: number;
  structuralPosition: StructuralPosition;
}

export interface SupportResistanceResult {
  levels: SupportResistanceLevel[];
  nearest: NearestLevels;
}

// ── Momentum ─────────────────────────────────────────────────

export interface MicroMomentumSignal {
  direction: Side | 'NEUTRAL';
  strength: number;
  continuationScore: number;
  /** Normalized slopes: decimal price return per bar (0.001 = 0.1%). */
  slope1m: number;
  slope3m: number;
  slope5m: number;
  bodyStrength: number;
  wickRejectionUpper: number;
  wickRejectionLower: number;
  volumeExpansion: boolean;
  candleSequenceQuality: number;
}

// ── Book ─────────────────────────────────────────────────────

export interface BookPressureSignal {
  spreadBps: number;
  topOfBookImbalance: number;
  /** null when temporal book data is unavailable (single snapshot only). */
  imbalanceSlope: number | null;
  /** Static proxy: top level concentration anomaly (NOT temporal absorption). */
  staticBidConcentration: boolean;
  /** Static proxy: depth discontinuity above best ask (NOT temporal sweep). */
  staticAskConcentration: boolean;
  anomalyFlag: boolean;
  status: BookDataStatus;
}

// ── BTC ──────────────────────────────────────────────────────

export interface BtcContext {
  /** Decimal price return: 0.001 = 0.1% = 10 bps. */
  ret1m: number;
  ret3m: number;
  ret5m: number;
  /** Decimal acceleration (change in return rate). */
  acceleration: number;
  conflictFlag: boolean;
  direction: Side | 'NEUTRAL';
}

// ── Candle Set ───────────────────────────────────────────────

export interface MicroBurstCandleSet {
  candles1m: Candle[];
  candles3m: Candle[];
  candles5m: Candle[];
}

// ── Context ──────────────────────────────────────────────────

export interface DataQualityDiagnostics {
  snapshotAt: number;
  latestClosed1mAt: number;
  latestClosed3mAt: number;
  latestClosed5mAt: number;
  candleFreshnessMs: number;
  bookAgeMs: number | null;
  btcAgeMs: number | null;
  bookStatus: BookDataStatus;
  closedCandlesOnly: boolean;
  levelsAvailableAt: number | null;
  contextValid: boolean;
  invalidReasons: string[];
}

export interface MicroBurstContext {
  symbol: string;
  timestamp: number;
  currentPrice: number;
  candles: MicroBurstCandleSet;
  levels: SupportResistanceResult;
  momentum: MicroMomentumSignal;
  bookPressure: BookPressureSignal;
  btcContext: BtcContext | null;
  structuralClarity: boolean;
  microRegime: MicroRegime;
  dataQuality: DataQualityDiagnostics;
}

// ── Entry ────────────────────────────────────────────────────

export interface MicroBurstEntryDecision {
  action: 'NO_TRADE' | 'ENTRY_INTENT';
  side?: Side;
  leverageTier?: LeverageTier;
  leverage?: number;
  positionFraction?: number;
  stopInvalidationPrice?: number;
  targetPrice?: number;
  /** Decimal (0.001 = 10 bps). Required when action === ENTRY_INTENT. */
  roomToTargetBps?: number;
  /** Decimal (0.001 = 10 bps). Required when action === ENTRY_INTENT. */
  riskToInvalidationBps?: number;
  reason: string;
  confirmationStrength: number;
  diagnostics: Record<string, unknown>;
}

// ── Exit ─────────────────────────────────────────────────────

export interface MicroBurstExitContext {
  /** Current unrealized ROE (decimal: 0.10 = 10%). */
  unrealizedRoe: number;
  /** Price return from entry in decimal (0.001 = 0.1%). */
  priceReturn: number;
  /** Current market price. */
  currentPrice: number;
  /** Entry price (for computing absolute stop/target). */
  entryPrice: number;
  /** Peak favorable price (high water mark). */
  peakPrice: number;
  /** Trough adverse price (low water mark). */
  troughPrice: number;
  timeInTradeMs: number;
  momentumDecayFlag: boolean;
  anomalyExitFlag: boolean;
  currentBookPressure: BookPressureSignal | null;
  currentBtcContext: BtcContext | null;
  /** Leverage used at entry (needed for ROE-to-price if ever needed explicitly). */
  leverage: number;
}

export interface MicroBurstExitDecision {
  action: 'HOLD' | 'CLOSE_MARKET' | 'MOVE_STOP';
  reason: MicroBurstExitReason;
  requestedStopPrice?: number;
  diagnostics: Record<string, unknown>;
}

// ── Leverage ─────────────────────────────────────────────────

export interface MicroBurstLeverageTierConfig {
  minConfirmation: number;
  /** EXPERIMENTAL_DEFAULT — not approved, subject to hard caps. */
  leverage: number;
  positionFraction: number;
}

// ── Config ───────────────────────────────────────────────────

export interface MicroBurstConfig {
  srLookbackBars: number;
  srPivotLeftBars: number;
  srPivotRightBars: number;
  srClusterToleranceBps: number;
  srMinStrength: number;
  nearLevelThresholdBps: number;
  momentumSlopePeriod: number;
  momentumMinContinuationScore: number;
  /** Decimal: 0.003 = 0.3% = 30 bps. */
  btcConflictThresholdBps: number;
  bookAnomalySpreadBps: number;
  bookMinImbalance: number;
  structuralInvalidationBufferBps: number;
  minRoomBps: number;
  leverageTiers: {
    high: MicroBurstLeverageTierConfig;
    medium: MicroBurstLeverageTierConfig;
  };
  exitEarlyFailureWindowMs: number;
  exitEarlyFailureMinPriceReturn: number;
  exitMaxHoldMs: number;
  exitBreakEvenMinPriceReturn: number;
  exitTrailingActivationPriceReturn: number;
  exitTrailingCallbackPriceReturn: number;
  maxLeverageHardCap: number;
}

export function defaultMicroBurstConfig(): MicroBurstConfig {
  return {
    srLookbackBars: 20,
    srPivotLeftBars: 3,
    srPivotRightBars: 3,
    srClusterToleranceBps: 15,
    srMinStrength: 0.3,
    nearLevelThresholdBps: 50,
    momentumSlopePeriod: 5,
    momentumMinContinuationScore: 0.5,
    btcConflictThresholdBps: 30,
    bookAnomalySpreadBps: 20,
    bookMinImbalance: 0.2,
    structuralInvalidationBufferBps: 20,
    minRoomBps: 30,
    leverageTiers: {
      high: { minConfirmation: 0.75, leverage: 40, positionFraction: 0.09 },
      medium: { minConfirmation: 0.5, leverage: 20, positionFraction: 0.05 },
    },
    exitEarlyFailureWindowMs: 60_000,
    exitEarlyFailureMinPriceReturn: 0.0005,
    exitMaxHoldMs: 300_000,
    exitBreakEvenMinPriceReturn: 0.001,
    exitTrailingActivationPriceReturn: 0.0015,
    exitTrailingCallbackPriceReturn: 0.0005,
    maxLeverageHardCap: 50,
  };
}

// ── Execution Intent Factory ─────────────────────────────────

export interface MicroBurstApprovedEntry {
  identity: StrategyIdentity;
  symbol: string;
  side: Side;
  leverage: number;
  positionFraction: number;
  stopInvalidationPrice: number;
  targetPrice: number;
  signalId?: string;
}

export function createMicroBurstExecutionIntent(
  approved: MicroBurstApprovedEntry,
  pricePrecision: number,
): StrategyExecutionIntent {
  return {
    identity: approved.identity,
    signalId: approved.signalId,
    tradeId: `MICRO-BURST-V1-${approved.symbol}-${Date.now()}`,
    symbol: approved.symbol,
    requestedAt: Date.now(),
    side: approved.side,
    leverage: approved.leverage,
    positionFraction: approved.positionFraction,
    structuralStopPrice: approved.stopInvalidationPrice,
    destinationPrice: approved.targetPrice,
    protection: {
      requireStop: true,
      requireTakeProfit: false,
      closeIfProtectionFails: true,
    },
    metadata: {
      strategy: 'MICRO_BURST_V1',
      leverageTier: approved.leverage > 30 ? 'HIGH' : 'MEDIUM',
    },
  };
}
