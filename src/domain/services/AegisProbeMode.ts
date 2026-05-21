import { EventRiskMode } from './AegisEventRiskOverlay';

export type AegisProbeModeMode = 'OFF' | 'SHADOW' | 'ENFORCE';

export type AegisProbeModeReason =
    | 'probe_mode_disabled'
    | 'probe_mode_not_enforce'
    | 'probe_event_risk_mode_not_allowed'
    | 'probe_event_risk_risk_off'
    | 'probe_event_risk_manual_only'
    | 'probe_decision_brain_not_enter_now'
    | 'probe_entry_quality_not_allow'
    | 'probe_entry_quality_block_shadow'
    | 'probe_feature_status_not_ok'
    | 'probe_feature_parity_too_low'
    | 'probe_tail_risk_too_high'
    | 'probe_turbo_score_too_low'
    | 'probe_votes_too_low'
    | 'probe_setup_grade_not_clean'
    | 'probe_clean_entry_block_reasons_not_allowed'
    | 'probe_same_symbol_position_open'
    | 'probe_recent_stop_loss'
    | 'probe_consecutive_losses'
    | 'probe_min_minutes_between_entries'
    | 'probe_entries_per_hour_exceeded'
    | 'probe_open_probe_positions_exceeded'
    | 'probe_total_open_positions_exceeded'
    | 'probe_allowed';

export interface AegisProbeModeRuntimeConfig {
    enabled: boolean;
    mode: AegisProbeModeMode;
    apply_when_event_risk: EventRiskMode[];
    min_turbo_score: number;
    min_votes_agreement: number;
    max_tail_risk_score: number;
    require_decision_brain: string;
    require_entry_quality_allow: boolean;
    require_feature_status_ok: boolean;
    min_feature_parity_pct: number;
    allow_if_blocked_only_by: string[];
    max_probe_entries_per_hour: number;
    min_minutes_between_probe_entries: number;
    max_open_probe_positions: number;
    max_total_open_positions_when_probe: number;
    block_after_consecutive_losses: number;
    block_after_recent_stop_loss_minutes: number;
}

export interface AegisProbeModeInput {
    config: AegisProbeModeRuntimeConfig;
    nowMs: number;
    symbol: string;
    side: 'LONG' | 'SHORT';
    turboScore?: number;
    votes?: { long?: number; short?: number; neutral?: number };
    setupGrade?: string;
    decisionBrain?: string;
    entryQualityRecommendation?: string;
    entryQualityGateAction?: string;
    featureStatus?: string;
    featureParityPct?: number | null;
    tailRiskScore?: number | null;
    eventRiskMode?: string;
    eventRiskReason?: string;
    eventRiskWouldBlock?: boolean;
    cleanEntryReasons?: string[];
    lastProbeAt?: number;
    probeEntryTimestamps?: number[];
    openProbePositions: number;
    totalOpenPositions: number;
    sameSymbolOpen: boolean;
    consecutiveLosses: number;
    lastStopLossAt?: number;
}

export interface AegisProbeModeDecision {
    allowed: boolean;
    reason: AegisProbeModeReason;
    metadata: {
        enabled: boolean;
        allowed: boolean;
        reason: AegisProbeModeReason;
        symbol: string;
        side: 'LONG' | 'SHORT';
        turboScore?: number;
        tailRiskScore?: number | null;
        decisionBrain?: string;
        entryQualityRecommendation?: string;
        featureStatus?: string;
        featureParityPct?: number | null;
        eventRiskMode?: string;
        eventRiskReason?: string;
        eventRiskWouldBlock?: boolean;
        cleanEntryReasons: string[];
        lastProbeAt?: number;
        openProbePositions: number;
        entriesLastHour: number;
        totalOpenPositions: number;
        sameSymbolOpen: boolean;
        consecutiveLosses: number;
        lastStopLossAt?: number;
    };
}

function normalized(value?: string): string {
    return String(value ?? '').trim().toUpperCase();
}

function normalizedReason(value?: string): string {
    return String(value ?? '').trim().toLowerCase();
}

function finiteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function sideVotes(input: AegisProbeModeInput): number {
    return input.side === 'LONG' ? input.votes?.long ?? 0 : input.votes?.short ?? 0;
}

function entriesLastHour(input: AegisProbeModeInput): number {
    const cutoff = input.nowMs - 60 * 60 * 1000;
    return (input.probeEntryTimestamps ?? []).filter((ts) => finiteNumber(ts) && ts >= cutoff && ts <= input.nowMs).length;
}

function metadata(input: AegisProbeModeInput, allowed: boolean, reason: AegisProbeModeReason): AegisProbeModeDecision['metadata'] {
    return {
        enabled: input.config.enabled === true,
        allowed,
        reason,
        symbol: String(input.symbol || '').trim().toUpperCase(),
        side: input.side,
        turboScore: input.turboScore,
        tailRiskScore: input.tailRiskScore,
        decisionBrain: input.decisionBrain,
        entryQualityRecommendation: input.entryQualityRecommendation,
        featureStatus: input.featureStatus,
        featureParityPct: input.featureParityPct,
        eventRiskMode: input.eventRiskMode,
        eventRiskReason: input.eventRiskReason,
        eventRiskWouldBlock: input.eventRiskWouldBlock,
        cleanEntryReasons: input.cleanEntryReasons ?? [],
        lastProbeAt: input.lastProbeAt,
        openProbePositions: input.openProbePositions,
        entriesLastHour: entriesLastHour(input),
        totalOpenPositions: input.totalOpenPositions,
        sameSymbolOpen: input.sameSymbolOpen,
        consecutiveLosses: input.consecutiveLosses,
        lastStopLossAt: input.lastStopLossAt
    };
}

function deny(input: AegisProbeModeInput, reason: AegisProbeModeReason): AegisProbeModeDecision {
    return { allowed: false, reason, metadata: metadata(input, false, reason) };
}

function allow(input: AegisProbeModeInput): AegisProbeModeDecision {
    return { allowed: true, reason: 'probe_allowed', metadata: metadata(input, true, 'probe_allowed') };
}

function isAllowedEntryQuality(value?: string): boolean {
    const recommendation = normalized(value);
    return recommendation === 'ALLOW_SHADOW' || recommendation === 'ALLOW';
}

function hasEntryQualityBlock(input: AegisProbeModeInput): boolean {
    return normalized(input.entryQualityRecommendation) === 'BLOCK_SHADOW'
        || normalized(input.entryQualityGateAction) === 'SHADOW_BLOCK'
        || normalized(input.entryQualityGateAction) === 'BLOCK';
}

function cleanEntryBlockedOnlyByAllowedReasons(input: AegisProbeModeInput): boolean {
    const allowedReasons = new Set(input.config.allow_if_blocked_only_by.map(normalizedReason));
    const reasons = (input.cleanEntryReasons ?? []).map(normalizedReason).filter(Boolean);
    const eventRiskReason = normalizedReason(input.eventRiskReason);

    if (reasons.length === 0) return allowedReasons.has(eventRiskReason);
    return reasons.every((reason) => allowedReasons.has(reason))
        && (
            !eventRiskReason
            || eventRiskReason === 'n/d'
            || allowedReasons.has(eventRiskReason)
            || eventRiskReason === 'caution_btc_eth_not_confirmed'
        );
}

export class AegisProbeMode {
    static evaluate(input: AegisProbeModeInput): AegisProbeModeDecision {
        const config = input.config;
        const mode = normalized(config.mode);
        const eventRiskMode = normalized(input.eventRiskMode);
        const requiredDecision = normalized(config.require_decision_brain);
        const decisionBrain = normalized(input.decisionBrain);
        const featureStatus = normalized(input.featureStatus);
        const setupGrade = normalized(input.setupGrade);

        if (config.enabled !== true) return deny(input, 'probe_mode_disabled');
        if (mode !== 'ENFORCE') return deny(input, 'probe_mode_not_enforce');

        if (eventRiskMode === 'RISK_OFF') return deny(input, 'probe_event_risk_risk_off');
        if (eventRiskMode === 'MANUAL_ONLY') return deny(input, 'probe_event_risk_manual_only');
        if (!config.apply_when_event_risk.map(normalized).includes(eventRiskMode)) {
            return deny(input, 'probe_event_risk_mode_not_allowed');
        }

        if (decisionBrain !== requiredDecision) return deny(input, 'probe_decision_brain_not_enter_now');
        if (hasEntryQualityBlock(input)) return deny(input, 'probe_entry_quality_block_shadow');
        if (config.require_entry_quality_allow && !isAllowedEntryQuality(input.entryQualityRecommendation)) {
            return deny(input, 'probe_entry_quality_not_allow');
        }
        if (config.require_feature_status_ok && featureStatus !== 'OK') {
            return deny(input, 'probe_feature_status_not_ok');
        }
        if (!finiteNumber(input.featureParityPct) || input.featureParityPct < config.min_feature_parity_pct) {
            return deny(input, 'probe_feature_parity_too_low');
        }
        if (!finiteNumber(input.tailRiskScore) || input.tailRiskScore > config.max_tail_risk_score) {
            return deny(input, 'probe_tail_risk_too_high');
        }
        if (!finiteNumber(input.turboScore) || input.turboScore < config.min_turbo_score) {
            return deny(input, 'probe_turbo_score_too_low');
        }
        if (sideVotes(input) < config.min_votes_agreement) {
            return deny(input, 'probe_votes_too_low');
        }
        if (setupGrade !== 'A' && setupGrade !== 'A_PLUS') {
            return deny(input, 'probe_setup_grade_not_clean');
        }
        if (!cleanEntryBlockedOnlyByAllowedReasons(input)) {
            return deny(input, 'probe_clean_entry_block_reasons_not_allowed');
        }

        if (input.sameSymbolOpen) return deny(input, 'probe_same_symbol_position_open');
        if (input.consecutiveLosses >= config.block_after_consecutive_losses) {
            return deny(input, 'probe_consecutive_losses');
        }
        if (
            finiteNumber(input.lastStopLossAt)
            && input.nowMs - input.lastStopLossAt < config.block_after_recent_stop_loss_minutes * 60 * 1000
        ) {
            return deny(input, 'probe_recent_stop_loss');
        }
        if (
            finiteNumber(input.lastProbeAt)
            && input.nowMs - input.lastProbeAt < config.min_minutes_between_probe_entries * 60 * 1000
        ) {
            return deny(input, 'probe_min_minutes_between_entries');
        }
        if (entriesLastHour(input) >= config.max_probe_entries_per_hour) {
            return deny(input, 'probe_entries_per_hour_exceeded');
        }
        if (input.openProbePositions >= config.max_open_probe_positions) {
            return deny(input, 'probe_open_probe_positions_exceeded');
        }
        if (input.totalOpenPositions >= config.max_total_open_positions_when_probe) {
            return deny(input, 'probe_total_open_positions_exceeded');
        }

        return allow(input);
    }
}
