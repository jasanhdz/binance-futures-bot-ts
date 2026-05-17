import { AegisDecisionBrainBlock, AegisEntryQualityModelBlock, AegisEventRiskAutoBlock } from './AegisStrategy';
import { AegisEntryQualityGateDecision } from './AegisEntryQualityGate';
import { EventRiskMode } from './AegisEventRiskOverlay';

export type AegisDecisionEnforcementMode = 'OFF' | 'CONSERVATIVE';

export type AegisDecisionEnforcementReason =
    | 'decision_enforcement_disabled'
    | 'decision_brain_do_not_enter'
    | 'decision_brain_wait_confirmation'
    | 'decision_brain_manual_only'
    | 'entry_quality_shadow_block_hard_denied'
    | 'missing_decision_brain_with_shadow_block'
    | 'entry_quality_shadow_block_event_risk'
    | 'event_risk_manual_only'
    | 'event_risk_risk_off_allowed_a_plus'
    | 'event_risk_risk_off_denied_non_a_plus'
    | 'event_risk_caution_allowed_strong_setup'
    | 'event_risk_caution_denied_weak_setup'
    | 'event_risk_caution_weak_entry'
    | 'decision_enforcement_allow';

export type AegisDecisionSetupGrade = 'A_PLUS' | 'A' | 'WEAK';

export interface AegisDecisionEnforcementRuntimeConfig {
    enabled: boolean;
    mode: AegisDecisionEnforcementMode;
    block_do_not_enter: boolean;
    block_wait_confirmation: boolean;
    block_manual_only: boolean;
    block_entry_quality_shadow_block_when_event_risk: {
        enabled: boolean;
        event_modes: EventRiskMode[];
    };
    event_risk_enforcement: {
        caution_blocks_weak_entries: boolean;
        risk_off_blocks_non_a_plus: boolean;
        manual_only_blocks_all_new_entries: boolean;
    };
    block_caution_would_block_unless_a_plus: boolean;
    block_all_entry_quality_shadow_block: boolean;
    block_all_tail_risk_high: boolean;
}

export interface AegisDecisionEnforcementInput {
    symbol: string;
    side: 'LONG' | 'SHORT';
    turboScore?: number;
    decisionBrain?: AegisDecisionBrainBlock | null;
    entryQualityModel?: AegisEntryQualityModelBlock;
    entryQualityGate?: AegisEntryQualityGateDecision;
    eventRiskMode?: EventRiskMode | string;
    eventRiskWouldBlock?: boolean;
    eventRiskReason?: string;
    eventRiskAuto?: AegisEventRiskAutoBlock;
    isAltSymbol?: boolean;
    config: AegisDecisionEnforcementRuntimeConfig;
    riskOffTailMax?: number;
}

export interface AegisDecisionEnforcementDecision {
    allowed: boolean;
    reason: AegisDecisionEnforcementReason;
    metadata: {
        symbol: string;
        side: 'LONG' | 'SHORT';
        mode: AegisDecisionEnforcementMode;
        eventRiskMode: EventRiskMode;
        turboScore?: number;
        decisionBrainDecision?: string;
        decisionBrainRecommendation?: string;
        entryQualityRecommendation?: string;
        entryQualityGateAction?: string;
        entryQualityGateReason?: string;
        eventRiskWouldBlock?: boolean;
        eventRiskReason?: string;
        entryQualityScore?: number | null;
        tailRiskScore?: number | null;
        btcAction?: string;
        btcScore?: number | null;
        ethAction?: string;
        ethScore?: number | null;
        isAltSymbol: boolean;
        aPlus: boolean;
        setupGrade: AegisDecisionSetupGrade;
        checks: Record<string, unknown>;
    };
}

function normalizeMode(mode?: string): AegisDecisionEnforcementMode {
    const normalized = String(mode || 'OFF').trim().toUpperCase();
    return normalized === 'CONSERVATIVE' ? 'CONSERVATIVE' : 'OFF';
}

function normalizeEventRiskMode(mode?: string): EventRiskMode {
    const normalized = String(mode || 'NORMAL').trim().toUpperCase();
    if (normalized === 'CAUTION' || normalized === 'RISK_OFF' || normalized === 'MANUAL_ONLY') {
        return normalized;
    }
    return 'NORMAL';
}

function finiteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function normalizedDecision(input?: AegisDecisionBrainBlock | null): string {
    return String(input?.decision || 'UNKNOWN').trim().toUpperCase();
}

function normalizedRecommendation(input?: AegisEntryQualityModelBlock): string {
    return String(input?.recommendation || 'UNKNOWN').trim().toUpperCase();
}

function extractTailRisk(input: AegisDecisionEnforcementInput): number | undefined {
    if (finiteNumber(input.entryQualityModel?.tail_risk_score)) return input.entryQualityModel.tail_risk_score;
    return undefined;
}

function contextValue(context: Record<string, unknown> | undefined, keys: string[]): unknown {
    if (!context) return undefined;
    for (const key of keys) {
        if (context[key] !== undefined) return context[key];
    }
    return undefined;
}

function contextAction(context: Record<string, unknown> | undefined): string | undefined {
    const value = contextValue(context, ['action', 'turbo_action', 'suggested_action']);
    return value === undefined ? undefined : String(value).trim().toUpperCase();
}

function contextScore(context: Record<string, unknown> | undefined): number | undefined {
    const value = contextValue(context, ['score', 'turbo_score', 'confidence']);
    return finiteNumber(value) ? value : undefined;
}

function contextContradictsSide(action: string | undefined, side: 'LONG' | 'SHORT'): boolean {
    if (!action || action === 'HOLD' || action === 'NEUTRAL' || action === 'PASS') return false;
    return action !== side;
}

function baseMetadata(
    input: AegisDecisionEnforcementInput,
    mode: AegisDecisionEnforcementMode,
    eventRiskMode: EventRiskMode,
    aPlus: boolean,
    setupGrade: AegisDecisionSetupGrade,
    checks: Record<string, unknown>
): AegisDecisionEnforcementDecision['metadata'] {
    const btcAction = contextAction(input.eventRiskAuto?.btc_context);
    const ethAction = contextAction(input.eventRiskAuto?.eth_context);
    const btcScore = contextScore(input.eventRiskAuto?.btc_context);
    const ethScore = contextScore(input.eventRiskAuto?.eth_context);

    return {
        symbol: String(input.symbol || '').trim().toUpperCase(),
        side: input.side,
        mode,
        eventRiskMode,
        turboScore: input.turboScore,
        decisionBrainDecision: input.decisionBrain?.decision,
        decisionBrainRecommendation: input.decisionBrain?.recommendation,
        entryQualityRecommendation: input.entryQualityModel?.recommendation,
        entryQualityGateAction: input.entryQualityGate?.action,
        entryQualityGateReason: input.entryQualityGate?.reason,
        eventRiskWouldBlock: input.eventRiskWouldBlock,
        eventRiskReason: input.eventRiskReason,
        entryQualityScore: input.entryQualityModel?.entry_quality_score,
        tailRiskScore: input.entryQualityModel?.tail_risk_score,
        btcAction,
        btcScore,
        ethAction,
        ethScore,
        isAltSymbol: input.isAltSymbol === true,
        aPlus,
        setupGrade,
        checks
    };
}

function allow(
    input: AegisDecisionEnforcementInput,
    reason: AegisDecisionEnforcementReason,
    setupGrade: AegisDecisionSetupGrade = 'WEAK',
    checks: Record<string, unknown> = {}
): AegisDecisionEnforcementDecision {
    const mode = normalizeMode(input.config.mode);
    const eventRiskMode = normalizeEventRiskMode(input.eventRiskMode);
    return {
        allowed: true,
        reason,
        metadata: baseMetadata(input, mode, eventRiskMode, setupGrade === 'A_PLUS', setupGrade, checks)
    };
}

function deny(
    input: AegisDecisionEnforcementInput,
    reason: AegisDecisionEnforcementReason,
    setupGrade: AegisDecisionSetupGrade,
    checks: Record<string, unknown>
): AegisDecisionEnforcementDecision {
    const mode = normalizeMode(input.config.mode);
    const eventRiskMode = normalizeEventRiskMode(input.eventRiskMode);
    return {
        allowed: false,
        reason,
        metadata: baseMetadata(input, mode, eventRiskMode, setupGrade === 'A_PLUS', setupGrade, checks)
    };
}

function isEntryQualityShadowBlock(input: AegisDecisionEnforcementInput): boolean {
    return normalizedRecommendation(input.entryQualityModel) === 'BLOCK_SHADOW'
        || input.entryQualityGate?.action === 'SHADOW_BLOCK';
}

function hasMissingDecisionBrain(input: AegisDecisionEnforcementInput): boolean {
    return normalizedDecision(input.decisionBrain) === 'UNKNOWN';
}

function isEntryQualityAllow(input: AegisDecisionEnforcementInput): boolean {
    return normalizedRecommendation(input.entryQualityModel) === 'ALLOW_SHADOW'
        || input.entryQualityGate?.action === 'SHADOW_ALLOW'
        || input.entryQualityGate?.action === 'ALLOW';
}

function setupGrade(input: AegisDecisionEnforcementInput): AegisDecisionSetupGrade {
    if (normalizeEventRiskMode(input.eventRiskMode) === 'MANUAL_ONLY') return 'WEAK';

    const tailRisk = extractTailRisk(input);
    const dbEnterNow = normalizedDecision(input.decisionBrain) === 'ENTER_NOW';
    const eqAllow = normalizedRecommendation(input.entryQualityModel) === 'ALLOW_SHADOW';
    const turboScore = input.turboScore;
    const tailAvailable = finiteNumber(tailRisk);
    const turboAvailable = finiteNumber(turboScore);
    const baseClean = dbEnterNow && eqAllow && !isEntryQualityShadowBlock(input) && tailAvailable && turboAvailable;

    if (!baseClean) return 'WEAK';

    const isA = tailRisk <= 0.50 && turboScore >= 0.80;
    if (!isA) return 'WEAK';

    const btcAction = contextAction(input.eventRiskAuto?.btc_context);
    const ethAction = contextAction(input.eventRiskAuto?.eth_context);
    const btcEthDoesNotContradict = !(input.isAltSymbol === true && input.side === 'LONG')
        || (!contextContradictsSide(btcAction, input.side) && !contextContradictsSide(ethAction, input.side));
    const isAPlus = tailRisk <= 0.35
        && turboScore >= 0.90
        && normalizeEventRiskMode(input.eventRiskMode) !== 'MANUAL_ONLY'
        && btcEthDoesNotContradict;

    return isAPlus ? 'A_PLUS' : 'A';
}

function isWeakEntry(input: AegisDecisionEnforcementInput): boolean {
    const decision = normalizedDecision(input.decisionBrain);
    return decision === 'WAIT_CONFIRMATION'
        || decision === 'DO_NOT_ENTER'
        || decision === 'MANUAL_ONLY'
        || isEntryQualityShadowBlock(input);
}

export class AegisDecisionEnforcement {
    static evaluate(input: AegisDecisionEnforcementInput): AegisDecisionEnforcementDecision {
        const mode = normalizeMode(input.config.mode);
        const eventRiskMode = normalizeEventRiskMode(input.eventRiskMode);
        const grade = setupGrade(input);
        const checks = {
            decision: normalizedDecision(input.decisionBrain),
            entryQualityRecommendation: normalizedRecommendation(input.entryQualityModel),
            entryQualityGateAction: input.entryQualityGate?.action,
            tailRiskScore: extractTailRisk(input),
            turboScore: input.turboScore,
            eventRiskMode,
            eventRiskWouldBlock: input.eventRiskWouldBlock === true,
            eventRiskReason: input.eventRiskReason,
            setupGrade: grade,
            aPlus: grade === 'A_PLUS'
        };

        if (input.config.enabled !== true || mode === 'OFF') {
            return allow(input, 'decision_enforcement_disabled', grade, checks);
        }

        if (
            input.config.event_risk_enforcement.manual_only_blocks_all_new_entries
            && eventRiskMode === 'MANUAL_ONLY'
        ) {
            return deny(input, 'event_risk_manual_only', grade, checks);
        }

        const decision = normalizedDecision(input.decisionBrain);
        if (input.config.block_do_not_enter && decision === 'DO_NOT_ENTER') {
            return deny(input, 'decision_brain_do_not_enter', grade, checks);
        }
        if (input.config.block_wait_confirmation && decision === 'WAIT_CONFIRMATION') {
            return deny(input, 'decision_brain_wait_confirmation', grade, checks);
        }
        if (input.config.block_manual_only && decision === 'MANUAL_ONLY') {
            return deny(input, 'decision_brain_manual_only', grade, checks);
        }

        if (
            input.config.block_all_entry_quality_shadow_block
            && isEntryQualityShadowBlock(input)
        ) {
            if (hasMissingDecisionBrain(input)) {
                return deny(input, 'missing_decision_brain_with_shadow_block', grade, checks);
            }
            return deny(input, 'entry_quality_shadow_block_hard_denied', grade, checks);
        }

        if (
            input.config.block_entry_quality_shadow_block_when_event_risk.enabled
            && isEntryQualityShadowBlock(input)
            && input.config.block_entry_quality_shadow_block_when_event_risk.event_modes.includes(eventRiskMode)
        ) {
            return deny(input, 'entry_quality_shadow_block_event_risk', grade, checks);
        }

        if (
            input.config.event_risk_enforcement.risk_off_blocks_non_a_plus
            && eventRiskMode === 'RISK_OFF'
        ) {
            if (grade === 'A_PLUS') {
                return allow(input, 'event_risk_risk_off_allowed_a_plus', grade, checks);
            }
            return deny(input, 'event_risk_risk_off_denied_non_a_plus', grade, checks);
        }

        if (
            input.config.block_caution_would_block_unless_a_plus
            && eventRiskMode === 'CAUTION'
        ) {
            if (grade === 'A_PLUS' || grade === 'A') {
                return allow(input, 'event_risk_caution_allowed_strong_setup', grade, checks);
            }
            return deny(input, 'event_risk_caution_denied_weak_setup', grade, checks);
        }

        if (
            input.config.event_risk_enforcement.caution_blocks_weak_entries
            && eventRiskMode === 'CAUTION'
            && isWeakEntry(input)
        ) {
            return deny(input, 'event_risk_caution_weak_entry', grade, checks);
        }

        if (input.config.block_all_tail_risk_high) {
            const tailRisk = extractTailRisk(input);
            const tailMax = finiteNumber(input.riskOffTailMax) ? input.riskOffTailMax : 0.35;
            if (finiteNumber(tailRisk) && tailRisk > tailMax) {
                return deny(input, 'event_risk_risk_off_denied_non_a_plus', grade, checks);
            }
        }

        return allow(input, 'decision_enforcement_allow', grade, checks);
    }
}
