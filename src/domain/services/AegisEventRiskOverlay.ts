export type EventRiskMode = 'NORMAL' | 'CAUTION' | 'RISK_OFF' | 'MANUAL_ONLY';

export type AegisEventRiskOverlayAction =
    | 'ALLOW'
    | 'SHADOW_CAUTION'
    | 'SHADOW_RISK_OFF_BLOCK'
    | 'SHADOW_MANUAL_ONLY'
    | 'BLOCK';

export type AegisEventRiskOverlayReason =
    | 'event_risk_disabled'
    | 'event_risk_normal'
    | 'caution_quality_too_low'
    | 'caution_tail_too_high'
    | 'caution_btc_eth_not_confirmed'
    | 'risk_off_not_a_plus'
    | 'manual_only_requires_approval';

export interface AegisEventRiskOverlayConfig {
    caution?: {
        minQualityScore?: number;
        maxTailRiskScore?: number;
        requireBtcEthConfirmation?: boolean;
    };
    riskOff?: {
        minQualityScore?: number;
        maxTailRiskScore?: number;
        allowOnlyAPlus?: boolean;
    };
    manualOnly?: {
        blockNewEntries?: boolean;
    };
}

export interface AegisEventRiskOverlayInput {
    enabled: boolean;
    mode: EventRiskMode | string;
    enforce: boolean;
    symbol: string;
    side: 'LONG' | 'SHORT';
    turboScore: number;
    entryQualityScore?: number;
    tailRiskScore?: number;
    btcAction?: string;
    btcScore?: number;
    ethAction?: string;
    ethScore?: number;
    isAltSymbol: boolean;
    config?: AegisEventRiskOverlayConfig;
}

export interface AegisEventRiskOverlayDecision {
    allowed: boolean;
    wouldBlock: boolean;
    mode: EventRiskMode;
    action: AegisEventRiskOverlayAction;
    reason: AegisEventRiskOverlayReason;
    metadata: {
        symbol: string;
        side: 'LONG' | 'SHORT';
        mode: EventRiskMode;
        enforce: boolean;
        turboScore: number;
        entryQualityScore?: number;
        tailRiskScore?: number;
        btcAction?: string;
        btcScore?: number;
        ethAction?: string;
        ethScore?: number;
        isAltSymbol: boolean;
        thresholds?: Record<string, unknown>;
    };
}

function finiteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function normalizeMode(mode?: string): EventRiskMode {
    const normalized = String(mode || 'NORMAL').trim().toUpperCase();
    if (
        normalized === 'NORMAL'
        || normalized === 'CAUTION'
        || normalized === 'RISK_OFF'
        || normalized === 'MANUAL_ONLY'
    ) {
        return normalized;
    }
    return 'NORMAL';
}

function metadata(
    input: AegisEventRiskOverlayInput,
    mode: EventRiskMode,
    thresholds?: Record<string, unknown>
): AegisEventRiskOverlayDecision['metadata'] {
    return {
        symbol: String(input.symbol || '').trim().toUpperCase(),
        side: input.side,
        mode,
        enforce: input.enforce === true,
        turboScore: input.turboScore,
        entryQualityScore: input.entryQualityScore,
        tailRiskScore: input.tailRiskScore,
        btcAction: input.btcAction,
        btcScore: input.btcScore,
        ethAction: input.ethAction,
        ethScore: input.ethScore,
        isAltSymbol: input.isAltSymbol === true,
        thresholds
    };
}

function allow(
    input: AegisEventRiskOverlayInput,
    mode: EventRiskMode,
    reason: AegisEventRiskOverlayReason,
    thresholds?: Record<string, unknown>
): AegisEventRiskOverlayDecision {
    return {
        allowed: true,
        wouldBlock: false,
        mode,
        action: 'ALLOW',
        reason,
        metadata: metadata(input, mode, thresholds)
    };
}

function shadowOrBlock(
    input: AegisEventRiskOverlayInput,
    mode: EventRiskMode,
    shadowAction: Exclude<AegisEventRiskOverlayAction, 'ALLOW' | 'BLOCK'>,
    reason: AegisEventRiskOverlayReason,
    thresholds?: Record<string, unknown>
): AegisEventRiskOverlayDecision {
    const enforce = input.enforce === true;
    return {
        allowed: !enforce,
        wouldBlock: true,
        mode,
        action: enforce ? 'BLOCK' : shadowAction,
        reason,
        metadata: metadata(input, mode, thresholds)
    };
}

function sideConfirmed(action: string | undefined, score: number | undefined, side: 'LONG' | 'SHORT'): boolean {
    if (String(action || '').trim().toUpperCase() !== side) return false;
    return !finiteNumber(score) || score > 0;
}

export class AegisEventRiskOverlay {
    static evaluate(input: AegisEventRiskOverlayInput): AegisEventRiskOverlayDecision {
        const mode = normalizeMode(input.mode);

        if (input.enabled !== true) {
            return allow(input, mode, 'event_risk_disabled');
        }

        if (mode === 'NORMAL') {
            return allow(input, mode, 'event_risk_normal');
        }

        if (mode === 'MANUAL_ONLY') {
            if (input.config?.manualOnly?.blockNewEntries === true) {
                return shadowOrBlock(
                    input,
                    mode,
                    'SHADOW_MANUAL_ONLY',
                    'manual_only_requires_approval',
                    { blockNewEntries: true }
                );
            }
            return {
                allowed: true,
                wouldBlock: true,
                mode,
                action: 'SHADOW_MANUAL_ONLY',
                reason: 'manual_only_requires_approval',
                metadata: metadata(input, mode, { blockNewEntries: false })
            };
        }

        if (mode === 'CAUTION') {
            const minQualityScore = input.config?.caution?.minQualityScore ?? 0.65;
            const maxTailRiskScore = input.config?.caution?.maxTailRiskScore ?? 0.45;
            const requireBtcEthConfirmation = input.config?.caution?.requireBtcEthConfirmation === true;
            const thresholds = { minQualityScore, maxTailRiskScore, requireBtcEthConfirmation };

            if (finiteNumber(input.entryQualityScore) && input.entryQualityScore < minQualityScore) {
                return shadowOrBlock(input, mode, 'SHADOW_CAUTION', 'caution_quality_too_low', thresholds);
            }

            if (finiteNumber(input.tailRiskScore) && input.tailRiskScore > maxTailRiskScore) {
                return shadowOrBlock(input, mode, 'SHADOW_CAUTION', 'caution_tail_too_high', thresholds);
            }

            if (
                requireBtcEthConfirmation
                && input.isAltSymbol
                && (
                    !sideConfirmed(input.btcAction, input.btcScore, input.side)
                    || !sideConfirmed(input.ethAction, input.ethScore, input.side)
                )
            ) {
                return shadowOrBlock(input, mode, 'SHADOW_CAUTION', 'caution_btc_eth_not_confirmed', thresholds);
            }

            return allow(input, mode, 'event_risk_normal', thresholds);
        }

        const minQualityScore = input.config?.riskOff?.minQualityScore ?? 0.75;
        const maxTailRiskScore = input.config?.riskOff?.maxTailRiskScore ?? 0.35;
        const allowOnlyAPlus = input.config?.riskOff?.allowOnlyAPlus === true;
        const thresholds = { minQualityScore, maxTailRiskScore, allowOnlyAPlus };
        const qualityOk = finiteNumber(input.entryQualityScore) && input.entryQualityScore >= minQualityScore;
        const tailOk = finiteNumber(input.tailRiskScore) && input.tailRiskScore <= maxTailRiskScore;
        const turboOk = finiteNumber(input.turboScore) && input.turboScore >= minQualityScore;

        if (allowOnlyAPlus && !(qualityOk && tailOk && turboOk)) {
            return shadowOrBlock(input, mode, 'SHADOW_RISK_OFF_BLOCK', 'risk_off_not_a_plus', thresholds);
        }

        return allow(input, mode, 'event_risk_normal', thresholds);
    }
}
