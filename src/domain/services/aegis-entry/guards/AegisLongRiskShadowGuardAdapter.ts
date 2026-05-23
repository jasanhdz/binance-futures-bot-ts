import { Side } from '../../../types';
import {
    AegisEntryContext,
    AegisEntryPolicyMode,
    AegisEntryGuardPolicy,
    AegisEntryGuardResult,
    isGuardShadow
} from '../AegisEntryDecisionTypes';

export type AegisLongRiskShadowRiskLevel = 'LOW' | 'MODERATE' | 'HIGH' | 'CRITICAL';
export type AegisLongRiskShadowSuggestedAction =
    | 'OBSERVE'
    | 'REDUCE_SIZE_SHADOW'
    | 'DELAY_ONE_CANDLE_SHADOW'
    | 'WOULD_BLOCK_SHADOW';

export interface AegisLongRiskShadowMarketWeakness {
    belowEma25?: boolean;
    return30m?: number;
    return60m?: number;
    closeLocation?: number;
    volumeRatio?: number;
}

export interface AegisLongRiskShadowInput {
    symbol: string;
    side: Side;
    entryQualityReason?: string;
    entryQualityRecommendation?: string;
    entryQualityScore?: number | null;
    tailRiskScore?: number | null;
    cleanEntryDecision?: string;
    eventRiskMode?: string;
    eventRiskWouldBlock?: boolean;
    btcAction?: string;
    btcScore?: number;
    ethAction?: string;
    ethScore?: number;
    regimeLogged?: string;
    regimeWouldBlock?: boolean;
    regimeEngineV2Environment?: string;
    regimeEngineV2TechnicalRegime?: string;
    regimeEngineV2TransitionRisk?: string;
    marketWeakness?: AegisLongRiskShadowMarketWeakness;
}

export interface AegisLongRiskShadowAssessment extends AegisLongRiskShadowInput {
    enabled: boolean;
    mode: AegisEntryPolicyMode;
    decision: 'ALLOW' | 'SHADOW_DENY' | 'NOT_APPLICABLE';
    reason: string;
    wouldBlock: boolean;
    enforced: boolean;
    enforcementApplied: boolean;
    enforcementScope: 'none' | 'probe_long_critical';
    blockedProbeLong: boolean;
    actionTaken: 'SHADOW' | 'BLOCK';
    riskScore: number;
    riskLevel: AegisLongRiskShadowRiskLevel;
    reasons: string[];
    suggestedAction: AegisLongRiskShadowSuggestedAction;
    wouldHaveWarned: boolean;
    wouldHaveReducedSize: boolean;
    wouldHaveDelayed: boolean;
    wouldHaveBlockedShadow: boolean;
}

export interface AegisLongRiskShadowGuardAdapterInput {
    context: AegisEntryContext;
    policy: AegisEntryGuardPolicy;
    guards: Partial<Record<string, AegisEntryGuardResult>>;
}

export class AegisLongRiskShadowGuardAdapter {
    static evaluate(input: AegisLongRiskShadowGuardAdapterInput): AegisEntryGuardResult {
        if (input.policy.enabled !== true || input.policy.mode === 'OFF') {
            return {
                name: 'long_risk_shadow',
                enabled: false,
                mode: 'OFF',
                decision: 'NOT_APPLICABLE',
                reason: 'long_risk_shadow_disabled',
                wouldBlock: false,
                enforced: false,
                metadata: { enabled: false, mode: 'OFF', reason: 'long_risk_shadow_disabled' }
            };
        }

        const assessment = {
            ...evaluateAegisLongRiskShadow(buildInput(input)),
            mode: input.policy.mode,
            enforced: false,
            enforcementApplied: false,
            enforcementScope: 'none' as const,
            blockedProbeLong: false,
            actionTaken: 'SHADOW' as const
        };
        return {
            name: 'long_risk_shadow',
            enabled: true,
            mode: input.policy.mode,
            decision: assessment.decision,
            reason: assessment.reason,
            wouldBlock: assessment.wouldBlock,
            enforced: false,
            metadata: {
                longRiskShadow: assessment,
                shadowAssessment: {
                    riskScore: assessment.riskScore,
                    riskLevel: assessment.riskLevel,
                    reasons: assessment.reasons,
                    suggestedAction: assessment.suggestedAction,
                    wouldBlock: assessment.wouldBlock
                },
                enforcementApplied: false,
                enforcementScope: 'none',
                blockedProbeLong: false,
                actionTaken: 'SHADOW',
                shadow: isGuardShadow(input.policy) || input.policy.mode === 'ENFORCE' || input.policy.mode === 'ENFORCE_PROBE_LONG_CRITICAL'
            }
        };
    }
}

export function evaluateAegisLongRiskShadow(input: AegisLongRiskShadowInput): AegisLongRiskShadowAssessment {
    if (input.side !== 'LONG') {
        return buildAssessment(input, 0, [], 'NOT_APPLICABLE', 'long_risk_shadow_not_applicable');
    }

    let score = 0;
    const reasons: string[] = [];
    const entryQualityReason = lower(input.entryQualityReason);
    const entryQualityRecommendation = upper(input.entryQualityRecommendation);
    if (entryQualityReason.includes('insufficient_data') || entryQualityRecommendation === 'ALLOW_SHADOW') {
        score += 0.25;
        reasons.push('long_risk_shadow_entry_quality_insufficient');
    }

    const eventRiskMode = upper(input.eventRiskMode);
    if (input.eventRiskWouldBlock === true || eventRiskMode === 'CAUTION') {
        score += 0.20;
        reasons.push('long_risk_shadow_event_risk_caution');
    }

    const cleanEntryDecision = upper(input.cleanEntryDecision);
    if (cleanEntryDecision === 'WAIT' || cleanEntryDecision === 'WAIT_CONFIRMATION') {
        score += 0.20;
        reasons.push('long_risk_shadow_clean_entry_wait');
    }

    if (input.regimeWouldBlock === true) {
        score += 0.25;
        reasons.push('long_risk_shadow_weak_regime');
    }

    const environment = upper(input.regimeEngineV2Environment);
    if (environment === 'AVOID_MOMENTUM' || environment === 'WATCH_SHORT_MOMENTUM' || environment === 'ALLOW_SHORT_MOMENTUM') {
        score += 0.30;
        reasons.push('long_risk_shadow_weak_regime');
    }

    const technicalRegime = upper(input.regimeEngineV2TechnicalRegime);
    if (technicalRegime.includes('MOMENTUM_DOWN') || technicalRegime.includes('TREND_DOWN') || technicalRegime.includes('EXHAUSTED') || technicalRegime.includes('CHOP')) {
        score += 0.20;
        reasons.push('long_risk_shadow_down_momentum');
    }

    if (upper(input.regimeEngineV2TransitionRisk) === 'HIGH') {
        score += 0.20;
        reasons.push('long_risk_shadow_transition_high');
    }

    if (isNotConfirmingLong(input.btcAction)) {
        score += 0.15;
        reasons.push('long_risk_shadow_btc_eth_not_confirmed');
    }

    if (isAlt(input.symbol) && isNotConfirmingLong(input.ethAction)) {
        score += 0.15;
        reasons.push('long_risk_shadow_btc_eth_not_confirmed');
    }

    const market = input.marketWeakness ?? {};
    if (isFiniteNumber(market.return30m) && market.return30m < 0) {
        score += 0.15;
        reasons.push('long_risk_shadow_down_momentum');
    }
    if (isFiniteNumber(market.return60m) && market.return60m < 0) {
        score += 0.15;
        reasons.push('long_risk_shadow_down_momentum');
    }
    if (isFiniteNumber(market.closeLocation) && market.closeLocation < 0.30) {
        score += 0.10;
        reasons.push('long_risk_shadow_down_momentum');
    }
    if (market.belowEma25 === true) {
        score += 0.10;
        reasons.push('long_risk_shadow_down_momentum');
    }

    const uniqueReasons = Array.from(new Set(reasons));
    const riskScore = Math.min(1, Number(score.toFixed(4)));
    const decision = riskScore >= 0.30 ? 'SHADOW_DENY' : 'ALLOW';
    const reason = decision === 'ALLOW'
        ? 'long_risk_shadow_clear'
        : uniqueReasons.length > 1 ? 'long_risk_shadow_multi_factor' : uniqueReasons[0] ?? 'long_risk_shadow_multi_factor';

    return buildAssessment(input, riskScore, uniqueReasons, decision, reason);
}

function buildAssessment(
    input: AegisLongRiskShadowInput,
    riskScore: number,
    reasons: string[],
    decision: AegisLongRiskShadowAssessment['decision'],
    reason: string
): AegisLongRiskShadowAssessment {
    const riskLevel = riskLevelFor(riskScore);
    const suggestedAction = suggestedActionFor(riskLevel);
    const wouldBlock = decision === 'SHADOW_DENY';
    return {
        ...input,
        enabled: true,
        mode: 'SHADOW',
        decision,
        reason,
        wouldBlock,
        enforced: false,
        enforcementApplied: false,
        enforcementScope: 'none',
        blockedProbeLong: false,
        actionTaken: 'SHADOW',
        riskScore,
        riskLevel,
        reasons,
        suggestedAction,
        wouldHaveWarned: riskLevel === 'HIGH' || riskLevel === 'CRITICAL',
        wouldHaveReducedSize: riskLevel === 'MODERATE' || riskLevel === 'HIGH' || riskLevel === 'CRITICAL',
        wouldHaveDelayed: riskLevel === 'HIGH' || riskLevel === 'CRITICAL',
        wouldHaveBlockedShadow: riskLevel === 'CRITICAL'
    };
}

function buildInput(input: AegisLongRiskShadowGuardAdapterInput): AegisLongRiskShadowInput {
    const context = input.context;
    const entryQuality = input.guards.entry_quality;
    const cleanEntry = input.guards.clean_entry;
    const eventRisk = input.guards.event_risk;
    const regime = input.guards.regime;
    const momentumRide = input.guards.momentum_ride;
    const momentumMetadata = asRecord(momentumRide?.metadata.momentumRide);
    const regimeEngineV2 = asRecord(momentumMetadata?.regimeEngineV2);
    const marketWeakness = marketWeaknessFromContext(context);
    return {
        symbol: context.symbol,
        side: context.side,
        entryQualityReason: entryQuality?.reason ?? context.entryQuality.model?.reason,
        entryQualityRecommendation: context.entryQuality.recommendation ?? context.entryQuality.model?.recommendation,
        entryQualityScore: context.entryQuality.entryQualityScore ?? context.entryQuality.model?.entry_quality_score,
        tailRiskScore: context.entryQuality.tailRiskScore ?? context.entryQuality.model?.tail_risk_score,
        cleanEntryDecision: cleanEntry?.decision ?? context.cleanEntry?.metadata?.decision,
        eventRiskMode: context.eventRisk.mode,
        eventRiskWouldBlock: eventRisk?.wouldBlock ?? context.eventRisk.wouldBlock,
        btcAction: context.regime?.btcAction ?? context.eventRisk.btcAction,
        btcScore: context.regime?.btcScore ?? context.eventRisk.btcScore,
        ethAction: context.regime?.ethAction ?? context.eventRisk.ethAction,
        ethScore: context.regime?.ethScore ?? context.eventRisk.ethScore,
        regimeLogged: String(regime?.metadata.regime ?? context.regimeContext?.label ?? ''),
        regimeWouldBlock: regime?.wouldBlock,
        regimeEngineV2Environment: stringValue(regimeEngineV2?.momentumEnvironment),
        regimeEngineV2TechnicalRegime: stringValue(regimeEngineV2?.technicalRegime),
        regimeEngineV2TransitionRisk: stringValue(regimeEngineV2?.transitionRisk),
        marketWeakness
    };
}

function marketWeaknessFromContext(context: AegisEntryContext): AegisLongRiskShadowMarketWeakness {
    const candles = context.entryQuality.ruleGate.recentCandles ?? [];
    const last = candles[candles.length - 1];
    const previous6 = candles[candles.length - 7];
    const previous12 = candles[candles.length - 13];
    const currentPrice = context.entryQuality.ruleGate.currentPrice ?? last?.close;
    const ema25 = context.regimeContext?.indicators.emaMid;
    const range = last ? last.high - last.low : undefined;
    const avgVolume20 = average(candles.slice(Math.max(0, candles.length - 21), Math.max(0, candles.length - 1)).map((candle) => candle.volume));
    return {
        belowEma25: isFiniteNumber(currentPrice) && isFiniteNumber(ema25) ? currentPrice < ema25 : undefined,
        return30m: isFiniteNumber(last?.close) && isFiniteNumber(previous6?.close) ? (last.close - previous6.close) / previous6.close : undefined,
        return60m: isFiniteNumber(last?.close) && isFiniteNumber(previous12?.close) ? (last.close - previous12.close) / previous12.close : undefined,
        closeLocation: last && range && range > 0 ? (last.close - last.low) / range : undefined,
        volumeRatio: isFiniteNumber(last?.volume) && avgVolume20 ? last.volume / avgVolume20 : undefined
    };
}

function riskLevelFor(score: number): AegisLongRiskShadowRiskLevel {
    if (score >= 0.75) return 'CRITICAL';
    if (score >= 0.55) return 'HIGH';
    if (score >= 0.30) return 'MODERATE';
    return 'LOW';
}

function suggestedActionFor(level: AegisLongRiskShadowRiskLevel): AegisLongRiskShadowSuggestedAction {
    if (level === 'CRITICAL') return 'WOULD_BLOCK_SHADOW';
    if (level === 'HIGH') return 'DELAY_ONE_CANDLE_SHADOW';
    if (level === 'MODERATE') return 'REDUCE_SIZE_SHADOW';
    return 'OBSERVE';
}

function isNotConfirmingLong(action?: string): boolean {
    const value = upper(action);
    return value === 'HOLD' || value === 'SHORT' || value === 'PASS';
}

function isAlt(symbol: string): boolean {
    return symbol !== 'BTCUSDT' && symbol !== 'ETHUSDT';
}

function lower(value?: string): string {
    return String(value ?? '').toLowerCase();
}

function upper(value?: string): string {
    return String(value ?? '').toUpperCase();
}

function stringValue(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function average(values: Array<number | undefined>): number | undefined {
    const finite = values.filter(isFiniteNumber);
    return finite.length > 0 ? finite.reduce((sum, value) => sum + value, 0) / finite.length : undefined;
}
