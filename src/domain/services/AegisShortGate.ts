import { Side } from '../types';

export type AegisShortGateReason =
    | 'short_gate_disabled'
    | 'not_short'
    | 'short_symbol_blocked'
    | 'short_canonical_decision_required'
    | 'short_allowed_current_brain_canonical';

export interface AegisShortGateConfig {
    enabled?: boolean;
    mode?: 'PREMIUM_ONLY' | string;
    position_fraction_multiplier?: number;
    max_leverage?: number;
    block_symbols?: string[];
    allow_if_regime_bearish?: boolean;
}

export interface AegisShortGateInput {
    symbol: string;
    side: Side;
    canonicalDecisionAuthorized?: boolean;
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
        const multiplier = finiteNumber(config.position_fraction_multiplier)
            ? Math.max(0, config.position_fraction_multiplier)
            : 1;
        const maxLeverage = finiteNumber(config.max_leverage) && config.max_leverage > 0
            ? config.max_leverage
            : input.leverage;

        const metadata = {
            symbol,
            side: input.side,
            canonicalDecisionAuthorized: input.canonicalDecisionAuthorized === true,
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

        if (input.canonicalDecisionAuthorized !== true) {
            return {
                allowed: false,
                adjustedLeverage: input.leverage,
                adjustedPositionFraction: input.positionFraction,
                reason: 'short_canonical_decision_required',
                metadata
            };
        }

        const adjustedLeverage = Math.min(input.leverage, maxLeverage);
        const adjustedPositionFraction = input.positionFraction * multiplier;

        return {
            allowed: true,
            adjustedLeverage,
            adjustedPositionFraction,
            reason: 'short_allowed_current_brain_canonical',
            metadata: {
                ...metadata,
                adjustedLeverage,
                adjustedPositionFraction
            }
        };
    }
}
