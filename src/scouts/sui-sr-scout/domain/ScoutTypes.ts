import type { Side } from '../../../core/types';

// ── Universe ──────────────────────────────────────────────────────
export const SCOUT_UNIVERSE = ['BTCUSDT', 'SUIUSDT'] as const;
export type ScoutSymbol = (typeof SCOUT_UNIVERSE)[number];
export const TRADEABLE_SYMBOL: ScoutSymbol = 'SUIUSDT';
export const CONTEXT_SYMBOL: ScoutSymbol = 'BTCUSDT';

// ── Decisions ─────────────────────────────────────────────────────
export const DECISIONS = [
  'ALLOW_REJECTION_LONG',
  'ALLOW_REJECTION_SHORT',
  'WAIT_BREAKOUT_PULLBACK',
  'BLOCK_BREAKOUT_RISK',
  'NO_TRADE',
] as const;
export type ScoutDecision = (typeof DECISIONS)[number];

// ── Execution mode ────────────────────────────────────────────────
export const EXECUTION_MODES = ['OBSERVE', 'LIVE_CANARY'] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

// ── Feature schema ────────────────────────────────────────────────
export const FEATURE_SCHEMA_VERSION = 1;

export interface FeatureVector {
  readonly schemaVersion: typeof FEATURE_SCHEMA_VERSION;
  readonly symbol: ScoutSymbol;
  readonly timestamp: number;
  readonly level: LevelGeometryFeatures;
  readonly price: PriceVolatilityFeatures;
  readonly flow: OrderFlowFeatures;
  readonly book: BookFeatures;
  readonly futures: FuturesContextFeatures;
  readonly btcContext: BtcContextFeatures;
  /** Explicit missing/stale inputs; a decision may not silently treat these as zero. */
  readonly unavailableFeatures: readonly FeatureUnavailableReason[];
}

export interface FeatureUnavailableReason {
  readonly feature: string;
  readonly reason: 'MISSING' | 'STALE' | 'UNSUPPORTED';
  readonly observedAtMs: number | null;
}

export interface LevelGeometryFeatures {
  readonly side: Side | null;
  readonly zoneHigh: number;
  readonly zoneLow: number;
  readonly zoneWidthTicks: number;
  readonly zoneScore: number;
  readonly touchCount: number;
  readonly ageMs: number;
  readonly timeSinceLastTouchMs: number;
  readonly distanceTicks: number;
  readonly distanceAtr: number;
  readonly bodyWickRatio: number;
  readonly closeLocation: number;
  readonly compressionBefore: number | null;
  readonly reclaimBeyond: boolean | null;
  readonly roomToTargetTicks: number;
  readonly roomToOpposingTicks: number;
}

export interface PriceVolatilityFeatures {
  readonly return1m: number;
  readonly return3m: number;
  readonly return5m: number;
  readonly realizedVol: number;
  readonly atr14_3m: number;
  readonly rangePercentile: number;
  readonly emaSlope: number;
  readonly emaDistance: number;
  readonly rsi14: number;
  readonly volumeRelativeMedian: number;
  readonly volumeAcceleration: number;
  readonly candleSequence: number;
  readonly higherHighLowerLow: number;
  readonly momentumAcceleration: number;
}

export interface OrderFlowFeatures {
  readonly takerBuyRatio5s: number;
  readonly takerBuyRatio30s: number;
  readonly takerBuyRatio1m: number;
  readonly takerBuyRatio3m: number;
  readonly signedNotional1m: number;
  readonly tradeIntensity1m: number;
  readonly consecutiveAggressiveFlow: number;
}

export interface BookFeatures {
  readonly spreadBps: number;
  readonly topBookImbalance: number;
  readonly multiLevelImbalance: number;
  readonly imbalanceChange: number;
  readonly bestBidDepletion: number;
  readonly bestAskDepletion: number;
  readonly visibleAbsorptionAtZone: number;
}

export interface FuturesContextFeatures {
  readonly fundingRate: number | null;
  readonly fundingTimestamp: number | null;
  readonly openInterestChange3m: number | null;
  readonly openInterestTimestamp: number | null;
  readonly basisPct: number | null;
  readonly basisTimestamp: number | null;
}

export interface BtcContextFeatures {
  readonly return1m: number;
  readonly return3m: number;
  readonly realizedVol: number;
  readonly takerImbalance: number;
  readonly rangeExpansion: number;
  readonly directionRelative: number;
  readonly aggressiveAgainstTrade: boolean;
  readonly timestamp: number;
}

// ── Level detection ───────────────────────────────────────────────
export interface SrZone {
  readonly id: string;
  readonly side: 'SUPPORT' | 'RESISTANCE';
  readonly high: number;
  readonly low: number;
  readonly score: number;
  readonly touchCount: number;
  readonly firstTouchMs: number;
  readonly lastTouchMs: number;
  readonly lastCloseMs: number;
  readonly avgRejectionMagnitude: number;
  readonly totalVolume: number;
  readonly broken: boolean;
  readonly brokenAtMs: number | null;
}

export interface LevelCandidateEvent {
  readonly timestamp: number;
  readonly symbol: ScoutSymbol;
  readonly zone: SrZone;
  readonly eventType: 'APPROACH' | 'TOUCH' | 'RECLAIM' | 'RETEST' | 'BREAKOUT';
  readonly priceAtEvent: number;
  readonly atr: number;
}

// ── Config ────────────────────────────────────────────────────────
export interface SuiSrScoutConfig {
  readonly enabled: boolean;
  readonly executionMode: ExecutionMode;
  readonly liveEnabled: boolean;
  readonly symbol: ScoutSymbol;
  readonly contextSymbol: ScoutSymbol;
  readonly maxOpenPositions: number;
  readonly maxQuoteNotional: number;
  readonly maxLeverage: number;
  readonly maxRiskPerTradeBps: number;
  readonly maxDailyLossBps: number;
  readonly cooldownAfterStopMs: number;
  readonly minNetRMultiple: number;
  readonly tickIntervalMs: number;
  readonly feedStaleThresholdMs: number;
  readonly feedGapThresholdMs: number;
  readonly candleIntervals: readonly string[];
  readonly srZoneAtrTolerance: number;
  readonly srMinTouchCount: number;
  readonly srZoneScoreMin: number;
  readonly breakConfirmationCandles: number;
  readonly btcAggressiveThreshold: number;
  readonly killSwitch: boolean;
}

// ── Health ────────────────────────────────────────────────────────
export type FeedHealth = 'HEALTHY' | 'STALE' | 'GAPPED' | 'OUT_OF_ORDER' | 'UNSYNCHRONIZED';

export interface SymbolHealth {
  readonly feed: FeedHealth;
  readonly lastEventAtMs: number;
  readonly eventCount: number;
  readonly gapCount: number;
  readonly outOfOrderCount: number;
  readonly lastCandleTime: number;
  readonly reconnectionCount: number;
  readonly ready: boolean;
}

export interface ScoutHealth {
  readonly processState: 'STARTING' | 'NOT_READY' | 'RUNNING' | 'STOPPING' | 'STOPPED';
  readonly symbols: Record<ScoutSymbol, SymbolHealth>;
  readonly activePosition: boolean;
  readonly activeOrders: number;
  readonly modelArtifactId: string | null;
  readonly modelSchemaVersion: number | null;
  readonly decisionsByOutcome: Record<ScoutDecision, number>;
  readonly killSwitch: boolean;
  readonly uptimeMs: number;
  readonly startedAtMs: number;
  readonly warmup: WarmupStatus;
}

export interface WarmupStatus {
  readonly ready: boolean;
  readonly completedAtMs: number | null;
  readonly failureReason: string | null;
  readonly candles1m: Record<ScoutSymbol, number>;
  readonly candles3m: Record<ScoutSymbol, number>;
}

export interface ScoutPositionState {
  readonly status: 'CONFIRMED_FLAT' | 'CONFIRMED_OPEN' | 'UNKNOWN' | 'UNPROTECTED' | 'PARTIAL_FILL';
  readonly checkedAtMs: number;
  readonly openPositionCount: number;
  readonly openOrderCount: number;
  readonly stopConfirmed: boolean;
  readonly reason: string | null;
}

// ── Evidence journal ──────────────────────────────────────────────
export interface EvidenceEntry {
  readonly timestamp: number;
  readonly decisionId: string;
  readonly symbol: ScoutSymbol;
  readonly event: LevelCandidateEvent;
  readonly featureVector: FeatureVector;
  readonly baselineDecision: ScoutDecision;
  readonly modelDecision: ScoutDecision | null;
  readonly modelScore: number | null;
  readonly modelArtifactId: string | null;
  readonly finalDecision: ScoutDecision;
  readonly blockReasons: readonly string[];
  readonly intendedStop: number | null;
  readonly intendedTarget: number | null;
  readonly intendedRR: number | null;
  readonly orderResult: OrderResult | null;
  readonly mfe: number | null;
  readonly mae: number | null;
  readonly netResult: number | null;
  readonly provenance: Provenance;
}

export interface OrderResult {
  readonly orderId: string;
  readonly side: Side;
  readonly quantity: number;
  readonly avgPrice: number;
  readonly stopOrderId: string | null;
  readonly stopConfirmed: boolean;
  readonly closeReason: string | null;
  readonly closedAtMs: number | null;
}

export interface Provenance {
  readonly featureSchemaVersion: number;
  readonly modelArtifactId: string | null;
  readonly modelVersion: string | null;
  readonly configHash: string;
  readonly evaluatedAtMs: number;
}

// ── ML artifact ───────────────────────────────────────────────────
export interface ModelPrediction {
  readonly probability: number;
  readonly artifactId: string;
  readonly featureSchemaVersion: number;
}

export interface ModelArtifact {
  readonly id: string;
  readonly version: string;
  readonly featureSchemaVersion: number;
  readonly type: 'RULE_BASELINE' | 'LIGHTGBM' | 'XGBOOST' | 'ONNX';
  predict(features: FeatureVector): ModelPrediction;
}
