import { Side } from '../../types';
import { AegisTradingSignal, AegisDecisionBrainBlock, AegisEntryQualityModelBlock, AegisEventRiskAutoBlock } from '../AegisStrategy';
import { AegisMicroLiveGateDecision } from '../AegisMicroLiveGate';
import {
    AegisEntryQualityGateCandle,
    AegisEntryQualityGateConfig,
    AegisEntryQualityGateDecision,
    AegisEntryQualityGateMode
} from '../AegisEntryQualityGate';
import { AegisEventRiskOverlayConfig, AegisEventRiskOverlayDecision, EventRiskMode } from '../AegisEventRiskOverlay';
import { AegisDecisionEnforcementDecision, AegisDecisionEnforcementRuntimeConfig } from '../AegisDecisionEnforcement';
import { AegisCleanEntryGuardConfig, AegisCleanEntryGuardOutput } from '../AegisCleanEntryGuard';
import { AegisProbeModeDecision, AegisProbeModeRuntimeConfig } from '../AegisProbeMode';
import { AegisShortGateConfig, AegisShortGateDecision } from '../AegisShortGate';
import { AegisRegimeDecision, AegisRegimeGuardConfig, AegisRegimeLabel } from '../AegisRegimeGuard';

export type AegisEntryPolicyMode = 'OFF' | 'SHADOW' | 'ENFORCE' | 'ENFORCE_PROBE_LONG_CRITICAL';
export type AegisEntryFinalDecision = 'ALLOW' | 'DENY' | 'WAIT_CONFIRMATION';
export type AegisLongRiskAction = 'BLOCK' | 'SHADOW';
export type AegisLongRiskBlockLevel = 'HIGH' | 'CRITICAL';

export type AegisEntryGuardName =
    | 'regime'
    | 'regime_context'
    | 'short_gate'
    | 'entry_quality'
    | 'event_risk'
    | 'decision_brain'
    | 'clean_entry'
    | 'probe_mode'
    | 'long_risk_shadow'
    | 'e4_tail_risk';

export type AegisEntryGuardDecision =
    | 'ALLOW'
    | 'DENY'
    | 'WAIT'
    | 'SHADOW_ALLOW'
    | 'SHADOW_DENY'
    | 'NOT_APPLICABLE';

export interface AegisEntryGuardPolicy {
    enabled: boolean;
    mode: AegisEntryPolicyMode;
    probeLongCriticalAction?: AegisLongRiskAction;
    probeLongHighAction?: AegisLongRiskAction;
    aegisLongCriticalAction?: AegisLongRiskAction;
    minRiskLevelToBlockProbe?: AegisLongRiskBlockLevel;
    blockOnlyProbeMode?: boolean;
    blockOnlyLong?: boolean;
}

export interface AegisEntryPolicyRuntimeConfig {
    enabled: boolean;
    guards: Record<AegisEntryGuardName, AegisEntryGuardPolicy>;
}

export type AegisEntryFinalStrategy = 'aegis_turbo' | 'none';

export type AegisRegimeTrendDirection = 'UP' | 'DOWN' | 'NEUTRAL' | 'UNKNOWN';
export type AegisRegimeVolatilityState = 'LOW' | 'NORMAL' | 'HIGH' | 'UNKNOWN';
export type AegisRegimeVolumeState = 'LOW' | 'NORMAL' | 'HIGH' | 'UNKNOWN';

export interface AegisRegimeContextIndicators {
    emaFast?: number;
    emaMid?: number;
    emaSlow?: number;
    emaFastSlope?: number;
    atrPct?: number;
    atrPercentile?: number;
    volumeRatio?: number;
    bollingerWidth?: number;
    adx?: number;
    choppiness?: number;
}

export interface AegisRegimeContext {
    label: AegisRegimeLabel;
    confidence: number;
    momentumLongAllowed: boolean;
    momentumShortAllowed: boolean;
    trendDirection: AegisRegimeTrendDirection;
    chopRisk: number;
    exhaustionRisk: number;
    volatilityState: AegisRegimeVolatilityState;
    volumeState: AegisRegimeVolumeState;
    reasons: string[];
    indicators: AegisRegimeContextIndicators;
}

export interface AegisRegimeContextRuntimeConfig {
    enabled: boolean;
    mode: AegisEntryPolicyMode;
    timeframe: string;
    indicators: {
        emaFast: number;
        emaMid: number;
        emaSlow: number;
        atrWindow: number;
        volumeWindow: number;
        bollingerWindow: number;
        adxWindow: number;
        choppinessWindow: number;
    };
    thresholds: {
        maxChoppinessForMomentum: number;
        minAdxForMomentum: number;
        minVolumeRatioForMomentum: number;
        maxAtrPercentileForAggressive: number;
        maxExhaustionScore: number;
    };
}

export interface AegisMomentumRideSideRuntimeConfig {
    enabled: boolean;
    leverage: number;
    positionFraction: number;
    minTurboScore: number;
    minVolumeRatio: number;
    momentumCandles: 2 | 3;
    maxTailRiskScore: number;
    allowedRegimes: AegisRegimeLabel[];
    requireCloseNearExtreme: boolean;
    minCloseLocation: number;
    maxWickRatio: number;
    maxOverextensionPct: number;
}

export interface AegisMomentumRideSymbolRuntimeConfig {
    enabled: boolean;
    mode: AegisEntryPolicyMode;
    long: AegisMomentumRideSideRuntimeConfig;
    short: AegisMomentumRideSideRuntimeConfig;
}

export interface AegisMomentumRideRuntimeConfig {
    enabled: boolean;
    mode: AegisEntryPolicyMode;
    researchMode: boolean;
    standaloneMainReplica?: boolean;
    aegisFallbackEnabled?: boolean;
    regimeFilter: {
        enabled: boolean;
        useAsGate: boolean;
        recordMetadata: boolean;
        ignoreForEntry: boolean;
    };
    allowWhenAegisDenied: boolean;
    requireAegisDirectionConfirmation: boolean;
    allowMomentumAgainstAegis: boolean;
    requireBtcEthNotContradicting: boolean;
    requireBtcEthConfirmation: boolean;
    symbols: Record<string, AegisMomentumRideSymbolRuntimeConfig>;
    /**
     * Strategy-owned protection. Optional only for backward-compatible test/fixture
     * construction; ConfigLoader always normalizes it in production.
     */
    protection?: {
        hardStopRoe: number;
        takeProfitRoe: number;
        breakEvenRoe: number;
        trailingActivationRoe: number;
        trailingCallbackRoe: number;
        maxHoldMs: number;
    };
    safetyCaps: {
        maxLeverage: number;
        maxPositionFraction: number;
        maxOpenMomentumPositions: number;
        maxTotalOpenPositionsWhenMomentum: number;
        maxMomentumTradesPerDay: number;
        maxConsecutiveMomentumLosses: number;
        cooldownAfterLossMinutes: number;
        disableSymbolAfterStopLossMinutes: number;
        /** Backward-compatible optional fields; ConfigLoader supplies defaults. */
        maxLiquidityStress?: number;
        dailyLossStopPct?: number;
        requireBrackets: boolean;
        requireProfitProtection: boolean;
    };
}

export interface AegisEntryQualityRuleGateContext {
    enabled: boolean;
    mode: AegisEntryQualityGateMode;
    config: AegisEntryQualityGateConfig;
    recentCandles?: AegisEntryQualityGateCandle[];
    currentPrice?: number;
    emaFast?: number;
    atrPct?: number;
    atrPercentile?: number;
}

export interface AegisEntryEventRiskContext {
    enabled: boolean;
    mode: EventRiskMode;
    enforce: boolean;
    config?: AegisEventRiskOverlayConfig;
    btcAction?: string;
    btcScore?: number;
    ethAction?: string;
    ethScore?: number;
    isAltSymbol: boolean;
}

export interface AegisEntryOperationalContext {
    consecutiveLosses: number;
    tradesToday: number;
    openPositionsCount: number;
    openMomentumPositions?: number;
    openProbePositions: number;
    sameSymbolPositionExists: boolean;
    recentStopLossMinutes?: number;
    lastStopLossAt?: number;
    lastProbeAt?: number;
    probeEntryTimestamps?: number[];
    timestamp: number;
}

export interface AegisEntryContext {
    symbol: string;
    side: Side;
    rawAction?: string;
    finalAction?: string;
    turboScore: number;
    votes?: { long?: number; short?: number; neutral?: number };
    setupGrade?: string;
    leverage: number;
    requestedPositionFraction: number;
    basePositionFraction: number;
    signal: AegisTradingSignal;
    gate: AegisMicroLiveGateDecision;
    decisionBrain?: {
        decision?: string;
        confidence?: string | number;
        reason?: string;
        block?: AegisDecisionBrainBlock | null;
    };
    entryQuality: {
        model?: AegisEntryQualityModelBlock;
        recommendation?: string;
        entryQualityScore?: number | null;
        tailRiskScore?: number | null;
        featureStatus?: string;
        featureParityPct?: number | null;
        missingFeaturesCount?: number | null;
        modelScope?: string;
        modelVersion?: string;
        ruleGate: AegisEntryQualityRuleGateContext;
    };
    eventRisk: AegisEntryEventRiskContext & {
        reason?: string;
        wouldBlock?: boolean;
        confidence?: string | number;
        auto?: AegisEventRiskAutoBlock;
    };
    regime?: {
        config: AegisRegimeGuardConfig;
        contextConfig?: AegisRegimeContextRuntimeConfig;
        btcAction?: string;
        btcScore?: number;
        btcVotes?: { long?: number; short?: number; neutral?: number };
        ethAction?: string;
        ethScore?: number;
        ethVotes?: { long?: number; short?: number; neutral?: number };
        marketDistribution?: {
            long?: number;
            short?: number;
            hold?: number;
        };
        snapshotAgeSeconds?: number;
    };
    regimeContext?: AegisRegimeContext;
    cleanEntry?: {
        metadata?: AegisCleanEntryGuardOutput['metadata'];
        config: AegisCleanEntryGuardConfig;
    };
    probe?: {
        metadata?: AegisProbeModeDecision['metadata'];
        config: AegisProbeModeRuntimeConfig;
    };
    shortGate: {
        config: AegisShortGateConfig;
    };
    decisionEnforcement: {
        config: AegisDecisionEnforcementRuntimeConfig;
        riskOffTailMax?: number;
    };
    e4TailRisk?: {
        enabled: boolean;
        mode: AegisEntryPolicyMode;
        score?: number | null;
        threshold?: number;
        riskDecision?: 'ALLOW' | 'BLOCK';
        featureHash?: string;
        featureAvailableAt?: string;
        sourceFeedLagMs?: Record<string, number>;
        evaluationLatencyMs?: number;
        modelVersion?: string;
    };
    operational: AegisEntryOperationalContext;
}

export interface AegisEntryGuardResult {
    name: AegisEntryGuardName;
    enabled: boolean;
    mode: AegisEntryPolicyMode;
    decision: AegisEntryGuardDecision;
    reason: string;
    wouldBlock: boolean;
    enforced: boolean;
    metadata: Record<string, unknown>;
}

export interface AegisEntryDecisionTrace {
    symbol: string;
    side: Side;
    turbo: {
        score: number;
        votes?: AegisEntryContext['votes'];
        setupGrade?: string;
    };
    guards: Record<string, AegisEntryGuardResult>;
    strategyCandidates: AegisEntryStrategyCandidates;
    finalDecision: AegisEntryFinalDecision;
    finalReason: string;
    finalStrategy: AegisEntryFinalStrategy;
    strategy: AegisEntryFinalStrategy;
}

export interface AegisEntryStrategyCandidate {
    decision: AegisEntryFinalDecision | AegisEntryGuardDecision;
    reason: string;
}

export interface AegisEntryStrategyCandidates {
    aegis_turbo: AegisEntryStrategyCandidate;
}

export interface AegisEntryDecisionResult {
    finalDecision: AegisEntryFinalDecision;
    finalReason: string;
    allowed: boolean;
    shouldOpen: boolean;
    deniedBy?: AegisEntryGuardName;
    allowedBy?: AegisEntryGuardName | 'entry_policy';
    finalStrategy: AegisEntryFinalStrategy;
    strategy: AegisEntryFinalStrategy;
    strategyCandidates: AegisEntryStrategyCandidates;
    guards: AegisEntryGuardResult[];
    trace: AegisEntryDecisionTrace;
    metadata: Record<string, unknown>;
    warnings: string[];
    adjustedLeverage: number;
    adjustedPositionFraction: number;
    decisions: {
        regime?: AegisRegimeDecision;
        regimeContext?: AegisRegimeContext;
        shortGate?: AegisShortGateDecision;
        entryQuality?: AegisEntryQualityGateDecision;
        eventRisk?: AegisEventRiskOverlayDecision;
        decisionEnforcement?: AegisDecisionEnforcementDecision;
        cleanEntry?: AegisCleanEntryGuardOutput;
        probeMode?: AegisProbeModeDecision;
        e4TailRisk?: {
            available: boolean;
            score: number | null;
            threshold: number;
            decision: 'ALLOW' | 'BLOCK';
            reason: string;
            modelVersion: string;
            featureHash: string;
        };
    };
}

export function normalizeEntryPolicyMode(mode?: string): AegisEntryPolicyMode {
    const normalized = String(mode || 'OFF').trim().toUpperCase();
    if (normalized === 'SHADOW' || normalized === 'ENFORCE' || normalized === 'ENFORCE_PROBE_LONG_CRITICAL') return normalized;
    return 'OFF';
}

export function guardDisabledResult(name: AegisEntryGuardName, reason = `${name}_disabled`): AegisEntryGuardResult {
    return {
        name,
        enabled: false,
        mode: 'OFF',
        decision: 'NOT_APPLICABLE',
        reason,
        wouldBlock: false,
        enforced: false,
        metadata: { enabled: false, mode: 'OFF', reason }
    };
}

export function isGuardEnforced(policy: AegisEntryGuardPolicy): boolean {
    return policy.enabled === true && policy.mode === 'ENFORCE';
}

export function isGuardShadow(policy: AegisEntryGuardPolicy): boolean {
    return policy.enabled === true && policy.mode === 'SHADOW';
}
