import { describe, expect, it } from 'vitest';
import {
    AegisDecisionEnforcement,
    AegisDecisionEnforcementInput,
    AegisDecisionEnforcementRuntimeConfig
} from './AegisDecisionEnforcement';

const config: AegisDecisionEnforcementRuntimeConfig = {
    enabled: true,
    mode: 'CONSERVATIVE',
    block_do_not_enter: true,
    block_wait_confirmation: true,
    block_manual_only: true,
    block_entry_quality_shadow_block_when_event_risk: {
        enabled: true,
        event_modes: ['CAUTION', 'RISK_OFF', 'MANUAL_ONLY']
    },
    event_risk_enforcement: {
        caution_blocks_weak_entries: true,
        risk_off_blocks_non_a_plus: true,
        manual_only_blocks_all_new_entries: true
    },
    block_caution_would_block_unless_a_plus: true,
    block_all_entry_quality_shadow_block: true,
    block_all_tail_risk_high: false
};

function input(overrides: Partial<AegisDecisionEnforcementInput> = {}): AegisDecisionEnforcementInput {
    return {
        symbol: 'ETHUSDT',
        side: 'LONG',
        turboScore: 0.72,
        eventRiskMode: 'NORMAL',
        decisionBrain: { decision: 'ENTER_NOW', enter_now_prob: 0.80 },
        entryQualityModel: {
            recommendation: 'ALLOW_SHADOW',
            entry_quality_score: 0.82,
            tail_risk_score: 0.20
        },
        eventRiskAuto: {
            btc_context: { action: 'LONG', score: 0.8 },
            eth_context: { action: 'LONG', score: 0.8 }
        },
        isAltSymbol: false,
        config,
        riskOffTailMax: 0.35,
        ...overrides
    };
}

describe('AegisDecisionEnforcement', () => {
    it('blocks DO_NOT_ENTER', () => {
        const decision = AegisDecisionEnforcement.evaluate(input({
            decisionBrain: { decision: 'DO_NOT_ENTER', do_not_enter_prob: 0.9 }
        }));

        expect(decision.allowed).toBe(false);
        expect(decision.reason).toBe('decision_brain_do_not_enter');
    });

    it('blocks WAIT_CONFIRMATION', () => {
        const decision = AegisDecisionEnforcement.evaluate(input({
            decisionBrain: { decision: 'WAIT_CONFIRMATION', wait_confirmation_prob: 0.7 }
        }));

        expect(decision.allowed).toBe(false);
        expect(decision.reason).toBe('decision_brain_wait_confirmation');
    });

    it('blocks MANUAL_ONLY', () => {
        const decision = AegisDecisionEnforcement.evaluate(input({
            decisionBrain: { decision: 'MANUAL_ONLY', manual_only_prob: 0.7 }
        }));

        expect(decision.allowed).toBe(false);
        expect(decision.reason).toBe('decision_brain_manual_only');
    });

    it('blocks EntryQuality BLOCK_SHADOW in NORMAL', () => {
        const decision = AegisDecisionEnforcement.evaluate(input({
            eventRiskMode: 'NORMAL',
            entryQualityModel: {
                recommendation: 'BLOCK_SHADOW',
                entry_quality_score: 0.2,
                tail_risk_score: 0.8
            }
        }));

        expect(decision.allowed).toBe(false);
        expect(decision.reason).toBe('entry_quality_shadow_block_hard_denied');
    });

    it('blocks EntryQuality BLOCK_SHADOW in CAUTION', () => {
        const decision = AegisDecisionEnforcement.evaluate(input({
            eventRiskMode: 'CAUTION',
            entryQualityModel: {
                recommendation: 'BLOCK_SHADOW',
                entry_quality_score: 0.2,
                tail_risk_score: 0.8
            }
        }));

        expect(decision.allowed).toBe(false);
        expect(decision.reason).toBe('entry_quality_shadow_block_hard_denied');
    });

    it('blocks EntryQuality BLOCK_SHADOW in RISK_OFF', () => {
        const decision = AegisDecisionEnforcement.evaluate(input({
            eventRiskMode: 'RISK_OFF',
            entryQualityModel: {
                recommendation: 'BLOCK_SHADOW',
                entry_quality_score: 0.2,
                tail_risk_score: 0.8
            }
        }));

        expect(decision.allowed).toBe(false);
        expect(decision.reason).toBe('entry_quality_shadow_block_hard_denied');
    });

    it('blocks EntryQuality BLOCK_SHADOW when DecisionBrain is UNKNOWN', () => {
        const decision = AegisDecisionEnforcement.evaluate(input({
            decisionBrain: { decision: 'UNKNOWN' },
            entryQualityModel: {
                recommendation: 'BLOCK_SHADOW',
                entry_quality_score: 0.2,
                tail_risk_score: 0.8
            }
        }));

        expect(decision.allowed).toBe(false);
        expect(decision.reason).toBe('missing_decision_brain_with_shadow_block');
    });

    it('blocks EntryQuality BLOCK_SHADOW when DecisionBrain is absent', () => {
        const decision = AegisDecisionEnforcement.evaluate(input({
            decisionBrain: null,
            entryQualityModel: {
                recommendation: 'BLOCK_SHADOW',
                entry_quality_score: 0.2,
                tail_risk_score: 0.8
            }
        }));

        expect(decision.allowed).toBe(false);
        expect(decision.reason).toBe('missing_decision_brain_with_shadow_block');
    });

    it('blocks EntryQuality gate SHADOW_BLOCK even without EntryQuality model recommendation', () => {
        const decision = AegisDecisionEnforcement.evaluate(input({
            entryQualityModel: {
                recommendation: 'UNKNOWN',
                entry_quality_score: 0.2,
                tail_risk_score: 0.8
            },
            entryQualityGate: {
                allowed: true,
                wouldBlock: true,
                action: 'SHADOW_BLOCK',
                reason: 'score_below_entry_quality_threshold',
                confidence: 'medium',
                metadata: {
                    symbol: 'ETHUSDT',
                    side: 'LONG',
                    turboScore: 0.72,
                    failedChecks: ['score_below_entry_quality_threshold']
                }
            }
        }));

        expect(decision.allowed).toBe(false);
        expect(decision.reason).toBe('entry_quality_shadow_block_hard_denied');
    });

    it('blocks CAUTION weak setup', () => {
        const decision = AegisDecisionEnforcement.evaluate(input({
            eventRiskMode: 'CAUTION',
            eventRiskWouldBlock: true,
            eventRiskReason: 'caution_quality_too_low',
            turboScore: 0.79,
            decisionBrain: { decision: 'ENTER_NOW', enter_now_prob: 0.8 },
            entryQualityModel: {
                recommendation: 'ALLOW_SHADOW',
                entry_quality_score: 0.80,
                tail_risk_score: 0.20
            }
        }));

        expect(decision.allowed).toBe(false);
        expect(decision.reason).toBe('event_risk_caution_denied_weak_setup');
        expect(decision.metadata.eventRiskReason).toBe('caution_quality_too_low');
        expect(decision.metadata.eventRiskWouldBlock).toBe(true);
        expect(decision.metadata.aPlus).toBe(false);
        expect(decision.metadata.setupGrade).toBe('WEAK');
    });

    it('allows CAUTION A+ setup', () => {
        const decision = AegisDecisionEnforcement.evaluate(input({
            eventRiskMode: 'CAUTION',
            eventRiskWouldBlock: true,
            eventRiskReason: 'caution_quality_too_low',
            turboScore: 0.95,
            decisionBrain: { decision: 'ENTER_NOW', enter_now_prob: 0.8 },
            entryQualityModel: {
                recommendation: 'ALLOW_SHADOW',
                entry_quality_score: 0.80,
                tail_risk_score: 0.20
            }
        }));

        expect(decision.allowed).toBe(true);
        expect(decision.reason).toBe('event_risk_caution_allowed_strong_setup');
        expect(decision.metadata.setupGrade).toBe('A_PLUS');
    });

    it('allows CAUTION A setup', () => {
        const decision = AegisDecisionEnforcement.evaluate(input({
            eventRiskMode: 'CAUTION',
            eventRiskWouldBlock: true,
            eventRiskReason: 'caution_quality_too_low',
            turboScore: 0.85,
            decisionBrain: { decision: 'ENTER_NOW', enter_now_prob: 0.8 },
            entryQualityModel: {
                recommendation: 'ALLOW_SHADOW',
                entry_quality_score: 0.80,
                tail_risk_score: 0.45
            }
        }));

        expect(decision.allowed).toBe(true);
        expect(decision.reason).toBe('event_risk_caution_allowed_strong_setup');
        expect(decision.metadata.setupGrade).toBe('A');
    });

    it('blocks CAUTION A+ setup when EntryQuality is BLOCK_SHADOW', () => {
        const decision = AegisDecisionEnforcement.evaluate(input({
            eventRiskMode: 'CAUTION',
            eventRiskWouldBlock: true,
            eventRiskReason: 'caution_btc_eth_not_confirmed',
            turboScore: 0.95,
            decisionBrain: { decision: 'ENTER_NOW', enter_now_prob: 0.8 },
            entryQualityModel: {
                recommendation: 'BLOCK_SHADOW',
                entry_quality_score: 0.82,
                tail_risk_score: 0.20
            }
        }));

        expect(decision.allowed).toBe(false);
        expect(decision.reason).toBe('entry_quality_shadow_block_hard_denied');
    });

    it('blocks CAUTION when DecisionBrain is WAIT_CONFIRMATION', () => {
        const decision = AegisDecisionEnforcement.evaluate(input({
            eventRiskMode: 'CAUTION',
            eventRiskWouldBlock: true,
            eventRiskReason: 'caution_quality_too_low',
            turboScore: 0.95,
            decisionBrain: { decision: 'WAIT_CONFIRMATION', wait_confirmation_prob: 0.8 },
            entryQualityModel: {
                recommendation: 'ALLOW_SHADOW',
                entry_quality_score: 0.82,
                tail_risk_score: 0.20
            }
        }));

        expect(decision.allowed).toBe(false);
        expect(decision.reason).toBe('decision_brain_wait_confirmation');
    });

    it('blocks CAUTION when DecisionBrain is DO_NOT_ENTER', () => {
        const decision = AegisDecisionEnforcement.evaluate(input({
            eventRiskMode: 'CAUTION',
            eventRiskWouldBlock: true,
            eventRiskReason: 'caution_tail_too_high',
            turboScore: 0.95,
            decisionBrain: { decision: 'DO_NOT_ENTER', do_not_enter_prob: 0.8 },
            entryQualityModel: {
                recommendation: 'ALLOW_SHADOW',
                entry_quality_score: 0.82,
                tail_risk_score: 0.20
            }
        }));

        expect(decision.allowed).toBe(false);
        expect(decision.reason).toBe('decision_brain_do_not_enter');
    });

    it('blocks CAUTION when tail risk is above A threshold', () => {
        const decision = AegisDecisionEnforcement.evaluate(input({
            eventRiskMode: 'CAUTION',
            eventRiskWouldBlock: true,
            eventRiskReason: 'caution_tail_too_high',
            turboScore: 0.95,
            decisionBrain: { decision: 'ENTER_NOW', enter_now_prob: 0.8 },
            entryQualityModel: {
                recommendation: 'ALLOW_SHADOW',
                entry_quality_score: 0.82,
                tail_risk_score: 0.51
            }
        }));

        expect(decision.allowed).toBe(false);
        expect(decision.reason).toBe('event_risk_caution_denied_weak_setup');
        expect(decision.metadata.setupGrade).toBe('WEAK');
    });

    it('blocks non-A+ setup in RISK_OFF', () => {
        const decision = AegisDecisionEnforcement.evaluate(input({
            eventRiskMode: 'RISK_OFF',
            turboScore: 0.95,
            decisionBrain: { decision: 'ENTER_NOW', enter_now_prob: 0.8 },
            entryQualityModel: {
                recommendation: 'ALLOW_SHADOW',
                entry_quality_score: 0.8,
                tail_risk_score: 0.6
            }
        }));

        expect(decision.allowed).toBe(false);
        expect(decision.reason).toBe('event_risk_risk_off_denied_non_a_plus');
    });

    it('blocks A setup in RISK_OFF', () => {
        const decision = AegisDecisionEnforcement.evaluate(input({
            eventRiskMode: 'RISK_OFF',
            turboScore: 0.85,
            decisionBrain: { decision: 'ENTER_NOW', enter_now_prob: 0.8 },
            entryQualityModel: {
                recommendation: 'ALLOW_SHADOW',
                entry_quality_score: 0.8,
                tail_risk_score: 0.45
            }
        }));

        expect(decision.allowed).toBe(false);
        expect(decision.reason).toBe('event_risk_risk_off_denied_non_a_plus');
        expect(decision.metadata.setupGrade).toBe('A');
    });

    it('allows ENTER_NOW A+ in RISK_OFF', () => {
        const decision = AegisDecisionEnforcement.evaluate(input({
            eventRiskMode: 'RISK_OFF',
            symbol: 'SUIUSDT',
            isAltSymbol: true,
            turboScore: 0.95,
            decisionBrain: { decision: 'ENTER_NOW', enter_now_prob: 0.8 },
            entryQualityModel: {
                recommendation: 'ALLOW_SHADOW',
                entry_quality_score: 0.82,
                tail_risk_score: 0.2
            },
            eventRiskAuto: {
                btc_context: { action: 'LONG', score: 0.8 },
                eth_context: { action: 'LONG', score: 0.8 }
            }
        }));

        expect(decision.allowed).toBe(true);
        expect(decision.reason).toBe('event_risk_risk_off_allowed_a_plus');
        expect(decision.metadata.setupGrade).toBe('A_PLUS');
    });

    it('blocks all new entries in MANUAL_ONLY', () => {
        const decision = AegisDecisionEnforcement.evaluate(input({
            eventRiskMode: 'MANUAL_ONLY',
            turboScore: 0.95,
            decisionBrain: { decision: 'ENTER_NOW', enter_now_prob: 0.8 },
            entryQualityModel: {
                recommendation: 'ALLOW_SHADOW',
                entry_quality_score: 0.90,
                tail_risk_score: 0.10
            }
        }));

        expect(decision.allowed).toBe(false);
        expect(decision.reason).toBe('event_risk_manual_only');
        expect(decision.metadata.setupGrade).toBe('WEAK');
    });

    it('allows A+ without BLOCK_SHADOW in NORMAL', () => {
        const decision = AegisDecisionEnforcement.evaluate(input({
            eventRiskMode: 'NORMAL',
            decisionBrain: { decision: 'ENTER_NOW', enter_now_prob: 0.8 },
            entryQualityModel: {
                recommendation: 'ALLOW_SHADOW',
                entry_quality_score: 0.88,
                tail_risk_score: 0.12
            }
        }));

        expect(decision.allowed).toBe(true);
        expect(decision.reason).toBe('decision_enforcement_allow');
    });

    it('disabled config allows', () => {
        const decision = AegisDecisionEnforcement.evaluate(input({
            config: { ...config, enabled: false },
            decisionBrain: { decision: 'DO_NOT_ENTER' }
        }));

        expect(decision.allowed).toBe(true);
        expect(decision.reason).toBe('decision_enforcement_disabled');
    });
});
