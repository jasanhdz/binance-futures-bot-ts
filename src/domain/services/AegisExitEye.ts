export type AegisExitEyeMode = 'OFF' | 'SHADOW' | 'PROTECT' | 'CLOSE';

export type AegisExitEyeAction =
    | 'NONE'
    | 'SHADOW_PROTECT'
    | 'SHADOW_CLOSE'
    | 'PROTECT_PROFIT'
    | 'CLOSE_POSITION';

export type AegisExitEyeConfidence = 'low' | 'medium' | 'high';

export interface AegisExitEyeVotes {
    long?: number;
    short?: number;
    neutral?: number;
}

export interface AegisExitEyeInput {
    enabled: boolean;
    mode: AegisExitEyeMode;
    symbol: string;
    positionSide: 'LONG' | 'SHORT';
    currentRoe: number;
    peakRoe: number;
    lowestRoe?: number;
    minutesInTrade?: number;
    currentTurboAction?: 'LONG' | 'SHORT' | 'HOLD' | 'PASS' | 'CLOSE' | string;
    rawAction?: string;
    gatedAction?: string;
    turboScore?: number;
    votes?: AegisExitEyeVotes;
    entryThreshold?: number;
    currentReason?: string;
    minRoeToProtect: number;
    minPeakRoeToProtect: number;
    minGivebackFromPeakRoe: number;
    neutralVotesToProtect: number;
    oppositeVotesToClose: number;
    minRoeToCloseOnOpposite: number;
    minPeakRoeToCloseOnOpposite: number;
    closeOnNeutralDecay?: boolean;
    neutralCloseVotes?: number;
    minRoeToCloseOnNeutral?: number;
    minPeakRoeToCloseOnNeutral?: number;
    minGivebackToCloseOnNeutral?: number;
    requireConsecutiveNeutralClose?: number;
    requireConsecutiveNeutral?: number;
    requireConsecutiveOpposite?: number;
    consecutiveNeutralCount?: number;
    consecutiveNeutralCloseCount?: number;
    consecutiveOppositeCount?: number;
    minMinutesInTrade?: number;
}

export interface AegisExitEyeDecision {
    action: AegisExitEyeAction;
    shouldClose: boolean;
    shouldProtect: boolean;
    reason: string;
    confidence: AegisExitEyeConfidence;
    metadata: {
        symbol: string;
        positionSide: 'LONG' | 'SHORT';
        currentRoe: number;
        peakRoe: number;
        givebackRoe: number;
        currentTurboAction?: string;
        rawAction?: string;
        gatedAction?: string;
        turboScore?: number;
        votes?: AegisExitEyeVotes;
        consecutiveNeutralCount?: number;
        consecutiveNeutralCloseCount?: number;
        consecutiveOppositeCount?: number;
    };
}

function normalizeAction(value?: string): string {
    return String(value || '').trim().toUpperCase();
}

function finite(value: unknown, fallback = 0): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function metadata(input: AegisExitEyeInput): AegisExitEyeDecision['metadata'] {
    return {
        symbol: input.symbol,
        positionSide: input.positionSide,
        currentRoe: finite(input.currentRoe),
        peakRoe: finite(input.peakRoe),
        givebackRoe: Math.max(0, finite(input.peakRoe) - finite(input.currentRoe)),
        currentTurboAction: input.currentTurboAction,
        rawAction: input.rawAction,
        gatedAction: input.gatedAction,
        turboScore: input.turboScore,
        votes: input.votes,
        consecutiveNeutralCount: input.consecutiveNeutralCount,
        consecutiveNeutralCloseCount: input.consecutiveNeutralCloseCount,
        consecutiveOppositeCount: input.consecutiveOppositeCount,
    };
}

function none(input: AegisExitEyeInput, reason: string): AegisExitEyeDecision {
    return {
        action: 'NONE',
        shouldClose: false,
        shouldProtect: false,
        reason,
        confidence: 'low',
        metadata: metadata(input),
    };
}

function confidenceForOpposite(input: AegisExitEyeInput): AegisExitEyeConfidence {
    const votes = input.votes || {};
    const oppositeVotes = input.positionSide === 'LONG' ? finite(votes.short) : finite(votes.long);
    if (oppositeVotes > input.oppositeVotesToClose || finite(input.turboScore) >= 0.70) return 'high';
    return 'medium';
}

export function evaluateAegisExitEye(input: AegisExitEyeInput): AegisExitEyeDecision {
    const mode = normalizeAction(input.mode) as AegisExitEyeMode;
    if (!input.enabled || mode === 'OFF') return none(input, 'exit_eye_disabled');

    const currentRoe = finite(input.currentRoe);
    const peakRoe = finite(input.peakRoe);
    if (currentRoe <= 0) return none(input, 'exit_eye_never_closes_losing_trade');
    if (typeof input.minMinutesInTrade === 'number' && finite(input.minutesInTrade) < input.minMinutesInTrade) {
        return none(input, 'exit_eye_min_minutes_not_reached');
    }

    const currentTurboAction = normalizeAction(input.currentTurboAction);
    const rawAction = normalizeAction(input.rawAction);
    const gatedAction = normalizeAction(input.gatedAction);
    const votes = input.votes || {};
    const givebackRoe = Math.max(0, peakRoe - currentRoe);
    const requiredNeutral = input.requireConsecutiveNeutral ?? 1;
    const requiredNeutralClose = input.requireConsecutiveNeutralClose ?? 2;
    const requiredOpposite = input.requireConsecutiveOpposite ?? 1;
    const consecutiveNeutral = input.consecutiveNeutralCount ?? 0;
    const consecutiveNeutralClose = input.consecutiveNeutralCloseCount ?? consecutiveNeutral;
    const consecutiveOpposite = input.consecutiveOppositeCount ?? 0;
    const supportedAction = input.positionSide;
    const oppositeAction = input.positionSide === 'LONG' ? 'SHORT' : 'LONG';
    const oppositeVotes = input.positionSide === 'LONG' ? finite(votes.short) : finite(votes.long);

    const oppositeReversal =
        currentRoe >= input.minRoeToCloseOnOpposite
        && peakRoe >= input.minPeakRoeToCloseOnOpposite
        && (currentTurboAction === oppositeAction || rawAction === oppositeAction || gatedAction === oppositeAction)
        && oppositeVotes >= input.oppositeVotesToClose
        && consecutiveOpposite >= requiredOpposite;

    if (oppositeReversal) {
        if (mode === 'SHADOW') {
            return {
                action: 'SHADOW_CLOSE',
                shouldClose: false,
                shouldProtect: false,
                reason: 'opposite_signal_profit_exit',
                confidence: confidenceForOpposite(input),
                metadata: metadata(input),
            };
        }
        if (mode === 'PROTECT') {
            return {
                action: 'PROTECT_PROFIT',
                shouldClose: false,
                shouldProtect: true,
                reason: 'opposite_signal_profit_exit',
                confidence: confidenceForOpposite(input),
                metadata: metadata(input),
            };
        }
        if (mode === 'CLOSE') {
            return {
                action: 'CLOSE_POSITION',
                shouldClose: true,
                shouldProtect: true,
                reason: 'opposite_signal_profit_exit',
                confidence: confidenceForOpposite(input),
                metadata: metadata(input),
            };
        }
    }

    const neutralDecay =
        currentRoe >= input.minRoeToProtect
        && peakRoe >= input.minPeakRoeToProtect
        && givebackRoe >= input.minGivebackFromPeakRoe
        && currentTurboAction !== supportedAction
        && finite(votes.neutral) >= input.neutralVotesToProtect
        && consecutiveNeutral >= requiredNeutral;

    if (neutralDecay) {
        const neutralCloseVotes = input.neutralCloseVotes ?? 3;
        const minRoeToCloseOnNeutral = input.minRoeToCloseOnNeutral ?? input.minRoeToProtect;
        const minPeakRoeToCloseOnNeutral = input.minPeakRoeToCloseOnNeutral ?? input.minPeakRoeToProtect;
        const minGivebackToCloseOnNeutral = input.minGivebackToCloseOnNeutral ?? input.minGivebackFromPeakRoe;
        const shouldCloseNeutralDecay =
            mode === 'CLOSE'
            && input.closeOnNeutralDecay === true
            && currentRoe >= minRoeToCloseOnNeutral
            && peakRoe >= minPeakRoeToCloseOnNeutral
            && givebackRoe >= minGivebackToCloseOnNeutral
            && finite(votes.neutral) >= neutralCloseVotes
            && consecutiveNeutralClose >= requiredNeutralClose;

        if (shouldCloseNeutralDecay) {
            return {
                action: 'CLOSE_POSITION',
                shouldClose: true,
                shouldProtect: true,
                reason: 'neutral_momentum_decay_profit_exit',
                confidence: givebackRoe >= minGivebackToCloseOnNeutral * 2 ? 'high' : 'medium',
                metadata: metadata(input),
            };
        }

        return {
            action: mode === 'SHADOW' ? 'SHADOW_PROTECT' : 'PROTECT_PROFIT',
            shouldClose: false,
            shouldProtect: true,
            reason: 'neutral_momentum_decay_profit_protection',
            confidence: givebackRoe >= input.minGivebackFromPeakRoe * 2 ? 'high' : 'medium',
            metadata: metadata(input),
        };
    }

    if (peakRoe < Math.min(input.minPeakRoeToProtect, input.minPeakRoeToCloseOnOpposite)) {
        return none(input, 'exit_eye_peak_threshold_not_reached');
    }
    return none(input, 'exit_eye_no_action');
}
