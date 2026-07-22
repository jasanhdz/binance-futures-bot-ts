import { describe, expect, it } from 'vitest';
import {
    AegisEntryQualityGateConfig,
    AegisEntryQualityGateInput,
    evaluateAegisEntryQualityGate
} from './AegisEntryQualityGate';

const baseConfig: AegisEntryQualityGateConfig = {
    minScoreLong: 0.65,
    minScoreShort: 0.70,
    requireMomentumConfirm: true,
    antiFallingKnifeEnabled: true,
    antiFallingKnifeLookbackCandles: 3,
    maxAdverseRecentReturn: 0.003,
    overextensionEnabled: true,
    emaDistanceLimit: 0.006,
    volatilityEnabled: true,
    maxAtrPercentile: 0.75
};

function candles(closes: number[]) {
    return closes.map((close, index) => ({
        open: close,
        high: close * 1.001,
        low: close * 0.999,
        close,
        volume: 100,
        timestamp: index
    }));
}

function input(overrides: Partial<AegisEntryQualityGateInput> = {}): AegisEntryQualityGateInput {
    return {
        enabled: true,
        mode: 'SHADOW',
        symbol: 'BTCUSDT',
        side: 'LONG',
        turboScore: 0.82,
        votes: { long: 3, short: 0, neutral: 0 },
        recentCandles: candles([100, 100.1, 100.2, 100.3]),
        currentPrice: 100.3,
        emaFast: 100.1,
        atrPct: 0.002,
        atrPercentile: 0.50,
        config: baseConfig,
        ...overrides
    };
}

describe('evaluateAegisEntryQualityGate', () => {
    it('disabled permite', () => {
        const decision = evaluateAegisEntryQualityGate(input({ enabled: false }));

        expect(decision).toMatchObject({
            allowed: true,
            wouldBlock: false,
            action: 'ALLOW',
            reason: 'entry_quality_disabled'
        });
    });

    it('SHADOW score bajo devuelve SHADOW_BLOCK pero allowed=true', () => {
        const decision = evaluateAegisEntryQualityGate(input({ turboScore: 0.60 }));

        expect(decision).toMatchObject({
            allowed: true,
            wouldBlock: true,
            action: 'SHADOW_BLOCK',
            reason: 'score_below_entry_quality_threshold'
        });
    });

    it('ENFORCE score bajo devuelve BLOCK y allowed=false', () => {
        const decision = evaluateAegisEntryQualityGate(input({ mode: 'ENFORCE', turboScore: 0.60 }));

        expect(decision).toMatchObject({
            allowed: false,
            wouldBlock: true,
            action: 'BLOCK',
            reason: 'score_below_entry_quality_threshold'
        });
    });

    it('LONG con momentum negativo devuelve momentum block', () => {
        const decision = evaluateAegisEntryQualityGate(input({
            recentCandles: candles([100, 100.1, 100.0, 99.95]),
            currentPrice: 99.95,
            emaFast: 99.9
        }));

        expect(decision.action).toBe('SHADOW_BLOCK');
        expect(decision.reason).toBe('momentum_not_confirmed');
        expect(decision.metadata.failedChecks).toContain('momentum_not_confirmed');
    });

    it('SHORT con momentum positivo devuelve momentum block', () => {
        const decision = evaluateAegisEntryQualityGate(input({
            side: 'SHORT',
            votes: { long: 0, short: 3, neutral: 0 },
            recentCandles: candles([100, 99.9, 100.0, 100.05]),
            currentPrice: 100.05,
            emaFast: 100.2
        }));

        expect(decision.action).toBe('SHADOW_BLOCK');
        expect(decision.reason).toBe('momentum_not_confirmed');
        expect(decision.metadata.failedChecks).toContain('momentum_not_confirmed');
    });

    it('LONG overextended devuelve overextended_long', () => {
        const decision = evaluateAegisEntryQualityGate(input({
            currentPrice: 101,
            emaFast: 100
        }));

        expect(decision.reason).toBe('overextended_long');
    });

    it('SHORT overextended devuelve overextended_short', () => {
        const decision = evaluateAegisEntryQualityGate(input({
            side: 'SHORT',
            votes: { long: 0, short: 3, neutral: 0 },
            recentCandles: candles([100, 99.9, 99.8, 99.7]),
            currentPrice: 99,
            emaFast: 100
        }));

        expect(decision.reason).toBe('overextended_short');
    });

    it('Volatility alta devuelve volatility_too_high', () => {
        const decision = evaluateAegisEntryQualityGate(input({
            atrPercentile: 0.90
        }));

        expect(decision.reason).toBe('volatility_too_high');
    });

    it('does not reinterpret canonical LONG through legacy 3-of-3 votes', () => {
        const decision = evaluateAegisEntryQualityGate(input({
            symbol: 'ETHUSDT',
            votes: { long: 2, short: 0, neutral: 1 }
        }));

        expect(decision.reason).toBe('entry_quality_passed');
    });

    it('does not reinterpret canonical SHORT through legacy 3-of-3 votes', () => {
        const decision = evaluateAegisEntryQualityGate(input({
            symbol: 'DOGEUSDT',
            side: 'SHORT',
            votes: { long: 0, short: 2, neutral: 1 },
            recentCandles: candles([100, 99.9, 99.8, 99.7]),
            currentPrice: 99.7,
            emaFast: 100
        }));

        expect(decision.reason).toBe('entry_quality_passed');
    });

    it('Passing setup devuelve SHADOW_ALLOW', () => {
        const decision = evaluateAegisEntryQualityGate(input());

        expect(decision).toMatchObject({
            allowed: true,
            wouldBlock: false,
            action: 'SHADOW_ALLOW',
            reason: 'entry_quality_passed'
        });
    });

    it('Passing setup en ENFORCE devuelve ALLOW', () => {
        const decision = evaluateAegisEntryQualityGate(input({ mode: 'ENFORCE' }));

        expect(decision).toMatchObject({
            allowed: true,
            wouldBlock: false,
            action: 'ALLOW',
            reason: 'entry_quality_passed'
        });
    });

    it('Insufficient data no bloquea en SHADOW', () => {
        const decision = evaluateAegisEntryQualityGate(input({
            recentCandles: [],
            currentPrice: undefined,
            emaFast: undefined,
            atrPercentile: undefined
        }));

        expect(decision).toMatchObject({
            allowed: true,
            wouldBlock: false,
            action: 'SHADOW_ALLOW',
            reason: 'insufficient_data'
        });
    });
});
