import { Candle, Side } from '../../types';
import { StrategyIdentity } from '../../strategy/StrategyIdentity';

export type LeverageTier = 'HIGH_CONFIRMATION' | 'MEDIUM_CONFIRMATION' | 'NO_TRADE';

export type MicroRegime = 'TRENDING_UP' | 'TRENDING_DOWN' | 'RANGING' | 'VOLATILE';

export type StructuralPosition = 'near_support' | 'near_resistance' | 'mid_range';

export type MicroBurstExitReason =
  | 'EARLY_FAILURE'
  | 'ANOMALY'
  | 'TARGET'
  | 'TRAILING'
  | 'MAX_HOLD'
  | 'BREAK_EVEN'
  | 'HOLD';

export interface SupportResistanceLevel {
  price: number;
  type: 'support' | 'resistance';
  strength: number;
  touches: number;
  lastTouchIndex: number;
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

export interface MicroMomentumSignal {
  direction: Side | 'NEUTRAL';
  strength: number;
  continuationScore: number;
  slope1m: number;
  slope3m: number;
  slope5m: number;
  bodyStrength: number;
  wickRejectionUpper: number;
  wickRejectionLower: number;
  volumeExpansion: boolean;
  candleSequenceQuality: number;
}

export interface BookPressureSignal {
  spreadBps: number;
  topOfBookImbalance: number;
  imbalanceSlope: number;
  absorptionDetected: boolean;
  sweepDetected: boolean;
  anomalyFlag: boolean;
  degradedMode: boolean;
}

export interface BtcContext {
  ret1m: number;
  ret3m: number;
  ret5m: number;
  acceleration: number;
  conflictFlag: boolean;
  direction: Side | 'NEUTRAL';
}

export interface MicroBurstCandleSet {
  candles1m: Candle[];
  candles3m: Candle[];
  candles5m: Candle[];
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
}

export interface MicroBurstEntryDecision {
  action: 'NO_TRADE' | 'ENTRY_INTENT';
  side?: Side;
  leverageTier?: LeverageTier;
  leverage?: number;
  positionFraction?: number;
  stopInvalidationPrice?: number;
  targetPrice?: number;
  reason: string;
  confirmationStrength: number;
  diagnostics: Record<string, unknown>;
}

export interface MicroBurstExitContext {
  unrealizedRoe: number;
  favorableExcursion: number;
  adverseExcursion: number;
  timeInTradeMs: number;
  momentumDecayFlag: boolean;
  anomalyExitFlag: boolean;
  currentBookPressure: BookPressureSignal | null;
  currentBtcContext: BtcContext | null;
}

export interface MicroBurstExitDecision {
  action: 'HOLD' | 'CLOSE_MARKET' | 'MOVE_STOP';
  reason: MicroBurstExitReason;
  requestedStopPrice?: number;
  diagnostics: Record<string, unknown>;
}

export interface MicroBurstLeverageTierConfig {
  minConfirmation: number;
  leverage: number;
  positionFraction: number;
}

export interface MicroBurstConfig {
  srLookbackBars: number;
  srClusterToleranceBps: number;
  srMinStrength: number;
  nearLevelThresholdBps: number;
  momentumSlopePeriod: number;
  momentumMinContinuationScore: number;
  btcConflictThreshold: number;
  bookAnomalySpreadBps: number;
  bookMinImbalance: number;
  leverageTiers: {
    high: MicroBurstLeverageTierConfig;
    medium: MicroBurstLeverageTierConfig;
  };
  exitEarlyFailureWindowMs: number;
  exitEarlyFailureMinExcursionRoe: number;
  exitMaxHoldMs: number;
  exitBreakEvenThresholdRoe: number;
  exitTrailingActivationRoe: number;
  exitTrailingCallbackRoe: number;
}

export function defaultMicroBurstConfig(): MicroBurstConfig {
  return {
    srLookbackBars: 20,
    srClusterToleranceBps: 15,
    srMinStrength: 0.3,
    nearLevelThresholdBps: 50,
    momentumSlopePeriod: 5,
    momentumMinContinuationScore: 0.5,
    btcConflictThreshold: 0.3,
    bookAnomalySpreadBps: 20,
    bookMinImbalance: 0.2,
    leverageTiers: {
      high: { minConfirmation: 0.75, leverage: 40, positionFraction: 0.09 },
      medium: { minConfirmation: 0.50, leverage: 20, positionFraction: 0.05 },
    },
    exitEarlyFailureWindowMs: 60_000,
    exitEarlyFailureMinExcursionRoe: 0.05,
    exitMaxHoldMs: 300_000,
    exitBreakEvenThresholdRoe: 0.10,
    exitTrailingActivationRoe: 0.15,
    exitTrailingCallbackRoe: 0.05,
  };
}
