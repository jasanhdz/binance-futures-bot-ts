import { describe, expect, it } from 'vitest';
import { evaluateAegisLongRiskShadow } from './AegisLongRiskShadowGuardAdapter';

describe('AegisLongRiskShadowGuardAdapter', () => {
    it('marks ETH-like weak LONGs as high risk', () => {
        const result = evaluateAegisLongRiskShadow({
            symbol: 'ETHUSDT',
            side: 'LONG',
            entryQualityReason: 'insufficient_data',
            entryQualityRecommendation: 'ALLOW',
            btcAction: 'HOLD',
            regimeWouldBlock: true,
            regimeLogged: 'UNKNOWN',
            regimeEngineV2Environment: 'WATCH_SHORT_MOMENTUM',
            regimeEngineV2TechnicalRegime: 'MOMENTUM_DOWN_EARLY',
            regimeEngineV2TransitionRisk: 'MODERATE',
            marketWeakness: {
                belowEma25: true,
                return30m: -0.0028,
                return60m: -0.0037,
                closeLocation: 0.20,
                volumeRatio: 2.03
            }
        });

        expect(result.decision).toBe('SHADOW_DENY');
        expect(['HIGH', 'CRITICAL']).toContain(result.riskLevel);
        expect(['DELAY_ONE_CANDLE_SHADOW', 'WOULD_BLOCK_SHADOW']).toContain(result.suggestedAction);
        expect(result.reasons).toEqual(expect.arrayContaining([
            'long_risk_shadow_entry_quality_insufficient',
            'long_risk_shadow_weak_regime',
            'long_risk_shadow_down_momentum',
            'long_risk_shadow_btc_eth_not_confirmed'
        ]));
    });

    it('marks ADA-like probe LONGs as critical risk', () => {
        const result = evaluateAegisLongRiskShadow({
            symbol: 'ADAUSDT',
            side: 'LONG',
            entryQualityReason: 'insufficient_data',
            entryQualityRecommendation: 'ALLOW_SHADOW',
            cleanEntryDecision: 'WAIT',
            eventRiskMode: 'CAUTION',
            eventRiskWouldBlock: true,
            btcAction: 'HOLD',
            ethAction: 'PASS',
            regimeLogged: 'CHOP',
            regimeWouldBlock: true,
            regimeEngineV2Environment: 'AVOID_MOMENTUM',
            regimeEngineV2TechnicalRegime: 'MOMENTUM_DOWN_EXHAUSTED',
            regimeEngineV2TransitionRisk: 'HIGH',
            marketWeakness: {
                belowEma25: true,
                return30m: -0.002,
                return60m: -0.0016,
                closeLocation: 0,
                volumeRatio: 0.01
            }
        });

        expect(result.decision).toBe('SHADOW_DENY');
        expect(result.riskLevel).toBe('CRITICAL');
        expect(result.suggestedAction).toBe('WOULD_BLOCK_SHADOW');
        expect(result.wouldHaveBlockedShadow).toBe(true);
    });

    it('allows clean confirmed LONGs with low risk', () => {
        const result = evaluateAegisLongRiskShadow({
            symbol: 'SOLUSDT',
            side: 'LONG',
            entryQualityReason: 'entry_quality_allow',
            entryQualityRecommendation: 'ALLOW',
            entryQualityScore: 0.84,
            cleanEntryDecision: 'ALLOW',
            eventRiskMode: 'NORMAL',
            eventRiskWouldBlock: false,
            btcAction: 'LONG',
            ethAction: 'LONG',
            regimeLogged: 'MOMENTUM_UP',
            regimeWouldBlock: false,
            regimeEngineV2Environment: 'ALLOW_LONG_MOMENTUM',
            regimeEngineV2TechnicalRegime: 'MOMENTUM_UP_EARLY',
            regimeEngineV2TransitionRisk: 'LOW',
            marketWeakness: {
                belowEma25: false,
                return30m: 0.004,
                return60m: 0.008,
                closeLocation: 0.82,
                volumeRatio: 1.8
            }
        });

        expect(result.decision).toBe('ALLOW');
        expect(result.riskLevel).toBe('LOW');
        expect(result.suggestedAction).toBe('OBSERVE');
        expect(result.wouldBlock).toBe(false);
    });

    it('does not apply to SHORT setups even when warnings are present', () => {
        const result = evaluateAegisLongRiskShadow({
            symbol: 'AVAXUSDT',
            side: 'SHORT',
            entryQualityReason: 'insufficient_data',
            cleanEntryDecision: 'WAIT',
            eventRiskMode: 'CAUTION',
            eventRiskWouldBlock: true,
            btcAction: 'HOLD',
            regimeWouldBlock: true,
            regimeEngineV2Environment: 'AVOID_MOMENTUM',
            regimeEngineV2TechnicalRegime: 'CHOP',
            regimeEngineV2TransitionRisk: 'HIGH'
        });

        expect(result.decision).toBe('NOT_APPLICABLE');
        expect(result.riskScore).toBe(0);
        expect(result.wouldBlock).toBe(false);
    });
});
