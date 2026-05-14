import { describe, expect, it } from 'vitest';
import { AegisEventRiskOverlay, AegisEventRiskOverlayInput } from './AegisEventRiskOverlay';

function input(overrides: Partial<AegisEventRiskOverlayInput> = {}): AegisEventRiskOverlayInput {
    return {
        enabled: true,
        mode: 'NORMAL',
        enforce: false,
        symbol: 'SOLUSDT',
        side: 'LONG',
        turboScore: 0.82,
        entryQualityScore: 0.80,
        tailRiskScore: 0.20,
        btcAction: 'LONG',
        btcScore: 0.70,
        ethAction: 'LONG',
        ethScore: 0.69,
        isAltSymbol: true,
        config: {
            caution: {
                minQualityScore: 0.65,
                maxTailRiskScore: 0.45,
                requireBtcEthConfirmation: true
            },
            riskOff: {
                minQualityScore: 0.75,
                maxTailRiskScore: 0.35,
                allowOnlyAPlus: true
            },
            manualOnly: {
                blockNewEntries: false
            }
        },
        ...overrides
    };
}

describe('AegisEventRiskOverlay', () => {
    it('NORMAL permite', () => {
        const decision = AegisEventRiskOverlay.evaluate(input());

        expect(decision.allowed).toBe(true);
        expect(decision.wouldBlock).toBe(false);
        expect(decision.action).toBe('ALLOW');
        expect(decision.reason).toBe('event_risk_normal');
    });

    it('CAUTION con mala calidad produce SHADOW_CAUTION si enforce=false', () => {
        const decision = AegisEventRiskOverlay.evaluate(input({
            mode: 'CAUTION',
            enforce: false,
            entryQualityScore: 0.50
        }));

        expect(decision.allowed).toBe(true);
        expect(decision.wouldBlock).toBe(true);
        expect(decision.action).toBe('SHADOW_CAUTION');
        expect(decision.reason).toBe('caution_quality_too_low');
    });

    it('RISK_OFF con señal no A+ produce SHADOW_RISK_OFF_BLOCK si enforce=false', () => {
        const decision = AegisEventRiskOverlay.evaluate(input({
            mode: 'RISK_OFF',
            enforce: false,
            turboScore: 0.70
        }));

        expect(decision.allowed).toBe(true);
        expect(decision.wouldBlock).toBe(true);
        expect(decision.action).toBe('SHADOW_RISK_OFF_BLOCK');
        expect(decision.reason).toBe('risk_off_not_a_plus');
    });

    it('MANUAL_ONLY con enforce=false no bloquea', () => {
        const decision = AegisEventRiskOverlay.evaluate(input({
            mode: 'MANUAL_ONLY',
            enforce: false,
            config: {
                manualOnly: { blockNewEntries: true }
            }
        }));

        expect(decision.allowed).toBe(true);
        expect(decision.wouldBlock).toBe(true);
        expect(decision.action).toBe('SHADOW_MANUAL_ONLY');
        expect(decision.reason).toBe('manual_only_requires_approval');
    });

    it('MANUAL_ONLY con enforce=true bloquea', () => {
        const decision = AegisEventRiskOverlay.evaluate(input({
            mode: 'MANUAL_ONLY',
            enforce: true,
            config: {
                manualOnly: { blockNewEntries: true }
            }
        }));

        expect(decision.allowed).toBe(false);
        expect(decision.wouldBlock).toBe(true);
        expect(decision.action).toBe('BLOCK');
        expect(decision.reason).toBe('manual_only_requires_approval');
    });

    it('enabled=false permite', () => {
        const decision = AegisEventRiskOverlay.evaluate(input({
            enabled: false,
            mode: 'MANUAL_ONLY',
            enforce: true
        }));

        expect(decision.allowed).toBe(true);
        expect(decision.wouldBlock).toBe(false);
        expect(decision.reason).toBe('event_risk_disabled');
    });
});
