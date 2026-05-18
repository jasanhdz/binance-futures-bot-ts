import { describe, expect, it } from 'vitest';
import {
    DEFAULT_AEGIS_CLEAN_ENTRY_GUARD_CONFIG,
    evaluateAegisCleanEntryGuard,
    AegisCleanEntryGuardInput
} from './AegisCleanEntryGuard';

function input(overrides: Partial<AegisCleanEntryGuardInput> = {}): AegisCleanEntryGuardInput {
    return {
        ...DEFAULT_AEGIS_CLEAN_ENTRY_GUARD_CONFIG,
        enabled: true,
        mode: 'SHADOW',
        symbol: 'ETHUSDT',
        side: 'LONG',
        turboScore: 0.91,
        votes: { long: 3, short: 0, neutral: 0 },
        setupGrade: 'A',
        decisionBrain: 'ENTER_NOW',
        entryQualityRecommendation: 'ALLOW_SHADOW',
        entryQualityGateReason: 'entry_quality_passed',
        entryQualityScore: 0.82,
        tailRiskScore: 0.32,
        eventRiskMode: 'NORMAL',
        eventRiskWouldBlock: false,
        eventRiskReason: 'event_risk_normal',
        isPremiumSymbol: false,
        ...overrides
    };
}

describe('AegisCleanEntryGuard', () => {
    it('disabled permite', () => {
        const decision = evaluateAegisCleanEntryGuard(input({ enabled: false }));

        expect(decision.allowed).toBe(true);
        expect(decision.decision).toBe('DISABLED');
        expect(decision.wouldBlock).toBe(false);
    });

    it('clean input permite ALLOW_CLEAN', () => {
        const decision = evaluateAegisCleanEntryGuard(input());

        expect(decision.allowed).toBe(true);
        expect(decision.decision).toBe('ALLOW_CLEAN');
        expect(decision.clean).toBe(true);
        expect(decision.dirty).toBe(false);
    });

    it('insufficient_data en SHADOW devuelve SHADOW_WAIT_CONFIRMATION y allowed=true', () => {
        const decision = evaluateAegisCleanEntryGuard(input({
            entryQualityGateReason: 'insufficient_data'
        }));

        expect(decision.allowed).toBe(true);
        expect(decision.decision).toBe('SHADOW_WAIT_CONFIRMATION');
        expect(decision.reasons).toContain('clean_entry_insufficient_data');
    });

    it('insufficient_data en ENFORCE devuelve WAIT_CONFIRMATION y allowed=false', () => {
        const decision = evaluateAegisCleanEntryGuard(input({
            mode: 'ENFORCE',
            entryQualityGateReason: 'insufficient_data'
        }));

        expect(decision.allowed).toBe(false);
        expect(decision.decision).toBe('WAIT_CONFIRMATION');
        expect(decision.reasons).toContain('clean_entry_insufficient_data');
    });

    it('eventRiskWouldBlock=true marca dirty', () => {
        const decision = evaluateAegisCleanEntryGuard(input({
            eventRiskWouldBlock: true,
            eventRiskMode: 'CAUTION',
            eventRiskReason: 'caution_quality_too_low'
        }));

        expect(decision.dirty).toBe(true);
        expect(decision.reasons).toContain('clean_entry_event_risk_would_block');
    });

    it('tailRiskScore >=0.45 marca dirty', () => {
        const decision = evaluateAegisCleanEntryGuard(input({
            tailRiskScore: 0.45
        }));

        expect(decision.dirty).toBe(true);
        expect(decision.reasons).toContain('clean_entry_tail_risk_high');
    });

    it('tailRiskScore <=0.40 permite si demás limpio', () => {
        const decision = evaluateAegisCleanEntryGuard(input({
            tailRiskScore: 0.40
        }));

        expect(decision.decision).toBe('ALLOW_CLEAN');
        expect(decision.allowed).toBe(true);
    });

    it('EntryQuality != ALLOW marca dirty', () => {
        const decision = evaluateAegisCleanEntryGuard(input({
            entryQualityRecommendation: 'BLOCK_SHADOW'
        }));

        expect(decision.dirty).toBe(true);
        expect(decision.reasons).toContain('clean_entry_quality_not_allow');
    });

    it('DecisionBrain != ENTER_NOW marca dirty', () => {
        const decision = evaluateAegisCleanEntryGuard(input({
            decisionBrain: 'WAIT_CONFIRMATION'
        }));

        expect(decision.dirty).toBe(true);
        expect(decision.reasons).toContain('clean_entry_decision_brain_not_enter_now');
    });

    it('A_PLUS no basta para permitir si insufficient_data', () => {
        const decision = evaluateAegisCleanEntryGuard(input({
            setupGrade: 'A_PLUS',
            turboScore: 0.98,
            tailRiskScore: 0.30,
            entryQualityGateReason: 'insufficient_data'
        }));

        expect(decision.decision).toBe('SHADOW_WAIT_CONFIRMATION');
        expect(decision.clean).toBe(false);
        expect(decision.metadata.setupGrade).toBe('A_PLUS');
    });

    it('extreme momentum candidate se marca solo en shadow', () => {
        const shadow = evaluateAegisCleanEntryGuard(input({
            mode: 'SHADOW',
            turboScore: 0.98,
            votes: { long: 3, short: 0, neutral: 0 },
            tailRiskScore: 0.30,
            entryQualityGateReason: 'insufficient_data'
        }));
        const enforce = evaluateAegisCleanEntryGuard(input({
            mode: 'ENFORCE',
            turboScore: 0.98,
            votes: { long: 3, short: 0, neutral: 0 },
            tailRiskScore: 0.30,
            entryQualityGateReason: 'insufficient_data'
        }));

        expect(shadow.metadata.extremeMomentumCandidate).toBe(true);
        expect(enforce.metadata.extremeMomentumCandidate).toBe(false);
    });

    it('razones múltiples se reportan', () => {
        const decision = evaluateAegisCleanEntryGuard(input({
            decisionBrain: 'WAIT_CONFIRMATION',
            entryQualityRecommendation: 'BLOCK_SHADOW',
            entryQualityGateReason: 'insufficient_data',
            tailRiskScore: 0.52,
            eventRiskWouldBlock: true
        }));

        expect(decision.reasons).toEqual(expect.arrayContaining([
            'clean_entry_decision_brain_not_enter_now',
            'clean_entry_quality_not_allow',
            'clean_entry_insufficient_data',
            'clean_entry_tail_risk_high',
            'clean_entry_event_risk_would_block'
        ]));
    });
});
