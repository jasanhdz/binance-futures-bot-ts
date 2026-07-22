export type AegisEntryQualityGateMode = 'OFF' | 'SHADOW' | 'ENFORCE';

export type AegisEntryQualityGateReason =
    | 'entry_quality_disabled'
    | 'insufficient_data'
    | 'score_below_entry_quality_threshold'
    | 'momentum_not_confirmed'
    | 'falling_knife_long'
    | 'rising_knife_short'
    | 'overextended_long'
    | 'overextended_short'
    | 'volatility_too_high'
    | 'entry_quality_passed';

export type AegisEntryQualityGateAction =
    | 'ALLOW'
    | 'SHADOW_ALLOW'
    | 'SHADOW_BLOCK'
    | 'BLOCK';

export interface AegisEntryQualityGateCandle {
    open: number;
    high: number;
    low: number;
    close: number;
    volume?: number;
    timestamp?: number;
}

export interface AegisEntryQualityGateConfig {
    minScoreLong: number;
    minScoreShort: number;
    requireMomentumConfirm: boolean;
    antiFallingKnifeEnabled: boolean;
    antiFallingKnifeLookbackCandles: number;
    maxAdverseRecentReturn: number;
    overextensionEnabled: boolean;
    emaDistanceLimit: number;
    volatilityEnabled: boolean;
    maxAtrPercentile: number;
}

export interface AegisEntryQualityGateInput {
    enabled: boolean;
    mode: AegisEntryQualityGateMode;
    symbol: string;
    side: 'LONG' | 'SHORT';
    turboScore: number;
    votes?: {
        long?: number;
        short?: number;
        neutral?: number;
    };
    recentCandles?: AegisEntryQualityGateCandle[];
    currentPrice?: number;
    emaFast?: number;
    atrPct?: number;
    atrPercentile?: number;
    config: AegisEntryQualityGateConfig;
}

export interface AegisEntryQualityGateDecision {
    allowed: boolean;
    wouldBlock: boolean;
    action: AegisEntryQualityGateAction;
    reason: AegisEntryQualityGateReason;
    confidence: 'low' | 'medium' | 'high';
    metadata: {
        symbol: string;
        side: 'LONG' | 'SHORT';
        turboScore: number;
        votes?: AegisEntryQualityGateInput['votes'];
        microMomentum?: number;
        recentReturn?: number;
        emaDistance?: number;
        atrPct?: number;
        atrPercentile?: number;
        failedChecks: string[];
    };
}

function finiteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function normalizeSymbol(symbol: string): string {
    return String(symbol || '').trim().toUpperCase();
}

function normalizeLookback(value: number): number {
    if (!finiteNumber(value)) return 3;
    return Math.max(1, Math.floor(value));
}

function normalizedCandles(candles?: AegisEntryQualityGateCandle[]): AegisEntryQualityGateCandle[] {
    return (candles || []).filter((candle) =>
        finiteNumber(candle.open)
        && finiteNumber(candle.high)
        && finiteNumber(candle.low)
        && finiteNumber(candle.close)
        && candle.close > 0
    );
}

function computeRecentReturn(candles: AegisEntryQualityGateCandle[], lookback: number): number | undefined {
    if (candles.length < lookback + 1) return undefined;
    const lastClose = candles[candles.length - 1].close;
    const baseClose = candles[candles.length - 1 - lookback].close;
    if (!finiteNumber(lastClose) || !finiteNumber(baseClose) || baseClose <= 0) return undefined;
    return lastClose / baseClose - 1;
}

function baseMetadata(input: AegisEntryQualityGateInput, extras: {
    recentReturn?: number;
    emaDistance?: number;
    failedChecks?: string[];
} = {}): AegisEntryQualityGateDecision['metadata'] {
    return {
        symbol: normalizeSymbol(input.symbol),
        side: input.side,
        turboScore: input.turboScore,
        votes: input.votes,
        microMomentum: extras.recentReturn,
        recentReturn: extras.recentReturn,
        emaDistance: extras.emaDistance,
        atrPct: input.atrPct,
        atrPercentile: input.atrPercentile,
        failedChecks: extras.failedChecks || []
    };
}

function allowDecision(
    input: AegisEntryQualityGateInput,
    reason: AegisEntryQualityGateReason,
    metadata: AegisEntryQualityGateDecision['metadata'],
    confidence: AegisEntryQualityGateDecision['confidence'] = 'high'
): AegisEntryQualityGateDecision {
    const shadow = input.mode === 'SHADOW';
    return {
        allowed: true,
        wouldBlock: false,
        action: shadow ? 'SHADOW_ALLOW' : 'ALLOW',
        reason,
        confidence,
        metadata
    };
}

function blockDecision(
    input: AegisEntryQualityGateInput,
    reason: AegisEntryQualityGateReason,
    metadata: AegisEntryQualityGateDecision['metadata']
): AegisEntryQualityGateDecision {
    const shadow = input.mode === 'SHADOW';
    return {
        allowed: shadow,
        wouldBlock: true,
        action: shadow ? 'SHADOW_BLOCK' : 'BLOCK',
        reason,
        confidence: 'medium',
        metadata
    };
}

export function evaluateAegisEntryQualityGate(
    input: AegisEntryQualityGateInput
): AegisEntryQualityGateDecision {
    const symbol = normalizeSymbol(input.symbol);
    const mode = input.mode === 'SHADOW' || input.mode === 'ENFORCE' ? input.mode : 'OFF';
    const config = input.config;
    const lookback = normalizeLookback(config.antiFallingKnifeLookbackCandles);
    const candles = normalizedCandles(input.recentCandles);
    const recentReturn = computeRecentReturn(candles, lookback);
    const emaDistance = finiteNumber(input.currentPrice) && finiteNumber(input.emaFast) && input.emaFast > 0
        ? (input.currentPrice - input.emaFast) / input.emaFast
        : undefined;

    const metadata = baseMetadata(
        { ...input, symbol, mode },
        { recentReturn, emaDistance }
    );

    if (input.enabled !== true || mode === 'OFF') {
        return {
            allowed: true,
            wouldBlock: false,
            action: 'ALLOW',
            reason: 'entry_quality_disabled',
            confidence: 'low',
            metadata
        };
    }

    const failedChecks: string[] = [];
    const minScore = input.side === 'LONG' ? config.minScoreLong : config.minScoreShort;
    if (!finiteNumber(input.turboScore) || input.turboScore < minScore) {
        failedChecks.push('score_below_entry_quality_threshold');
        return blockDecision(input, 'score_below_entry_quality_threshold', {
            ...metadata,
            failedChecks
        });
    }

    const requiresRecentReturn = config.requireMomentumConfirm || config.antiFallingKnifeEnabled;
    const missingRecentReturn = requiresRecentReturn && recentReturn === undefined;
    const missingOverextensionData = config.overextensionEnabled && emaDistance === undefined;
    const missingVolatilityData = config.volatilityEnabled && !finiteNumber(input.atrPercentile);

    if (missingRecentReturn || missingOverextensionData || missingVolatilityData) {
        return {
            allowed: true,
            wouldBlock: false,
            action: mode === 'SHADOW' ? 'SHADOW_ALLOW' : 'ALLOW',
            reason: 'insufficient_data',
            confidence: 'low',
            metadata: {
                ...metadata,
                failedChecks: []
            }
        };
    }

    if (config.requireMomentumConfirm && finiteNumber(recentReturn)) {
        const momentumFailed = input.side === 'LONG' ? recentReturn < 0 : recentReturn > 0;
        if (momentumFailed) {
            failedChecks.push('momentum_not_confirmed');
        }
    }

    if (config.antiFallingKnifeEnabled && finiteNumber(recentReturn)) {
        const adverseLimit = Math.abs(config.maxAdverseRecentReturn);
        if (input.side === 'LONG' && recentReturn < -adverseLimit) {
            failedChecks.push('falling_knife_long');
        }
        if (input.side === 'SHORT' && recentReturn > adverseLimit) {
            failedChecks.push('rising_knife_short');
        }
    }

    if (config.overextensionEnabled && finiteNumber(emaDistance)) {
        const distanceLimit = Math.abs(config.emaDistanceLimit);
        if (input.side === 'LONG' && emaDistance > distanceLimit) {
            failedChecks.push('overextended_long');
        }
        if (input.side === 'SHORT' && emaDistance < -distanceLimit) {
            failedChecks.push('overextended_short');
        }
    }

    if (
        config.volatilityEnabled
        && finiteNumber(input.atrPercentile)
        && input.atrPercentile > config.maxAtrPercentile
    ) {
        failedChecks.push('volatility_too_high');
    }

    if (failedChecks.length > 0) {
        const reason = failedChecks[0] as AegisEntryQualityGateReason;
        return blockDecision(input, reason, {
            ...metadata,
            failedChecks
        });
    }

    return allowDecision(input, 'entry_quality_passed', {
        ...metadata,
        failedChecks: []
    });
}
