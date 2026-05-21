import { describe, expect, it } from 'vitest';
import { AegisDecisionEnforcementRuntimeConfig } from '../AegisDecisionEnforcement';
import { DEFAULT_AEGIS_CLEAN_ENTRY_GUARD_CONFIG } from '../AegisCleanEntryGuard';
import { AegisEntryGuardOrchestrator } from './AegisEntryGuardOrchestrator';
import {
    AegisEntryContext,
    AegisEntryGuardName,
    AegisEntryPolicyRuntimeConfig
} from './AegisEntryDecisionTypes';

const decisionEnforcementConfig: AegisDecisionEnforcementRuntimeConfig = {
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
    block_all_tail_risk_high: true
};

const guardNames: AegisEntryGuardName[] = [
    'short_gate',
    'entry_quality',
    'event_risk',
    'decision_brain',
    'clean_entry',
    'probe_mode'
];

function policy(overrides: Partial<AegisEntryPolicyRuntimeConfig['guards']> = {}): AegisEntryPolicyRuntimeConfig {
    return {
        enabled: true,
        guards: {
            short_gate: { enabled: true, mode: 'ENFORCE' },
            entry_quality: { enabled: true, mode: 'ENFORCE' },
            event_risk: { enabled: true, mode: 'ENFORCE' },
            decision_brain: { enabled: true, mode: 'ENFORCE' },
            clean_entry: { enabled: true, mode: 'ENFORCE' },
            probe_mode: { enabled: true, mode: 'ENFORCE' },
            ...overrides
        }
    };
}

function baseContext(overrides: Partial<AegisEntryContext> = {}): AegisEntryContext {
    return {
        symbol: 'ADAUSDT',
        side: 'LONG',
        rawAction: 'LONG',
        finalAction: 'LONG',
        turboScore: 0.94,
        votes: { long: 3, short: 0, neutral: 0 },
        setupGrade: 'A',
        leverage: 20,
        requestedPositionFraction: 0.1,
        basePositionFraction: 0.1,
        signal: {
            symbol: 'ADAUSDT',
            action: 'LONG',
            confidence: 0.94,
            source: 'AEGIS_TURBO',
            longProb: 0.94,
            shortProb: 0.03,
            neutralProb: 0.03
        },
        gate: {
            allowed: true,
            side: 'LONG',
            reason: 'test_allowed',
            leverage: 20,
            positionFraction: 0.1,
            stopRoe: -0.15,
            takeProfitRoe: 0.25,
            trailingActivationRoe: 0.15,
            trailingCallbackRoe: 0.08,
            turboScore: 0.94,
            votes: { long: 3, short: 0, neutral: 0 }
        },
        decisionBrain: {
            decision: 'ENTER_NOW',
            confidence: 0.8,
            reason: 'enter_now',
            block: { decision: 'ENTER_NOW', enter_now_prob: 0.8 }
        },
        entryQuality: {
            model: {
                recommendation: 'ALLOW_SHADOW',
                entry_quality_score: 0.82,
                tail_risk_score: 0.2,
                feature_status: 'ok',
                feature_parity_pct: 100,
                missing_features_count: 0,
                model_scope: 'test',
                model_version: 'test'
            },
            recommendation: 'ALLOW_SHADOW',
            entryQualityScore: 0.82,
            tailRiskScore: 0.2,
            featureStatus: 'ok',
            featureParityPct: 100,
            missingFeaturesCount: 0,
            modelScope: 'test',
            modelVersion: 'test',
            ruleGate: {
                enabled: true,
                mode: 'ENFORCE',
                config: {
                    minScoreLong: 0.65,
                    minScoreShort: 0.70,
                    requireMomentumConfirm: false,
                    antiFallingKnifeEnabled: false,
                    antiFallingKnifeLookbackCandles: 3,
                    maxAdverseRecentReturn: 0.003,
                    overextensionEnabled: false,
                    emaDistanceLimit: 0.006,
                    volatilityEnabled: false,
                    maxAtrPercentile: 0.75,
                    require3of3WhenSymbolFlagged: false,
                    flaggedSymbols: []
                },
                currentPrice: 1,
                emaFast: 1,
                recentCandles: [
                    { open: 1, high: 1.01, low: 0.99, close: 1 },
                    { open: 1, high: 1.02, low: 0.99, close: 1.01 },
                    { open: 1.01, high: 1.03, low: 1, close: 1.02 },
                    { open: 1.02, high: 1.04, low: 1.01, close: 1.03 }
                ]
            }
        },
        eventRisk: {
            enabled: true,
            mode: 'NORMAL',
            enforce: true,
            isAltSymbol: true,
            reason: 'event_risk_normal',
            wouldBlock: false,
            confidence: undefined,
            config: {
                caution: {
                    minQualityScore: 0.65,
                    maxTailRiskScore: 0.45,
                    requireBtcEthConfirmation: false
                },
                riskOff: {
                    minQualityScore: 0.75,
                    maxTailRiskScore: 0.35,
                    allowOnlyAPlus: true
                },
                manualOnly: { blockNewEntries: true }
            },
            auto: {
                suggested_mode: 'NORMAL',
                reasons: ['test']
            }
        },
        cleanEntry: {
            config: {
                ...DEFAULT_AEGIS_CLEAN_ENTRY_GUARD_CONFIG,
                enabled: true,
                mode: 'ENFORCE'
            }
        },
        probe: {
            config: {
                enabled: true,
                mode: 'ENFORCE',
                apply_when_event_risk: ['CAUTION'],
                min_turbo_score: 0.90,
                min_votes_agreement: 2,
                max_tail_risk_score: 0.30,
                require_decision_brain: 'ENTER_NOW',
                require_entry_quality_allow: true,
                require_feature_status_ok: true,
                min_feature_parity_pct: 95,
                allow_if_blocked_only_by: ['clean_entry_event_risk_would_block', 'caution_btc_eth_not_confirmed'],
                max_probe_entries_per_hour: 1,
                min_minutes_between_probe_entries: 60,
                max_open_probe_positions: 1,
                max_total_open_positions_when_probe: 2,
                block_after_consecutive_losses: 2,
                block_after_recent_stop_loss_minutes: 60
            }
        },
        shortGate: {
            config: {
                enabled: true,
                mode: 'PREMIUM_ONLY',
                min_score: 0.8,
                require_votes: 2,
                position_fraction_multiplier: 0.5,
                max_leverage: 10,
                block_symbols: [],
                allow_if_regime_bearish: false
            }
        },
        decisionEnforcement: {
            config: decisionEnforcementConfig,
            riskOffTailMax: 0.35
        },
        operational: {
            consecutiveLosses: 0,
            tradesToday: 0,
            openPositionsCount: 0,
            openProbePositions: 0,
            sameSymbolPositionExists: false,
            recentStopLossMinutes: undefined,
            lastStopLossAt: undefined,
            lastProbeAt: undefined,
            probeEntryTimestamps: [],
            timestamp: Date.parse('2026-05-21T12:00:00Z')
        },
        ...overrides
    };
}

describe('AegisEntryGuardOrchestrator', () => {
    it('does not block when all guards are OFF', () => {
        const allOff = policy(Object.fromEntries(guardNames.map((name) => [name, { enabled: false, mode: 'OFF' }])) as Partial<AegisEntryPolicyRuntimeConfig['guards']>);
        const result = AegisEntryGuardOrchestrator.evaluate(baseContext({
            decisionBrain: {
                ...baseContext().decisionBrain!,
                block: { decision: 'DO_NOT_ENTER', do_not_enter_prob: 0.95 }
            }
        }), allOff);

        expect(result.finalDecision).toBe('ALLOW');
        expect(result.shouldOpen).toBe(true);
        expect(result.guards.every((guard) => guard.enabled === false)).toBe(true);
    });

    it('records SHADOW wouldBlock without blocking', () => {
        const result = AegisEntryGuardOrchestrator.evaluate(
            baseContext({ turboScore: 0.5 }),
            policy({ entry_quality: { enabled: true, mode: 'SHADOW' } })
        );

        expect(result.finalDecision).toBe('ALLOW');
        expect(result.decisions.entryQuality?.wouldBlock).toBe(true);
        expect(result.guards.find((guard) => guard.name === 'entry_quality')?.enforced).toBe(false);
    });

    it('blocks an ENFORCE EntryQuality deny', () => {
        const result = AegisEntryGuardOrchestrator.evaluate(baseContext({ turboScore: 0.5 }), policy());

        expect(result.finalDecision).toBe('DENY');
        expect(result.deniedBy).toBe('entry_quality');
    });

    it('does not convert legacy EntryQuality SHADOW wouldBlock into an entry-policy hard block', () => {
        const context = baseContext({
            turboScore: 0.5,
            entryQuality: {
                ...baseContext().entryQuality,
                ruleGate: {
                    ...baseContext().entryQuality.ruleGate,
                    mode: 'SHADOW'
                }
            }
        });
        const result = AegisEntryGuardOrchestrator.evaluate(context, policy({
            entry_quality: { enabled: true, mode: 'ENFORCE' },
            clean_entry: { enabled: false, mode: 'OFF' },
            decision_brain: { enabled: true, mode: 'ENFORCE' }
        }));

        expect(result.finalDecision).toBe('ALLOW');
        expect(result.deniedBy).toBeUndefined();
        expect(result.decisions.entryQuality?.action).toBe('SHADOW_BLOCK');
        expect(result.guards.find((guard) => guard.name === 'entry_quality')).toMatchObject({
            mode: 'SHADOW',
            enforced: false,
            wouldBlock: true
        });
    });

    it('returns WAIT_CONFIRMATION for Clean Entry ENFORCE wait when Probe cannot allow', () => {
        const result = AegisEntryGuardOrchestrator.evaluate(
            baseContext({
                eventRisk: {
                    ...baseContext().eventRisk!,
                    mode: 'CAUTION',
                    enforce: false,
                    wouldBlock: true,
                    reason: 'caution_btc_eth_not_confirmed',
                    config: {
                        ...baseContext().eventRisk!.config,
                        caution: {
                            minQualityScore: 0.65,
                            maxTailRiskScore: 0.45,
                            requireBtcEthConfirmation: true
                        }
                    }
                },
                operational: {
                    ...baseContext().operational,
                    lastProbeAt: Date.parse('2026-05-21T11:30:00Z')
                }
            }),
            policy()
        );

        expect(result.finalDecision).toBe('WAIT_CONFIRMATION');
        expect(result.deniedBy).toBe('probe_mode');
        expect(result.decisions.probeMode?.reason).toBe('probe_min_minutes_between_entries');
    });

    it('allows EventRisk SHADOW wouldBlock when Clean Entry is SHADOW and no enforced guard denies', () => {
        const result = AegisEntryGuardOrchestrator.evaluate(
            baseContext({
                eventRisk: {
                    ...baseContext().eventRisk!,
                    mode: 'CAUTION',
                    enforce: false,
                    wouldBlock: true,
                    reason: 'caution_btc_eth_not_confirmed',
                    config: {
                        ...baseContext().eventRisk!.config,
                        caution: {
                            minQualityScore: 0.65,
                            maxTailRiskScore: 0.45,
                            requireBtcEthConfirmation: true
                        }
                    }
                },
                cleanEntry: {
                    config: {
                        ...DEFAULT_AEGIS_CLEAN_ENTRY_GUARD_CONFIG,
                        enabled: true,
                        mode: 'SHADOW'
                    }
                }
            }),
            policy({
                event_risk: { enabled: true, mode: 'SHADOW' },
                clean_entry: { enabled: true, mode: 'SHADOW' }
            })
        );

        expect(result.finalDecision).toBe('ALLOW');
        expect(result.decisions.eventRisk?.wouldBlock).toBe(true);
    });

    it('blocks an ENFORCE EventRisk deny', () => {
        const result = AegisEntryGuardOrchestrator.evaluate(
            baseContext({
                eventRisk: {
                    ...baseContext().eventRisk!,
                    mode: 'RISK_OFF',
                    config: {
                        ...baseContext().eventRisk!.config,
                        riskOff: {
                            minQualityScore: 0.95,
                            maxTailRiskScore: 0.35,
                            allowOnlyAPlus: true
                        }
                    }
                },
                setupGrade: 'WEAK'
            }),
            policy()
        );

        expect(result.finalDecision).toBe('DENY');
        expect(result.deniedBy).toBe('event_risk');
    });

    it('does not let entry-policy ENFORCE block EventRisk when legacy event_risk.enforce is false', () => {
        const result = AegisEntryGuardOrchestrator.evaluate(
            baseContext({
                eventRisk: {
                    ...baseContext().eventRisk!,
                    mode: 'RISK_OFF',
                    enforce: false,
                    config: {
                        ...baseContext().eventRisk!.config,
                        riskOff: {
                            minQualityScore: 0.95,
                            maxTailRiskScore: 0.35,
                            allowOnlyAPlus: true
                        }
                    }
                },
                setupGrade: 'WEAK'
            }),
            policy({
                event_risk: { enabled: true, mode: 'ENFORCE' },
                decision_brain: { enabled: false, mode: 'OFF' },
                clean_entry: { enabled: false, mode: 'OFF' },
                probe_mode: { enabled: false, mode: 'OFF' }
            })
        );

        expect(result.finalDecision).toBe('ALLOW');
        expect(result.decisions.eventRisk?.wouldBlock).toBe(true);
        expect(result.guards.find((guard) => guard.name === 'event_risk')).toMatchObject({
            mode: 'SHADOW',
            enforced: false,
            wouldBlock: true
        });
    });

    it('allows Probe Mode to override a clean EventRisk CAUTION near miss', () => {
        const result = AegisEntryGuardOrchestrator.evaluate(
            baseContext({
                eventRisk: {
                    ...baseContext().eventRisk!,
                    mode: 'CAUTION',
                    enforce: false,
                    wouldBlock: true,
                    reason: 'caution_btc_eth_not_confirmed',
                    config: {
                        ...baseContext().eventRisk!.config,
                        caution: {
                            minQualityScore: 0.65,
                            maxTailRiskScore: 0.45,
                            requireBtcEthConfirmation: true
                        }
                    }
                }
            }),
            policy()
        );

        expect(result.finalDecision).toBe('ALLOW');
        expect(result.allowedBy).toBe('probe_mode');
        expect(result.decisions.probeMode?.allowed).toBe(true);
    });

    it('attributes Clean Entry ENFORCE wait to clean_entry when Probe Mode is OFF', () => {
        const result = AegisEntryGuardOrchestrator.evaluate(
            baseContext({
                eventRisk: {
                    ...baseContext().eventRisk!,
                    mode: 'CAUTION',
                    enforce: false,
                    wouldBlock: true,
                    reason: 'caution_btc_eth_not_confirmed',
                    config: {
                        ...baseContext().eventRisk!.config,
                        caution: {
                            minQualityScore: 0.65,
                            maxTailRiskScore: 0.45,
                            requireBtcEthConfirmation: true
                        }
                    }
                }
            }),
            policy({
                probe_mode: { enabled: false, mode: 'OFF' }
            })
        );

        expect(result.finalDecision).toBe('WAIT_CONFIRMATION');
        expect(result.deniedBy).toBe('clean_entry');
        expect(result.finalReason).toBe('clean_entry_event_risk_would_block');
        expect(result.guards.find((guard) => guard.name === 'probe_mode')).toMatchObject({
            enabled: false,
            reason: 'probe_mode_disabled'
        });
    });

    it('does not let Probe Mode override DecisionBrain MANUAL_ONLY', () => {
        const result = AegisEntryGuardOrchestrator.evaluate(
            baseContext({
                decisionBrain: {
                    ...baseContext().decisionBrain!,
                    decision: 'MANUAL_ONLY',
                    reason: 'manual_only',
                    block: { decision: 'MANUAL_ONLY', manual_only_prob: 0.9 }
                },
                eventRisk: {
                    ...baseContext().eventRisk!,
                    mode: 'CAUTION',
                    enforce: false,
                    wouldBlock: true,
                    reason: 'caution_btc_eth_not_confirmed'
                }
            }),
            policy()
        );

        expect(result.finalDecision).toBe('DENY');
        expect(result.deniedBy).toBe('decision_brain');
        expect(result.decisions.probeMode?.allowed).toBe(false);
    });

    it('blocks DecisionBrain DO_NOT_ENTER', () => {
        const result = AegisEntryGuardOrchestrator.evaluate(
            baseContext({
                decisionBrain: {
                    ...baseContext().decisionBrain!,
                    decision: 'DO_NOT_ENTER',
                    block: { decision: 'DO_NOT_ENTER', do_not_enter_prob: 0.9 }
                }
            }),
            policy()
        );

        expect(result.finalDecision).toBe('DENY');
        expect(result.deniedBy).toBe('decision_brain');
    });

    it('blocks EntryQuality BLOCK_SHADOW through DecisionBrain enforcement', () => {
        const result = AegisEntryGuardOrchestrator.evaluate(
            baseContext({
                entryQuality: {
                    ...baseContext().entryQuality!,
                    model: {
                        ...baseContext().entryQuality.model!,
                        recommendation: 'BLOCK_SHADOW',
                        entry_quality_score: 0.2,
                        tail_risk_score: 0.8
                    },
                    recommendation: 'BLOCK_SHADOW',
                    entryQualityScore: 0.2,
                    tailRiskScore: 0.8
                }
            }),
            policy()
        );

        expect(result.finalDecision).toBe('DENY');
        expect(result.deniedBy).toBe('decision_brain');
        expect(result.finalReason).toBe('entry_quality_shadow_block_hard_denied');
    });

    it('denies non-premium shorts through ShortGate', () => {
        const result = AegisEntryGuardOrchestrator.evaluate(
            baseContext({
                side: 'SHORT',
                rawAction: 'SHORT',
                finalAction: 'SHORT',
                votes: { long: 0, short: 1, neutral: 2 },
                turboScore: 0.7
            }),
            policy()
        );

        expect(result.finalDecision).toBe('DENY');
        expect(result.deniedBy).toBe('short_gate');
    });

    it('keeps guard order deterministic and includes every guard in the trace', () => {
        const result = AegisEntryGuardOrchestrator.evaluate(baseContext(), policy());

        expect(result.guards.map((guard) => guard.name)).toEqual(guardNames);
        expect(Object.keys(result.trace.guards)).toEqual(guardNames);
        expect(result.metadata.finalDecision).toBe(result.finalDecision);
        expect(result.metadata.finalReason).toBe(result.finalReason);
    });
});
