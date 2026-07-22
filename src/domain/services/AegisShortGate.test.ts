import { describe, expect, it } from 'vitest';
import { AegisShortGate, AegisShortGateConfig } from './AegisShortGate';

const config: AegisShortGateConfig = {
    enabled: true,
    mode: 'PREMIUM_ONLY',
    min_score: 0.80,
    require_votes: 3,
    position_fraction_multiplier: 1.0,
    max_leverage: 10,
    block_symbols: []
};

describe('AegisShortGate', () => {
    it('allows LONG without changes', () => {
        const decision = AegisShortGate.evaluate({
            symbol: 'BTCUSDT',
            side: 'LONG',
            turboScore: 0.4,
            votes: { long: 2 },
            leverage: 20,
            positionFraction: 0.12,
            config
        });

        expect(decision).toMatchObject({
            allowed: true,
            reason: 'not_short',
            adjustedLeverage: 20,
            adjustedPositionFraction: 0.12
        });
    });

    it('blocks SHORT by symbol', () => {
        const decision = AegisShortGate.evaluate({
            symbol: 'AVAXUSDT',
            side: 'SHORT',
            turboScore: 0.91,
            votes: { short: 3 },
            leverage: 20,
            positionFraction: 0.12,
            config: { ...config, block_symbols: ['AVAXUSDT'] }
        });

        expect(decision.allowed).toBe(false);
        expect(decision.reason).toBe('short_symbol_blocked');
    });

    it('blocks SHORT by low score', () => {
        const decision = AegisShortGate.evaluate({
            symbol: 'BTCUSDT',
            side: 'SHORT',
            turboScore: 0.79,
            votes: { short: 3 },
            leverage: 20,
            positionFraction: 0.12,
            config
        });

        expect(decision.allowed).toBe(false);
        expect(decision.reason).toBe('short_score_below_premium_threshold');
    });

    it('blocks SHORT by insufficient votes', () => {
        const decision = AegisShortGate.evaluate({
            symbol: 'BTCUSDT',
            side: 'SHORT',
            turboScore: 0.84,
            votes: { short: 2, neutral: 1 },
            leverage: 20,
            positionFraction: 0.12,
            config
        });

        expect(decision.allowed).toBe(false);
        expect(decision.reason).toBe('short_votes_below_required');
    });

    it('uses an authorized canonical decision instead of legacy score and vote semantics', () => {
        const decision = AegisShortGate.evaluate({
            symbol: 'BTCUSDT',
            side: 'SHORT',
            turboScore: 0.00001,
            votes: { short: 1 },
            canonicalDecisionAuthorized: true,
            leverage: 20,
            positionFraction: 0.12,
            config
        });

        expect(decision).toMatchObject({
            allowed: true,
            reason: 'short_allowed_current_brain_canonical',
            adjustedLeverage: 10,
            adjustedPositionFraction: 0.12
        });
    });

    it('keeps symbol blocking active for an authorized canonical decision', () => {
        const decision = AegisShortGate.evaluate({
            symbol: 'AVAXUSDT',
            side: 'SHORT',
            canonicalDecisionAuthorized: true,
            leverage: 20,
            positionFraction: 0.12,
            config: { ...config, block_symbols: ['AVAXUSDT'] }
        });

        expect(decision.reason).toBe('short_symbol_blocked');
    });

    it('allows premium SHORT with high score and 3/3 votes', () => {
        const decision = AegisShortGate.evaluate({
            symbol: 'BTCUSDT',
            side: 'SHORT',
            turboScore: 0.84,
            votes: { short: 3, long: 0, neutral: 0 },
            leverage: 8,
            positionFraction: 0.12,
            config
        });

        expect(decision.allowed).toBe(true);
        expect(decision.reason).toBe('short_allowed_premium');
    });

    it('does not reduce positionFraction when multiplier is 1.0', () => {
        const decision = AegisShortGate.evaluate({
            symbol: 'BTCUSDT',
            side: 'SHORT',
            turboScore: 0.84,
            votes: { short: 3 },
            leverage: 8,
            positionFraction: 0.12,
            config
        });

        expect(decision.adjustedPositionFraction).toBeCloseTo(0.12);
    });

    it('does not block a symbol when block_symbols is empty', () => {
        const decision = AegisShortGate.evaluate({
            symbol: 'AVAXUSDT',
            side: 'SHORT',
            turboScore: 0.84,
            votes: { short: 3 },
            leverage: 8,
            positionFraction: 0.12,
            config
        });

        expect(decision.allowed).toBe(true);
        expect(decision.reason).toBe('short_allowed_premium');
    });

    it('applies maxLeverage when premium SHORT is allowed', () => {
        const decision = AegisShortGate.evaluate({
            symbol: 'BTCUSDT',
            side: 'SHORT',
            turboScore: 0.84,
            votes: { short: 3 },
            leverage: 20,
            positionFraction: 0.12,
            config
        });

        expect(decision.adjustedLeverage).toBe(10);
    });
});
