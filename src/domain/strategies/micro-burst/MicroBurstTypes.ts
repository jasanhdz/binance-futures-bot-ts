import { Candle, Side } from '../../types';
import { StrategyIdentity } from '../../strategy/StrategyIdentity';

// ── Unit convention ──────────────────────────────────────────
// price returns: decimal  (0.001 = 0.1% = 10 bps)
// bps:           10 = 0.1%
// ROE:           decimal  (0.10 = 10% ROE = priceReturn * leverage)
// ─────────────────────────────────────────────────────────────

export type LeverageTier = 'HIGH_CONFIRMATION' | 'MEDIUM_CONFIRMATION' | 'NO_TRADE';

export type MicroRegime = 'TRENDING_UP' | 'TRENDING_DOWN' | 'RANGING' | 'VOLATILE';

export type StructuralPosition = 'near_support' | 'near_resistance' | 'mid_range';

export type BookDataStatus = 'HEALTHY' | 'UNAVAILABLE' | 'STALE' | 'UNSYNCED' | 'ANOMALOUS';

export type BtcDataStatus = 'HEALTHY' | 'UNAVAILABLE' | 'STALE';

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
  pivotCandleIndex: number;
  availableAtCandleIndex: number;
  /** Close time of the pivot candle. */
  pivotAtMs: number;
  /** Close time of the final right-confirmation candle. Available inclusively at this time. */
  availableAtMs: number;
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
  /** Positive values indicate bid-side pressure; negative values indicate ask-side pressure. */
  signedTopOfBookImbalance: number;
  /** Direction-free size of the top-of-book imbalance. */
  topOfBookImbalance: number;
  /** null when temporal book data is unavailable (single snapshot only). */
  imbalanceSlope: number | null;
  /** Temporal: true absorption detected from multiple observations. */
  temporalAbsorptionDetected: boolean;
  /** Temporal: true sweep detected from multiple observations. */
  temporalSweepDetected: boolean;
  /** Static proxy: top level concentration anomaly (NOT temporal absorption). */
  staticBidConcentration: boolean;
  /** Static proxy: depth discontinuity above best ask (NOT temporal sweep). */
  staticAskConcentration: boolean;
  anomalyFlag: boolean;
  status: BookDataStatus;
}

export interface OrderBookDepthLevel {
  price: number;
  qty: number;
}

export interface OrderBookSnapshot {
  bidDepth: OrderBookDepthLevel[];
  askDepth: OrderBookDepthLevel[];
  observedAtMs: number;
  status: BookDataStatus;
  lastUpdateId?: number;
  /** Causal observations strictly preceding this snapshot, supplied by the synchronized book. */
  temporalHistory?: import('./MicroBurstMarketDataTypes').TemporalBookSnapshot[];
}

export interface MicroBurstDecisionPrice {
  readonly price: number;
  readonly source: 'CANDLE';
  readonly observedAtMs: number;
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
  /** Epoch milliseconds when this BTC observation was produced. */
  observedAtMs: number;
}

// ── Candle Set ───────────────────────────────────────────────

export interface MicroBurstCandleSet {
  candles1m: Candle[];
  candles3m: Candle[];
  candles5m: Candle[];
}

// ── Context ──────────────────────────────────────────────────

export interface DataQualityDiagnostics {
  snapshotAtMs: number;
  latestClosed1mAt: number;
  latestClosed3mAt: number;
  latestClosed5mAt: number;
  freshness1mMs: number;
  freshness3mMs: number;
  freshness5mMs: number;
  bookAgeMs: number | null;
  btcAgeMs: number | null;
  bookStatus: BookDataStatus;
  btcStatus: BtcDataStatus;
  closedCandlesOnly: boolean;
  levelsAvailableAt: number | null;
  contextValid: boolean;
  invalidReasons: string[];
}

export interface MicroBurstContext {
  symbol: string;
  timestamp: number;
  /** Latest closed 1m candle close available at timestamp; not a live bid/ask. */
  currentPrice: number;
  /** Immutable, causal price used for every entry decision and reported decision metric. */
  decisionPrice: MicroBurstDecisionPrice;
  candles: MicroBurstCandleSet;
  levels: SupportResistanceResult;
  momentum: MicroMomentumSignal;
  bookPressure: BookPressureSignal;
  btcContext: BtcContext | null;
  structuralClarity: boolean;
  microRegime: MicroRegime;
  dataQuality: DataQualityDiagnostics;
  /** AggTrade taker flow diagnostics from runtime. Undefined when no aggTrade source is available. */
  aggTradeFlow?: {
    buyTakerVolume: number;
    sellTakerVolume: number;
    netTakerFlow: number;
    tradeCount: number;
  };
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
  /** True basis points: 30 = 0.3%. */
  roomToTargetBps?: number;
  /** True basis points: 15 = 0.15%. */
  riskToInvalidationBps?: number;
  rewardRisk?: number;
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
  /** Highest observed price: favorable for LONG, adverse for SHORT. */
  peakPrice: number;
  /** Lowest observed price: adverse for LONG, favorable for SHORT. */
  troughPrice: number;
  structuralInvalidationPrice: number;
  destinationPrice: number;
  currentStopPrice: number | null;
  timeInTradeMs: number;
  momentumDecayFlag: boolean;
  anomalyExitFlag: boolean;
  currentBookPressure: BookPressureSignal | null;
  currentBtcContext: BtcContext | null;
  /** Diagnostic only. It must not affect structural price exits. */
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
  /** True basis points: 30 = 0.3%. */
  btcConflictThresholdBps: number;
  bookAnomalySpreadBps: number;
  bookMinImbalance: number;
  structuralInvalidationBufferBps: number;
  minRoomBps: number;
  minRewardRisk: number;
  candleFreshness1mMaxMs: number;
  candleFreshness3mMaxMs: number;
  candleFreshness5mMaxMs: number;
  bookFreshnessMaxMs: number;
  btcFreshnessMaxMs: number;
  leverageTiers: {
    high: MicroBurstLeverageTierConfig;
    medium: MicroBurstLeverageTierConfig;
  };
  exitProofWindowMs: number;
  exitMinProofExcursionBps: number;
  exitImmediateAdverseBps: number;
  exitMaxHoldMs: number;
  exitBreakEvenActivationBps: number;
  exitTrailingActivationBps: number;
  exitTrailingCallbackBps: number;
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
    minRewardRisk: 1.5,
    candleFreshness1mMaxMs: 120_000,
    candleFreshness3mMaxMs: 360_000,
    candleFreshness5mMaxMs: 600_000,
    bookFreshnessMaxMs: 30_000,
    btcFreshnessMaxMs: 60_000,
    leverageTiers: {
      high: { minConfirmation: 0.75, leverage: 40, positionFraction: 0.09 },
      medium: { minConfirmation: 0.5, leverage: 20, positionFraction: 0.05 },
    },
    exitProofWindowMs: 60_000,
    exitMinProofExcursionBps: 5,
    exitImmediateAdverseBps: 10,
    exitMaxHoldMs: 300_000,
    exitBreakEvenActivationBps: 10,
    exitTrailingActivationBps: 15,
    exitTrailingCallbackBps: 5,
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
  requestedAt: number;
  tradeId: string;
  signalId?: string;
}
