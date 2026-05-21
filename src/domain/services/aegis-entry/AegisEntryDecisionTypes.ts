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
import { AegisRegimeDecision, AegisRegimeGuardConfig } from '../AegisRegimeGuard';

export type AegisEntryPolicyMode = 'OFF' | 'SHADOW' | 'ENFORCE';
export type AegisEntryFinalDecision = 'ALLOW' | 'DENY' | 'WAIT_CONFIRMATION';

export type AegisEntryGuardName =
    | 'regime'
    | 'short_gate'
    | 'entry_quality'
    | 'event_risk'
    | 'decision_brain'
    | 'clean_entry'
    | 'probe_mode';

export type AegisEntryGuardDecision =
    | 'ALLOW'
    | 'DENY'
    | 'WAIT'
    | 'SHADOW_DENY'
    | 'NOT_APPLICABLE';

export interface AegisEntryGuardPolicy {
    enabled: boolean;
    mode: AegisEntryPolicyMode;
}

export interface AegisEntryPolicyRuntimeConfig {
    enabled: boolean;
    guards: Record<AegisEntryGuardName, AegisEntryGuardPolicy>;
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
    finalDecision: AegisEntryFinalDecision;
    finalReason: string;
}

export interface AegisEntryDecisionResult {
    finalDecision: AegisEntryFinalDecision;
    finalReason: string;
    allowed: boolean;
    shouldOpen: boolean;
    deniedBy?: AegisEntryGuardName;
    allowedBy?: AegisEntryGuardName | 'entry_policy';
    guards: AegisEntryGuardResult[];
    trace: AegisEntryDecisionTrace;
    metadata: Record<string, unknown>;
    warnings: string[];
    adjustedLeverage: number;
    adjustedPositionFraction: number;
    decisions: {
        regime?: AegisRegimeDecision;
        shortGate?: AegisShortGateDecision;
        entryQuality?: AegisEntryQualityGateDecision;
        eventRisk?: AegisEventRiskOverlayDecision;
        decisionEnforcement?: AegisDecisionEnforcementDecision;
        cleanEntry?: AegisCleanEntryGuardOutput;
        probeMode?: AegisProbeModeDecision;
    };
}

export function normalizeEntryPolicyMode(mode?: string): AegisEntryPolicyMode {
    const normalized = String(mode || 'OFF').trim().toUpperCase();
    if (normalized === 'SHADOW' || normalized === 'ENFORCE') return normalized;
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
