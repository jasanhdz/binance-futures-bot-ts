import { describe, expect, it } from 'vitest';
import {
    DEFAULT_AEGIS_CLEAN_ENTRY_GUARD_CONFIG,
    evaluateAegisCleanEntryGuard,
    AegisCleanEntryGuardInput
} from './AegisCleanEntryGuard';

function input(overrides: Partial<AegisCleanEntryGuardInput> = {}): AegisCleanEntryGuardInput {
    const merged: AegisCleanEntryGuardInput = {
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
        entryQualityModelPresent: true,
        entryQualityModelRecommendation: 'ALLOW_SHADOW',
        entryQualityModelScore: 0.82,
        entryQualityModelFeatureStatus: 'ok',
        entryQualityModelFeatureParityPct: 100,
        entryQualityModelMissingFeaturesCount: 0,
        entryQualityModelScope: 'global',
        entryQualityModelVersion: 'v020',
        entryQualityGateReason: 'entry_quality_passed',
        entryQualityGateAction: 'SHADOW_ALLOW',
        entryQualityRuleGateReason: 'entry_quality_passed',
        entryQualityRuleGateDecision: 'SHADOW_ALLOW',
        entryQualityScore: 0.82,
        tailRiskScore: 0.32,
        eventRiskMode: 'NORMAL',
        eventRiskWouldBlock: false,
        eventRiskReason: 'event_risk_normal',
        isPremiumSymbol: false,
        ...overrides
    };
    if (overrides.entryQualityRecommendation && !overrides.entryQualityModelRecommendation) {
        merged.entryQualityModelRecommendation = overrides.entryQualityRecommendation;
    }
    if (overrides.entryQualityGateReason && !overrides.entryQualityRuleGateReason) {
        merged.entryQualityRuleGateReason = overrides.entryQualityGateReason;
    }
    if (overrides.entryQualityGateAction && !overrides.entryQualityRuleGateDecision) {
        merged.entryQualityRuleGateDecision = overrides.entryQualityGateAction;
    }
    return merged;
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

    it('Python model ok + rule gate insufficient_data + EventRisk false permite ALLOW_CLEAN', () => {
        const decision = evaluateAegisCleanEntryGuard(input({
            entryQualityGateReason: 'insufficient_data'
        }));

        expect(decision.allowed).toBe(true);
        expect(decision.decision).toBe('ALLOW_CLEAN');
        expect(decision.clean).toBe(true);
        expect(decision.reasons).not.toContain('clean_entry_rule_gate_insufficient_context');
        expect(decision.metadata.entryQualityRuleGateReason).toBe('INSUFFICIENT_DATA');
        expect(decision.metadata.clean_entry_rule_gate_insufficient_context_ignored_due_to_model_ok).toBe(true);
    });

    it('Python model ok + rule gate insufficient_data + EventRisk true espera por EventRisk', () => {
        const decision = evaluateAegisCleanEntryGuard(input({
            mode: 'ENFORCE',
            entryQualityGateReason: 'insufficient_data',
            eventRiskWouldBlock: true,
            eventRiskMode: 'CAUTION'
        }));

        expect(decision.allowed).toBe(false);
        expect(decision.decision).toBe('WAIT_CONFIRMATION');
        expect(decision.reasons).toContain('clean_entry_event_risk_would_block');
        expect(decision.reasons).not.toContain('clean_entry_rule_gate_insufficient_context');
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

    it('Python feature_status partial espera por model_features_missing', () => {
        const decision = evaluateAegisCleanEntryGuard(input({
            entryQualityModelFeatureStatus: 'partial'
        }));

        expect(decision.dirty).toBe(true);
        expect(decision.reasons).toContain('clean_entry_model_features_missing');
    });

    it('Python model missing espera por model_features_missing', () => {
        const decision = evaluateAegisCleanEntryGuard(input({
            entryQualityModelPresent: false
        }));

        expect(decision.dirty).toBe(true);
        expect(decision.reasons).toContain('clean_entry_model_features_missing');
    });

    it('Python feature_parity <95 espera por model_features_missing', () => {
        const decision = evaluateAegisCleanEntryGuard(input({
            entryQualityModelFeatureParityPct: 94.9
        }));

        expect(decision.dirty).toBe(true);
        expect(decision.reasons).toContain('clean_entry_model_features_missing');
    });

    it('EntryQuality BLOCK_SHADOW marca dirty por model_block_shadow', () => {
        const decision = evaluateAegisCleanEntryGuard(input({
            entryQualityRecommendation: 'BLOCK_SHADOW',
            entryQualityModelRecommendation: 'BLOCK_SHADOW'
        }));

        expect(decision.dirty).toBe(true);
        expect(decision.reasons).toContain('clean_entry_model_block_shadow');
    });

    it('DecisionBrain != ENTER_NOW marca dirty', () => {
        const decision = evaluateAegisCleanEntryGuard(input({
            decisionBrain: 'WAIT_CONFIRMATION'
        }));

        expect(decision.dirty).toBe(true);
        expect(decision.reasons).toContain('clean_entry_decision_brain_not_enter_now');
    });

    it('TailRisk mayor al max limpio espera por tail_risk_high', () => {
        const decision = evaluateAegisCleanEntryGuard(input({
            tailRiskScore: 0.41
        }));

        expect(decision.dirty).toBe(true);
        expect(decision.reasons).toContain('clean_entry_tail_risk_high');
    });

    it('rule gate insufficient_data queda en metadata pero no bloquea si model ok', () => {
        const decision = evaluateAegisCleanEntryGuard(input({
            entryQualityGateReason: 'insufficient_data'
        }));

        expect(decision.decision).toBe('ALLOW_CLEAN');
        expect(decision.metadata.entryQualityRuleGateReason).toBe('INSUFFICIENT_DATA');
        expect(decision.metadata.entryQualityGateReason).toBe('INSUFFICIENT_DATA');
    });

    it('ADA-like: model ALLOW con rule insufficient bloquea solo por EventRisk', () => {
        const decision = evaluateAegisCleanEntryGuard(input({
            symbol: 'ADAUSDT',
            mode: 'ENFORCE',
            turboScore: 0.94,
            entryQualityModelRecommendation: 'ALLOW',
            entryQualityRecommendation: 'ALLOW',
            entryQualityModelScore: 0.94,
            entryQualityScore: 0.94,
            tailRiskScore: 0.29,
            entryQualityGateReason: 'insufficient_data',
            eventRiskWouldBlock: true,
            eventRiskMode: 'CAUTION'
        }));

        expect(decision.allowed).toBe(false);
        expect(decision.reasons).toEqual(['clean_entry_event_risk_would_block']);
    });

    it('clean case model ok + EventRisk false permite', () => {
        const decision = evaluateAegisCleanEntryGuard(input({
            eventRiskWouldBlock: false
        }));

        expect(decision.decision).toBe('ALLOW_CLEAN');
        expect(decision.allowed).toBe(true);
    });

    it('extreme momentum candidate se marca solo en shadow', () => {
        const shadow = evaluateAegisCleanEntryGuard(input({
            mode: 'SHADOW',
            turboScore: 0.98,
            votes: { long: 3, short: 0, neutral: 0 },
            tailRiskScore: 0.30,
            entryQualityGateReason: 'insufficient_data',
            decisionBrain: 'WAIT_CONFIRMATION'
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
            entryQualityModelRecommendation: 'BLOCK_SHADOW',
            entryQualityGateReason: 'insufficient_data',
            tailRiskScore: 0.52,
            eventRiskWouldBlock: true
        }));

        expect(decision.reasons).toEqual(expect.arrayContaining([
            'clean_entry_decision_brain_not_enter_now',
            'clean_entry_model_block_shadow',
            'clean_entry_tail_risk_high',
            'clean_entry_event_risk_would_block'
        ]));
    });
});
