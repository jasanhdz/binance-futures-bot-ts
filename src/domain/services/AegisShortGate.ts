import { Side } from '../types';

export type AegisShortGateReason =
    | 'short_gate_disabled'
    | 'not_short'
    | 'short_symbol_blocked'
    | 'short_score_below_premium_threshold'
    | 'short_votes_below_required'
    | 'short_allowed_premium';

export interface AegisShortGateConfig {
    enabled?: boolean;
    mode?: 'PREMIUM_ONLY' | string;
    min_score?: number;
    require_votes?: number;
    position_fraction_multiplier?: number;
    max_leverage?: number;
    block_symbols?: string[];
    allow_if_regime_bearish?: boolean;
}

export interface AegisShortGateInput {
    symbol: string;
    side: Side;
    turboScore?: number;
    votes?: {
        long?: number;
        short?: number;
        neutral?: number;
    };
    leverage: number;
    positionFraction: number;
    config?: AegisShortGateConfig;
}

export interface AegisShortGateDecision {
    allowed: boolean;
    adjustedLeverage: number;
    adjustedPositionFraction: number;
    reason: AegisShortGateReason;
    metadata: Record<string, unknown>;
}

function finiteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function normalizeSymbol(symbol: string): string {
    return String(symbol || '').trim().toUpperCase();
}

export class AegisShortGate {
    static evaluate(input: AegisShortGateInput): AegisShortGateDecision {
        const config = input.config || {};
        const symbol = normalizeSymbol(input.symbol);
        const blockedSymbols = new Set((config.block_symbols || []).map(normalizeSymbol));
        const minScore = finiteNumber(config.min_score) ? config.min_score : 0;
        const requireVotes = finiteNumber(config.require_votes) ? Math.max(0, Math.floor(config.require_votes)) : 0;
        const multiplier = finiteNumber(config.position_fraction_multiplier)
            ? Math.max(0, config.position_fraction_multiplier)
            : 1;
        const maxLeverage = finiteNumber(config.max_leverage) && config.max_leverage > 0
            ? config.max_leverage
            : input.leverage;

        const metadata = {
            symbol,
            side: input.side,
            score: input.turboScore,
            votes: input.votes,
            minScore,
            requireVotes,
            originalLeverage: input.leverage,
            originalPositionFraction: input.positionFraction,
            positionFractionMultiplier: multiplier,
            maxLeverage,
            blockSymbols: [...blockedSymbols],
            mode: config.mode || 'PREMIUM_ONLY'
        };

        if (input.side !== 'SHORT') {
            return {
                allowed: true,
                adjustedLeverage: input.leverage,
                adjustedPositionFraction: input.positionFraction,
                reason: 'not_short',
                metadata
            };
        }

        if (config.enabled !== true) {
            return {
                allowed: true,
                adjustedLeverage: input.leverage,
                adjustedPositionFraction: input.positionFraction,
                reason: 'short_gate_disabled',
                metadata
            };
        }

        if (blockedSymbols.has(symbol)) {
            return {
                allowed: false,
                adjustedLeverage: input.leverage,
                adjustedPositionFraction: input.positionFraction,
                reason: 'short_symbol_blocked',
                metadata
            };
        }

        if (!finiteNumber(input.turboScore) || input.turboScore < minScore) {
            return {
                allowed: false,
                adjustedLeverage: input.leverage,
                adjustedPositionFraction: input.positionFraction,
                reason: 'short_score_below_premium_threshold',
                metadata
            };
        }

        if ((input.votes?.short ?? 0) < requireVotes) {
            return {
                allowed: false,
                adjustedLeverage: input.leverage,
                adjustedPositionFraction: input.positionFraction,
                reason: 'short_votes_below_required',
                metadata
            };
        }

        const adjustedLeverage = Math.min(input.leverage, maxLeverage);
        const adjustedPositionFraction = input.positionFraction * multiplier;

        return {
            allowed: true,
            adjustedLeverage,
            adjustedPositionFraction,
            reason: 'short_allowed_premium',
            metadata: {
                ...metadata,
                adjustedLeverage,
                adjustedPositionFraction
            }
        };
    }
}
