import { describe, expect, it } from 'vitest';
import { AegisDecisionEnforcementRuntimeConfig } from '../AegisDecisionEnforcement';
import { DEFAULT_AEGIS_CLEAN_ENTRY_GUARD_CONFIG } from '../AegisCleanEntryGuard';
import { DEFAULT_AEGIS_REGIME_GUARD_CONFIG } from '../AegisRegimeGuard';
import { AegisEntryGuardOrchestrator } from './AegisEntryGuardOrchestrator';
import {
    AegisEntryContext,
    AegisEntryGuardName,
    AegisEntryPolicyRuntimeConfig,
    AegisMomentumRideRuntimeConfig,
    AegisRegimeContextRuntimeConfig
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
    'regime_context',
    'momentum_ride',
    'regime',
    'short_gate',
    'entry_quality',
    'event_risk',
    'decision_brain',
    'clean_entry',
    'probe_mode',
    'long_risk_shadow'
];

function policy(overrides: Partial<AegisEntryPolicyRuntimeConfig['guards']> = {}): AegisEntryPolicyRuntimeConfig {
    return {
        enabled: true,
        guards: {
            regime_context: { enabled: false, mode: 'OFF' },
            momentum_ride: { enabled: false, mode: 'OFF' },
            regime: { enabled: true, mode: 'SHADOW' },
            short_gate: { enabled: true, mode: 'ENFORCE' },
            entry_quality: { enabled: true, mode: 'ENFORCE' },
            event_risk: { enabled: true, mode: 'ENFORCE' },
            decision_brain: { enabled: true, mode: 'ENFORCE' },
            clean_entry: { enabled: true, mode: 'ENFORCE' },
            probe_mode: { enabled: true, mode: 'ENFORCE' },
            long_risk_shadow: { enabled: true, mode: 'SHADOW' },
            e4_tail_risk: { enabled: false, mode: 'OFF' },
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
                    maxAtrPercentile: 0.75
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
        regime: {
            config: {
                ...DEFAULT_AEGIS_REGIME_GUARD_CONFIG,
                enabled: true,
                mode: 'ENFORCE',
                blockWhen: ['CHOP', 'EXHAUSTION', 'RISK_OFF', 'HIGH_VOL_RISK', 'UNKNOWN']
            },
            btcAction: 'LONG',
            btcScore: 0.82,
            btcVotes: { long: 3, short: 0, neutral: 0 },
            ethAction: 'LONG',
            ethScore: 0.80,
            ethVotes: { long: 3, short: 0, neutral: 0 },
            snapshotAgeSeconds: 60
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

const regimeContextConfig: AegisRegimeContextRuntimeConfig = {
    enabled: true,
    mode: 'SHADOW',
    timeframe: '5m',
    allowedFor: { momentumRide: true },
    indicators: { emaFast: 7, emaMid: 25, emaSlow: 99, atrWindow: 14, volumeWindow: 20, bollingerWindow: 20, adxWindow: 14, choppinessWindow: 14 },
    thresholds: { maxChoppinessForMomentum: 80, minAdxForMomentum: 0, minVolumeRatioForMomentum: 1.3, maxAtrPercentileForAggressive: 0.8, maxExhaustionScore: 0.95 }
};

const momentumRideConfig: AegisMomentumRideRuntimeConfig = {
    enabled: true,
    mode: 'SHADOW',
    researchMode: true,
    regimeFilter: {
        enabled: true,
        useAsGate: false,
        recordMetadata: true,
        ignoreForEntry: true
    },
    allowWhenAegisDenied: false,
    requireAegisDirectionConfirmation: true,
    allowMomentumAgainstAegis: false,
    requireBtcEthNotContradicting: true,
    requireBtcEthConfirmation: false,
    symbols: {
        ADAUSDT: {
            enabled: true,
            mode: 'SHADOW',
            long: {
                enabled: true,
                leverage: 50,
                positionFraction: 0.02,
                minTurboScore: 0.85,
                minVolumeRatio: 1.3,
                momentumCandles: 3,
                maxTailRiskScore: 0.3,
                allowedRegimes: ['MOMENTUM_UP', 'TREND_UP', 'BREAKOUT_UP'],
                requireCloseNearExtreme: true,
                minCloseLocation: 0.7,
                maxWickRatio: 0.35,
                maxOverextensionPct: 0.1
            },
            short: {
                enabled: false,
                leverage: 10,
                positionFraction: 0.01,
                minTurboScore: 0.92,
                minVolumeRatio: 1.7,
                momentumCandles: 3,
                maxTailRiskScore: 0.25,
                allowedRegimes: ['MOMENTUM_DOWN', 'TREND_DOWN', 'BREAKOUT_DOWN'],
                requireCloseNearExtreme: true,
                minCloseLocation: 0.7,
                maxWickRatio: 0.35,
                maxOverextensionPct: 0.05
            }
        }
    },
    safetyCaps: {
        maxLeverage: 50,
        maxPositionFraction: 0.03,
        maxOpenMomentumPositions: 1,
        maxTotalOpenPositionsWhenMomentum: 2,
        maxMomentumTradesPerDay: 3,
        maxConsecutiveMomentumLosses: 2,
        cooldownAfterLossMinutes: 60,
        disableSymbolAfterStopLossMinutes: 120,
        requireBrackets: true,
        requireProfitProtection: true
    }
};

function momentumContext(overrides: Partial<AegisEntryContext> = {}): AegisEntryContext {
    const candles = [
        ...Array.from({ length: 20 }, (_, index) => ({ open: 1 + index * 0.001, high: 1.01, low: 0.99, close: 1 + index * 0.0015, volume: 100 })),
        { open: 1.10, high: 1.12, low: 1.09, close: 1.115, volume: 130 },
        { open: 1.115, high: 1.14, low: 1.11, close: 1.135, volume: 150 },
        { open: 1.135, high: 1.17, low: 1.13, close: 1.165, volume: 220 }
    ];
    const base = baseContext();
    return baseContext({
        entryQuality: {
            ...base.entryQuality,
            ruleGate: {
                ...base.entryQuality.ruleGate,
                recentCandles: candles,
                atrPercentile: 0.4
            }
        },
        regime: {
            ...base.regime!,
            contextConfig: regimeContextConfig
        },
        momentumRideConfig,
        ...overrides
    });
}

function probeLongRiskPolicy(mode: AegisEntryPolicyRuntimeConfig['guards']['long_risk_shadow']['mode'] = 'ENFORCE_PROBE_LONG_CRITICAL'): AegisEntryPolicyRuntimeConfig {
    return policy({
        long_risk_shadow: {
            enabled: true,
            mode,
            probeLongCriticalAction: 'BLOCK',
            probeLongHighAction: 'SHADOW',
            aegisLongCriticalAction: 'SHADOW',
            momentumLongCriticalAction: 'SHADOW',
            minRiskLevelToBlockProbe: 'CRITICAL',
            blockOnlyProbeMode: true,
            blockOnlyLong: true
        }
    });
}

function probeLongRiskContext(risk: 'HIGH' | 'CRITICAL' = 'CRITICAL', overrides: Partial<AegisEntryContext> = {}): AegisEntryContext {
    const base = baseContext();
    const criticalCandles = [
        ...Array.from({ length: 13 }, (_, index) => ({ open: 1 - index * 0.001, high: 1.01, low: 0.99, close: 1 - index * 0.001, volume: 100 })),
        { open: 0.99, high: 1, low: 0.98, close: 0.985, volume: 80 }
    ];
    const highCandles = [
        ...Array.from({ length: 13 }, (_, index) => ({ open: 1 + index * 0.001, high: 1.02, low: 0.99, close: 1 + index * 0.001, volume: 100 })),
        { open: 1.013, high: 1.02, low: 1.00, close: 1.014, volume: 100 }
    ];
    return baseContext({
        entryQuality: {
            ...base.entryQuality,
            recommendation: 'ALLOW_SHADOW',
            model: {
                ...base.entryQuality.model!,
                recommendation: 'ALLOW_SHADOW'
            },
            ruleGate: {
                ...base.entryQuality.ruleGate,
                currentPrice: risk === 'CRITICAL' ? 0.985 : 1.014,
                recentCandles: risk === 'CRITICAL' ? criticalCandles : highCandles
            }
        },
        eventRisk: {
            ...base.eventRisk,
            mode: 'CAUTION',
            enforce: false,
            wouldBlock: true,
            reason: 'caution_btc_eth_not_confirmed',
            btcAction: risk === 'CRITICAL' ? 'HOLD' : 'LONG',
            ethAction: risk === 'CRITICAL' ? 'HOLD' : 'LONG',
            config: {
                ...base.eventRisk.config,
                caution: {
                    minQualityScore: 0.65,
                    maxTailRiskScore: 0.45,
                    requireBtcEthConfirmation: true
                }
            }
        },
        regime: {
            ...base.regime!,
            btcAction: risk === 'CRITICAL' ? 'HOLD' : 'LONG',
            ethAction: risk === 'CRITICAL' ? 'HOLD' : 'LONG'
        },
        regimeContext: {
            label: risk === 'CRITICAL' ? 'CHOP' : 'MOMENTUM_UP',
            confidence: risk === 'CRITICAL' ? 0.4 : 0.75,
            momentumLongAllowed: risk !== 'CRITICAL',
            momentumShortAllowed: risk === 'CRITICAL',
            trendDirection: risk === 'CRITICAL' ? 'DOWN' : 'UP',
            chopRisk: risk === 'CRITICAL' ? 0.8 : 0.2,
            exhaustionRisk: risk === 'CRITICAL' ? 0.4 : 0.1,
            volatilityState: 'NORMAL',
            volumeState: 'NORMAL',
            reasons: ['test'],
            indicators: { emaMid: risk === 'CRITICAL' ? 1.02 : 0.90 }
        },
        ...overrides
    });
}

describe('AegisEntryGuardOrchestrator', () => {
    it('does not block when all guards are OFF', async () => {
        const allOff = policy(Object.fromEntries(guardNames.map((name) => [name, { enabled: false, mode: 'OFF' }])) as Partial<AegisEntryPolicyRuntimeConfig['guards']>);
        const result = await AegisEntryGuardOrchestrator.evaluate(baseContext({
            decisionBrain: {
                ...baseContext().decisionBrain!,
                block: { decision: 'DO_NOT_ENTER', do_not_enter_prob: 0.95 }
            }
        }), allOff);

        expect(result.finalDecision).toBe('ALLOW');
        expect(result.shouldOpen).toBe(true);
        expect(result.guards.every((guard) => guard.enabled === false)).toBe(true);
    });

    it('blocks first when Regime ENFORCE denies', async () => {
        const result = await AegisEntryGuardOrchestrator.evaluate(
            baseContext({
                regime: {
                    ...baseContext().regime!,
                    btcAction: 'SHORT',
                    ethAction: 'LONG'
                }
            }),
            policy({ regime: { enabled: true, mode: 'ENFORCE' } })
        );

        expect(result.finalDecision).toBe('DENY');
        expect(result.deniedBy).toBe('regime');
        expect(result.finalReason).toBe('regime_alt_long_btc_short_block');
        expect(result.guards.map((guard) => guard.name)).toEqual(guardNames);
        expect(result.guards.find((guard) => guard.name === 'short_gate')?.reason).toBe('short_gate_not_evaluated');
    });

    it('records Regime SHADOW deny without blocking', async () => {
        const result = await AegisEntryGuardOrchestrator.evaluate(
            baseContext({
                regime: {
                    ...baseContext().regime!,
                    btcAction: 'SHORT',
                    ethAction: 'LONG'
                }
            }),
            policy({ regime: { enabled: true, mode: 'SHADOW' } })
        );

        expect(result.finalDecision).toBe('ALLOW');
        expect(result.guards.find((guard) => guard.name === 'regime')).toMatchObject({
            decision: 'SHADOW_DENY',
            wouldBlock: true,
            enforced: false
        });
    });

    it('does not block ML_MODEL unavailable while Regime is SHADOW', async () => {
        const result = await AegisEntryGuardOrchestrator.evaluate(
            baseContext({
                regime: {
                    ...baseContext().regime!,
                    config: {
                        ...baseContext().regime!.config,
                        source: 'ML_MODEL'
                    }
                }
            }),
            policy({ regime: { enabled: true, mode: 'SHADOW' } })
        );

        expect(result.finalDecision).toBe('ALLOW');
        expect(result.decisions.regime).toMatchObject({
            source: 'ML_MODEL',
            reason: 'regime_model_unavailable',
            wouldBlock: true
        });
        expect(result.guards.find((guard) => guard.name === 'regime')).toMatchObject({
            decision: 'SHADOW_DENY',
            enforced: false
        });
    });

    it('does not block when Regime is OFF', async () => {
        const result = await AegisEntryGuardOrchestrator.evaluate(
            baseContext({
                regime: {
                    ...baseContext().regime!,
                    btcAction: 'SHORT',
                    ethAction: 'LONG'
                }
            }),
            policy({ regime: { enabled: false, mode: 'OFF' } })
        );

        expect(result.finalDecision).toBe('ALLOW');
        expect(result.guards.find((guard) => guard.name === 'regime')?.enabled).toBe(false);
    });

    it('continues normally when Regime allows', async () => {
        const result = await AegisEntryGuardOrchestrator.evaluate(baseContext(), policy({
            regime: { enabled: true, mode: 'ENFORCE' }
        }));

        expect(result.finalDecision).toBe('ALLOW');
        expect(result.decisions.regime?.regime).toBe('MOMENTUM_UP');
        expect(result.metadata.regime).toMatchObject({
            regime: 'MOMENTUM_UP',
            source: 'HYBRID_HEURISTIC'
        });
    });

    it('adds Regime Avoid shadow metadata without changing shouldOpen', async () => {
        const result = await AegisEntryGuardOrchestrator.evaluate(momentumContext({
            symbol: 'AVAXUSDT',
            signal: {
                ...momentumContext().signal,
                symbol: 'AVAXUSDT'
            },
            entryQuality: {
                ...momentumContext().entryQuality,
                ruleGate: {
                    ...momentumContext().entryQuality.ruleGate,
                    recentCandles: [
                        { open: 1, high: 1.01, low: 0.99, close: 1, volume: 100 },
                        { open: 1, high: 1.01, low: 0.99, close: 1, volume: 100 },
                        { open: 1, high: 1.01, low: 0.99, close: 1, volume: 100 },
                        { open: 1, high: 1.01, low: 0.99, close: 1, volume: 100 },
                        { open: 1, high: 1.01, low: 0.99, close: 1, volume: 100 },
                        { open: 1, high: 1.01, low: 0.99, close: 1, volume: 100 },
                        { open: 1, high: 1.01, low: 0.99, close: 1, volume: 100 },
                        { open: 1, high: 1.01, low: 0.99, close: 1, volume: 100 },
                        { open: 1, high: 1.01, low: 0.99, close: 1, volume: 100 },
                        { open: 1, high: 1.01, low: 0.99, close: 1, volume: 100 },
                        { open: 1, high: 1.01, low: 0.99, close: 1, volume: 100 },
                        { open: 1, high: 1.01, low: 0.99, close: 1, volume: 100 },
                        { open: 1, high: 1.01, low: 0.99, close: 1, volume: 100 },
                        { open: 1, high: 1.01, low: 0.99, close: 1, volume: 100 },
                        { open: 1, high: 1.01, low: 0.99, close: 1, volume: 100 },
                        { open: 1, high: 1.01, low: 0.99, close: 1, volume: 100 },
                        { open: 1, high: 1.01, low: 0.99, close: 1, volume: 100 },
                        { open: 1, high: 1.01, low: 0.99, close: 1, volume: 100 },
                        { open: 1, high: 1.01, low: 0.99, close: 1, volume: 100 },
                        { open: 1, high: 1.01, low: 0.99, close: 1, volume: 100 }
                    ]
                }
            }
        }), policy({
            regime_context: { enabled: true, mode: 'SHADOW' },
            regime: { enabled: true, mode: 'SHADOW' },
            momentum_ride: { enabled: false, mode: 'OFF' }
        }));

        expect(result.finalDecision).toBe('ALLOW');
        expect(result.shouldOpen).toBe(true);
        expect(result.metadata.regimeAvoidShadow).toMatchObject({
            wouldAvoid: true,
            reason: 'calibrated_avoid_regime',
            matchedRegime: 'MOMENTUM_UP',
            source: 'calibration_20260522',
            mode: 'SHADOW',
            finalDecision: 'ALLOW',
            finalStrategy: 'aegis_turbo',
            notLiveEnforced: true
        });
    });

    it('records SHADOW wouldBlock without blocking', async () => {
        const result = await AegisEntryGuardOrchestrator.evaluate(
            baseContext({ turboScore: 0.5 }),
            policy({ entry_quality: { enabled: true, mode: 'SHADOW' } })
        );

        expect(result.finalDecision).toBe('ALLOW');
        expect(result.decisions.entryQuality?.wouldBlock).toBe(true);
        expect(result.guards.find((guard) => guard.name === 'entry_quality')?.enforced).toBe(false);
    });

    it('blocks an ENFORCE EntryQuality deny', async () => {
        const result = await AegisEntryGuardOrchestrator.evaluate(baseContext({ turboScore: 0.5 }), policy());

        expect(result.finalDecision).toBe('DENY');
        expect(result.deniedBy).toBe('entry_quality');
    });

    it('does not convert legacy EntryQuality SHADOW wouldBlock into an entry-policy hard block', async () => {
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
        const result = await AegisEntryGuardOrchestrator.evaluate(context, policy({
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

    it('returns WAIT_CONFIRMATION for Clean Entry ENFORCE wait when Probe cannot allow', async () => {
        const result = await AegisEntryGuardOrchestrator.evaluate(
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

    it('allows EventRisk SHADOW wouldBlock when Clean Entry is SHADOW and no enforced guard denies', async () => {
        const result = await AegisEntryGuardOrchestrator.evaluate(
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

    it('blocks an ENFORCE EventRisk deny', async () => {
        const result = await AegisEntryGuardOrchestrator.evaluate(
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

    it('does not let entry-policy ENFORCE block EventRisk when legacy event_risk.enforce is false', async () => {
        const result = await AegisEntryGuardOrchestrator.evaluate(
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

    it('allows Probe Mode to override a clean EventRisk CAUTION near miss', async () => {
        const result = await AegisEntryGuardOrchestrator.evaluate(
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

    it('blocks Probe LONG when LongRiskShadow is CRITICAL in enforce-probe mode', async () => {
        const result = await AegisEntryGuardOrchestrator.evaluate(probeLongRiskContext('CRITICAL'), probeLongRiskPolicy());
        const longRiskShadow = result.guards.find((guard) => guard.name === 'long_risk_shadow');

        expect(result.finalDecision).toBe('DENY');
        expect(result.finalReason).toBe('long_risk_probe_long_critical');
        expect(result.deniedBy).toBe('long_risk_shadow');
        expect(result.shouldOpen).toBe(false);
        expect(result.finalStrategy).toBe('none');
        expect(result.adjustedLeverage).toBe(20);
        expect(result.adjustedPositionFraction).toBe(0.1);
        expect(longRiskShadow).toMatchObject({
            decision: 'DENY',
            enforced: true,
            reason: 'long_risk_probe_long_critical'
        });
        expect((longRiskShadow?.metadata.longRiskShadow as any)).toMatchObject({
            riskLevel: 'CRITICAL',
            enforcementApplied: true,
            enforcementScope: 'probe_long_critical',
            blockedProbeLong: true,
            actionTaken: 'BLOCK'
        });
    });

    it('does not block Probe LONG when LongRiskShadow is HIGH', async () => {
        const result = await AegisEntryGuardOrchestrator.evaluate(probeLongRiskContext('HIGH'), probeLongRiskPolicy());
        const longRiskShadow = result.guards.find((guard) => guard.name === 'long_risk_shadow');

        expect(result.finalDecision).toBe('ALLOW');
        expect(result.finalReason).toBe('probe_mode_allowed');
        expect(result.shouldOpen).toBe(true);
        expect(result.allowedBy).toBe('probe_mode');
        expect((longRiskShadow?.metadata.longRiskShadow as any)).toMatchObject({
            riskLevel: 'HIGH',
            enforcementApplied: false,
            actionTaken: 'SHADOW'
        });
    });

    it('does not block Probe SHORT even if weak context is present', async () => {
        const shortPolicy = probeLongRiskPolicy();
        shortPolicy.guards.short_gate = { enabled: false, mode: 'OFF' };
        const result = await AegisEntryGuardOrchestrator.evaluate(probeLongRiskContext('CRITICAL', {
            symbol: 'AVAXUSDT',
            side: 'SHORT',
            rawAction: 'SHORT',
            finalAction: 'SHORT',
            signal: {
                ...baseContext().signal,
                symbol: 'AVAXUSDT',
                action: 'SHORT'
            },
            gate: {
                ...baseContext().gate,
                side: 'SHORT'
            }
        }), shortPolicy);
        const longRiskShadow = result.guards.find((guard) => guard.name === 'long_risk_shadow');

        expect(result.finalDecision).toBe('ALLOW');
        expect(result.finalReason).not.toBe('probe_votes_too_low');
        expect(result.deniedBy).not.toBe('long_risk_shadow');
        expect(longRiskShadow?.decision).toBe('NOT_APPLICABLE');
        expect((longRiskShadow?.metadata.longRiskShadow as any).enforcementApplied).toBe(false);
    });

    it('keeps Aegis Turbo normal LONG open when LongRiskShadow is CRITICAL but Probe is not used', async () => {
        const result = await AegisEntryGuardOrchestrator.evaluate(baseContext({
            entryQuality: {
                ...baseContext().entryQuality,
                recommendation: 'ALLOW_SHADOW',
                model: {
                    ...baseContext().entryQuality.model!,
                    recommendation: 'ALLOW_SHADOW'
                },
                ruleGate: {
                    ...baseContext().entryQuality.ruleGate,
                    currentPrice: 0.98,
                    recentCandles: [
                        ...Array.from({ length: 13 }, (_, index) => ({ open: 1 - index * 0.001, high: 1.01, low: 0.99, close: 1 - index * 0.002, volume: 100 })),
                        { open: 0.98, high: 0.985, low: 0.97, close: 0.972, volume: 140 }
                    ]
                }
            },
            regimeContext: {
                label: 'UNKNOWN',
                confidence: 0.3,
                momentumLongAllowed: false,
                momentumShortAllowed: false,
                trendDirection: 'DOWN',
                chopRisk: 0.8,
                exhaustionRisk: 0.4,
                volatilityState: 'NORMAL',
                volumeState: 'NORMAL',
                reasons: ['test'],
                indicators: { emaMid: 1.02 }
            },
            regime: {
                ...baseContext().regime!,
                btcAction: 'SHORT',
                ethAction: 'HOLD'
            }
        }), probeLongRiskPolicy());
        const longRiskShadow = result.guards.find((guard) => guard.name === 'long_risk_shadow');

        expect(result.finalDecision).toBe('ALLOW');
        expect(result.finalStrategy).toBe('aegis_turbo');
        expect(result.shouldOpen).toBe(true);
        expect(result.allowedBy).toBe('entry_policy');
        expect((longRiskShadow?.metadata.longRiskShadow as any)).toMatchObject({
            riskLevel: 'CRITICAL',
            enforcementApplied: false
        });
    });

    it('keeps Probe LONG open in SHADOW mode even when LongRiskShadow is CRITICAL', async () => {
        const result = await AegisEntryGuardOrchestrator.evaluate(probeLongRiskContext('CRITICAL'), probeLongRiskPolicy('SHADOW'));
        const longRiskShadow = result.guards.find((guard) => guard.name === 'long_risk_shadow');

        expect(result.finalDecision).toBe('ALLOW');
        expect(result.finalReason).toBe('probe_mode_allowed');
        expect(result.shouldOpen).toBe(true);
        expect((longRiskShadow?.metadata.longRiskShadow as any)).toMatchObject({
            riskLevel: 'CRITICAL',
            enforcementApplied: false
        });
    });

    it('attributes Clean Entry ENFORCE wait to clean_entry when Probe Mode is OFF', async () => {
        const result = await AegisEntryGuardOrchestrator.evaluate(
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

    it('Momentum ENFORCE ALLOW no requiere CleanEntry ALLOW si dirección Aegis confirma y hard safety pasa', async () => {
        const enforceMomentum = {
            ...momentumRideConfig,
            mode: 'ENFORCE' as const,
            symbols: {
                ADAUSDT: {
                    ...momentumRideConfig.symbols.ADAUSDT,
                    mode: 'ENFORCE' as const
                }
            }
        };
        const result = await AegisEntryGuardOrchestrator.evaluate(
            momentumContext({
                momentumRideConfig: enforceMomentum,
                eventRisk: {
                    ...momentumContext().eventRisk!,
                    mode: 'CAUTION',
                    enforce: false,
                    wouldBlock: true,
                    reason: 'caution_btc_eth_not_confirmed',
                    config: {
                        ...momentumContext().eventRisk!.config,
                        caution: {
                            minQualityScore: 0.65,
                            maxTailRiskScore: 0.45,
                            requireBtcEthConfirmation: true
                        }
                    }
                }
            }),
            policy({
                regime_context: { enabled: true, mode: 'SHADOW' },
                momentum_ride: { enabled: true, mode: 'ENFORCE' },
                probe_mode: { enabled: false, mode: 'OFF' }
            })
        );

        expect(result.finalDecision).toBe('ALLOW');
        expect(result.finalStrategy).toBe('momentum_ride');
        expect(result.allowedBy).toBe('momentum_ride');
        expect(result.strategyCandidates.aegis_turbo).toMatchObject({
            decision: 'WAIT_CONFIRMATION',
            reason: 'clean_entry_event_risk_would_block'
        });
        expect(result.strategyCandidates.momentum_ride.decision).toBe('ALLOW');
        expect(result.guards.find((guard) => guard.name === 'momentum_ride')?.metadata).toMatchObject({
            aegisEntryPolicyFinalDecision: 'WAIT_CONFIRMATION',
            aegisEntryPolicyFinalReason: 'clean_entry_event_risk_would_block',
            cleanEntryDecision: 'WAIT_CONFIRMATION',
            eventRiskMode: 'CAUTION',
            eventRiskWouldBlock: true,
            momentumUsedAegisDirectionOnly: true,
            momentumDidNotRequireCleanEntry: true,
            hardSafetyPassed: true
        });
    });

    it('Momentum ALLOW no overridea EventRisk RISK_OFF ni MANUAL_ONLY hard DENY', async () => {
        for (const mode of ['RISK_OFF', 'MANUAL_ONLY'] as const) {
            const enforceMomentum = {
                ...momentumRideConfig,
                mode: 'ENFORCE' as const,
                symbols: {
                    ADAUSDT: {
                        ...momentumRideConfig.symbols.ADAUSDT,
                        mode: 'ENFORCE' as const
                    }
                }
            };
            const result = await AegisEntryGuardOrchestrator.evaluate(momentumContext({
                momentumRideConfig: enforceMomentum,
                setupGrade: 'WEAK',
                eventRisk: {
                    ...momentumContext().eventRisk!,
                    mode,
                    enforce: true,
                    wouldBlock: true,
                    reason: mode === 'RISK_OFF' ? 'event_risk_risk_off_denied_non_a_plus' : 'event_risk_manual_only',
                    config: {
                        ...momentumContext().eventRisk!.config,
                        riskOff: {
                            minQualityScore: 0.95,
                            maxTailRiskScore: 0.35,
                            allowOnlyAPlus: true
                        },
                        manualOnly: { blockNewEntries: true }
                    }
                }
            }), policy({
                regime_context: { enabled: true, mode: 'SHADOW' },
                momentum_ride: { enabled: true, mode: 'ENFORCE' },
                event_risk: { enabled: true, mode: 'ENFORCE' },
                decision_brain: { enabled: false, mode: 'OFF' },
                clean_entry: { enabled: false, mode: 'OFF' },
                probe_mode: { enabled: false, mode: 'OFF' }
            }));

            expect(result.finalDecision).toBe('DENY');
            expect(result.deniedBy).toBe('event_risk');
            expect(result.finalStrategy).toBe('none');
            expect(result.riskProfile).toBeUndefined();
            expect(result.strategyCandidates.momentum_ride.decision).toBe('DENY');
            expect(result.guards.find((guard) => guard.name === 'momentum_ride')?.metadata).toMatchObject({
                eventRiskMode: mode,
                hardSafetyPassed: false
            });
        }
    });

    it('does not let Probe Mode override DecisionBrain MANUAL_ONLY', async () => {
        const result = await AegisEntryGuardOrchestrator.evaluate(
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

    it('blocks DecisionBrain DO_NOT_ENTER', async () => {
        const result = await AegisEntryGuardOrchestrator.evaluate(
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

    it('blocks EntryQuality BLOCK_SHADOW through DecisionBrain enforcement', async () => {
        const result = await AegisEntryGuardOrchestrator.evaluate(
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

    it('denies non-premium shorts through ShortGate', async () => {
        const result = await AegisEntryGuardOrchestrator.evaluate(
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

    it('keeps Phase O SHORT leverage and sizing unchanged when ShortGate is SHADOW', async () => {
        const result = await AegisEntryGuardOrchestrator.evaluate(
            baseContext({
                side: 'SHORT',
                rawAction: 'SHORT',
                finalAction: 'SHORT',
                votes: { long: 0, short: 3, neutral: 0 },
                turboScore: 0.94,
                leverage: 20,
                requestedPositionFraction: 0.1,
                basePositionFraction: 0.1,
                gate: {
                    ...baseContext().gate,
                    side: 'SHORT',
                    leverage: 20,
                    positionFraction: 0.1,
                    votes: { long: 0, short: 3, neutral: 0 }
                }
            }),
            policy({
                short_gate: { enabled: true, mode: 'SHADOW' },
                entry_quality: { enabled: true, mode: 'SHADOW' },
                event_risk: { enabled: true, mode: 'SHADOW' },
                decision_brain: { enabled: true, mode: 'SHADOW' },
                clean_entry: { enabled: true, mode: 'SHADOW' },
                probe_mode: { enabled: true, mode: 'SHADOW' }
            })
        );

        expect(result.finalDecision).toBe('ALLOW');
        expect(result.deniedBy).toBeUndefined();
        expect(result.adjustedLeverage).toBe(20);
        expect(result.adjustedPositionFraction).toBe(0.1);
        expect(result.guards.find((guard) => guard.name === 'short_gate')).toMatchObject({
            mode: 'SHADOW',
            enforced: false,
            reason: 'short_canonical_decision_required'
        });
    });

    it('records a Probe counterfactual without blocking a Python-authorized entry', async () => {
        const context = baseContext({
            eventRisk: {
                ...baseContext().eventRisk,
                mode: 'CAUTION',
                reason: 'caution_btc_eth_not_confirmed',
                wouldBlock: true,
                enforce: false,
                config: {
                    ...baseContext().eventRisk.config,
                    caution: {
                        minQualityScore: 0.65,
                        maxTailRiskScore: 0.45,
                        requireBtcEthConfirmation: true
                    }
                }
            }
        });
        const result = await AegisEntryGuardOrchestrator.evaluate(context, policy({
            momentum_ride: { enabled: true, mode: 'SHADOW' },
            short_gate: { enabled: true, mode: 'SHADOW' },
            entry_quality: { enabled: true, mode: 'SHADOW' },
            event_risk: { enabled: true, mode: 'SHADOW' },
            decision_brain: { enabled: true, mode: 'SHADOW' },
            clean_entry: { enabled: true, mode: 'SHADOW' },
            probe_mode: { enabled: true, mode: 'SHADOW' },
            long_risk_shadow: { enabled: true, mode: 'SHADOW' }
        }));

        const probe = result.guards.find((guard) => guard.name === 'probe_mode');
        expect(result.finalDecision).toBe('ALLOW');
        expect(result.allowedBy).toBe('entry_policy');
        expect(result.adjustedLeverage).toBe(context.leverage);
        expect(result.adjustedPositionFraction).toBe(context.requestedPositionFraction);
        expect(probe).toMatchObject({
            mode: 'SHADOW',
            decision: 'SHADOW_ALLOW',
            reason: 'probe_allowed',
            wouldBlock: false,
            enforced: false
        });
        expect(probe?.metadata).toMatchObject({
            allowed: false,
            mode: 'SHADOW',
            wouldAllow: true,
            counterfactualReason: 'probe_allowed'
        });
        expect(result.decisions.probeMode).toMatchObject({
            allowed: false,
            reason: 'probe_allowed'
        });
    });

    it('records Probe tail-risk denial in SHADOW without blocking or resizing', async () => {
        const base = baseContext();
        const context = baseContext({
            entryQuality: {
                ...base.entryQuality,
                tailRiskScore: 0.61,
                model: {
                    ...base.entryQuality.model!,
                    tail_risk_score: 0.61
                }
            },
            eventRisk: {
                ...base.eventRisk,
                mode: 'CAUTION',
                reason: 'caution_btc_eth_not_confirmed',
                wouldBlock: true,
                enforce: false
            }
        });
        const result = await AegisEntryGuardOrchestrator.evaluate(context, policy({
            momentum_ride: { enabled: true, mode: 'SHADOW' },
            short_gate: { enabled: true, mode: 'SHADOW' },
            entry_quality: { enabled: true, mode: 'SHADOW' },
            event_risk: { enabled: true, mode: 'SHADOW' },
            decision_brain: { enabled: true, mode: 'SHADOW' },
            clean_entry: { enabled: true, mode: 'SHADOW' },
            probe_mode: { enabled: true, mode: 'SHADOW' },
            long_risk_shadow: { enabled: true, mode: 'SHADOW' }
        }));

        expect(result.finalDecision).toBe('ALLOW');
        expect(result.deniedBy).toBeUndefined();
        expect(result.adjustedLeverage).toBe(context.leverage);
        expect(result.adjustedPositionFraction).toBe(context.requestedPositionFraction);
        expect(result.guards.find((guard) => guard.name === 'probe_mode')).toMatchObject({
            mode: 'SHADOW',
            decision: 'SHADOW_DENY',
            reason: 'probe_tail_risk_too_high',
            wouldBlock: true,
            enforced: false,
            metadata: {
                allowed: false,
                wouldAllow: false,
                counterfactualReason: 'probe_tail_risk_too_high'
            }
        });
    });

    it('keeps guard order deterministic and includes every guard in the trace', async () => {
        const result = await AegisEntryGuardOrchestrator.evaluate(baseContext(), policy());

        expect(result.guards.map((guard) => guard.name)).toEqual(guardNames);
        expect(Object.keys(result.trace.guards)).toEqual(guardNames);
        expect(result.metadata.finalDecision).toBe(result.finalDecision);
        expect(result.metadata.finalReason).toBe(result.finalReason);
    });

    it('records critical long risk shadow without changing Aegis ALLOW', async () => {
        const result = await AegisEntryGuardOrchestrator.evaluate(baseContext({
            entryQuality: {
                ...baseContext().entryQuality,
                recommendation: 'ALLOW_SHADOW',
                model: {
                    ...baseContext().entryQuality.model!,
                    recommendation: 'ALLOW_SHADOW'
                },
                ruleGate: {
                    ...baseContext().entryQuality.ruleGate,
                    currentPrice: 0.98,
                    recentCandles: [
                        ...Array.from({ length: 13 }, (_, index) => ({ open: 1 - index * 0.001, high: 1.01, low: 0.99, close: 1 - index * 0.002, volume: 100 })),
                        { open: 0.98, high: 0.985, low: 0.97, close: 0.972, volume: 140 }
                    ]
                }
            },
            regimeContext: {
                label: 'UNKNOWN',
                confidence: 0.3,
                momentumLongAllowed: false,
                momentumShortAllowed: false,
                trendDirection: 'DOWN',
                chopRisk: 0.8,
                exhaustionRisk: 0.4,
                volatilityState: 'NORMAL',
                volumeState: 'NORMAL',
                reasons: ['test'],
                indicators: { emaMid: 1.02 }
            },
            regime: {
                ...baseContext().regime!,
                btcAction: 'SHORT',
                ethAction: 'HOLD'
            }
        }), policy({ regime: { enabled: true, mode: 'SHADOW' } }));

        const longRiskShadow = result.guards.find((guard) => guard.name === 'long_risk_shadow');
        expect(result.finalDecision).toBe('ALLOW');
        expect(result.shouldOpen).toBe(true);
        expect(longRiskShadow).toMatchObject({
            decision: 'SHADOW_DENY',
            wouldBlock: true,
            enforced: false
        });
        expect((longRiskShadow?.metadata.longRiskShadow as any).riskLevel).toBe('CRITICAL');
        expect(result.metadata.longRiskShadow).toMatchObject({ wouldBlock: true });
    });

    it('con regime/momentum SHADOW mantiene ALLOW aegis_turbo y risk normal', async () => {
        const result = await AegisEntryGuardOrchestrator.evaluate(momentumContext(), policy({
            regime_context: { enabled: true, mode: 'SHADOW' },
            momentum_ride: { enabled: true, mode: 'SHADOW' }
        }));

        expect(result.finalDecision).toBe('ALLOW');
        expect(result.finalStrategy).toBe('aegis_turbo');
        expect(result.strategyCandidates.momentum_ride.decision).toBe('SHADOW_ALLOW');
        expect(result.strategyCandidates.aegis_turbo.decision).toBe('ALLOW');
        expect(result.adjustedLeverage).toBe(20);
        expect(result.adjustedPositionFraction).toBe(0.1);
        expect(result.guards.find((guard) => guard.name === 'momentum_ride')?.decision).toBe('SHADOW_ALLOW');
    });

    it('Aegis normal DENY + momentum SHADOW allow conserva DENY y no abre', async () => {
        const result = await AegisEntryGuardOrchestrator.evaluate(momentumContext({
            decisionBrain: {
                decision: 'DO_NOT_ENTER',
                block: { decision: 'DO_NOT_ENTER', do_not_enter_prob: 0.9 }
            }
        }), policy({
            regime_context: { enabled: true, mode: 'SHADOW' },
            momentum_ride: { enabled: true, mode: 'SHADOW' }
        }));

        expect(result.finalDecision).toBe('DENY');
        expect(result.shouldOpen).toBe(false);
        expect(result.finalStrategy).toBe('none');
        expect(result.strategyCandidates.momentum_ride.decision).toBe('SHADOW_ALLOW');
        expect(result.strategyCandidates.aegis_turbo.decision).toBe('DENY');
        expect(result.guards.find((guard) => guard.name === 'momentum_ride')?.decision).toBe('SHADOW_ALLOW');
    });

    it('Momentum ENFORCE ALLOW + Aegis ALLOW prioriza finalStrategy momentum_ride', async () => {
        const enforceMomentum = {
            ...momentumRideConfig,
            mode: 'ENFORCE' as const,
            symbols: {
                ADAUSDT: {
                    ...momentumRideConfig.symbols.ADAUSDT,
                    mode: 'ENFORCE' as const
                }
            }
        };
        const result = await AegisEntryGuardOrchestrator.evaluate(momentumContext({ momentumRideConfig: enforceMomentum }), policy({
            regime_context: { enabled: true, mode: 'SHADOW' },
            momentum_ride: { enabled: true, mode: 'ENFORCE' }
        }));

        expect(result.finalDecision).toBe('ALLOW');
        expect(result.finalStrategy).toBe('momentum_ride');
        expect(result.strategyCandidates.momentum_ride.decision).toBe('ALLOW');
        expect(result.strategyCandidates.aegis_turbo.decision).toBe('ALLOW');
        expect(result.riskProfile).toMatchObject({ leverage: 50, positionFraction: 0.02 });
        expect(result.adjustedLeverage).toBe(50);
        expect(result.adjustedPositionFraction).toBe(0.02);
    });

    it('does not block Momentum Ride when long risk shadow warns', async () => {
        const enforceMomentum = {
            ...momentumRideConfig,
            mode: 'ENFORCE' as const,
            symbols: {
                ADAUSDT: {
                    ...momentumRideConfig.symbols.ADAUSDT,
                    mode: 'ENFORCE' as const
                }
            }
        };
        const result = await AegisEntryGuardOrchestrator.evaluate(momentumContext({
            momentumRideConfig: enforceMomentum,
            eventRisk: {
                ...momentumContext().eventRisk,
                mode: 'CAUTION',
                wouldBlock: false,
                btcAction: 'HOLD',
                ethAction: 'LONG'
            },
            regime: {
                ...momentumContext().regime!,
                btcAction: 'HOLD',
                ethAction: 'LONG'
            },
            entryQuality: {
                ...momentumContext().entryQuality,
                recommendation: 'ALLOW_SHADOW',
                model: {
                    ...momentumContext().entryQuality.model!,
                    recommendation: 'ALLOW_SHADOW'
                },
                ruleGate: {
                    ...momentumContext().entryQuality.ruleGate,
                    currentPrice: 0.98
                }
            },
            regimeContext: {
                ...momentumContext().regimeContext,
                label: 'MOMENTUM_UP',
                confidence: 0.8,
                momentumLongAllowed: true,
                momentumShortAllowed: false,
                trendDirection: 'UP',
                chopRisk: 0.2,
                exhaustionRisk: 0.1,
                volatilityState: 'NORMAL',
                volumeState: 'HIGH',
                reasons: ['test'],
                indicators: { emaMid: 1.02 }
            }
        }), policy({
            regime_context: { enabled: true, mode: 'SHADOW' },
            momentum_ride: { enabled: true, mode: 'ENFORCE' },
            event_risk: { enabled: true, mode: 'SHADOW' },
            long_risk_shadow: {
                enabled: true,
                mode: 'ENFORCE_PROBE_LONG_CRITICAL',
                probeLongCriticalAction: 'BLOCK',
                probeLongHighAction: 'SHADOW',
                aegisLongCriticalAction: 'SHADOW',
                momentumLongCriticalAction: 'SHADOW',
                minRiskLevelToBlockProbe: 'CRITICAL',
                blockOnlyProbeMode: true,
                blockOnlyLong: true
            }
        }));

        const longRiskShadow = result.guards.find((guard) => guard.name === 'long_risk_shadow');
        expect(result.finalDecision).toBe('ALLOW');
        expect(result.finalStrategy).toBe('momentum_ride');
        expect(longRiskShadow?.decision).toBe('SHADOW_DENY');
        expect(['HIGH', 'CRITICAL']).toContain((longRiskShadow?.metadata.longRiskShadow as any).riskLevel);
    });

    it('Momentum NOT_APPLICABLE + Aegis ALLOW conserva finalStrategy aegis_turbo', async () => {
        const result = await AegisEntryGuardOrchestrator.evaluate(momentumContext({
            entryQuality: {
                ...momentumContext().entryQuality,
                ruleGate: {
                    ...momentumContext().entryQuality.ruleGate,
                    recentCandles: [
                        { open: 1, high: 1.01, low: 0.99, close: 1, volume: 100 },
                        { open: 1, high: 1.01, low: 0.99, close: 1, volume: 100 }
                    ]
                }
            }
        }), policy({
            regime_context: { enabled: true, mode: 'SHADOW' },
            momentum_ride: { enabled: true, mode: 'ENFORCE' }
        }));

        expect(result.finalDecision).toBe('ALLOW');
        expect(result.finalStrategy).toBe('aegis_turbo');
        expect(result.strategyCandidates.momentum_ride.decision).toBe('NOT_APPLICABLE');
        expect(result.adjustedLeverage).toBe(20);
        expect(result.riskProfile).toBeUndefined();
    });

    it('Momentum DENY por regimen no bloquea Aegis ALLOW', async () => {
        const enforceMomentum = {
            ...momentumRideConfig,
            mode: 'ENFORCE' as const,
            symbols: {
                ADAUSDT: {
                    ...momentumRideConfig.symbols.ADAUSDT,
                    mode: 'ENFORCE' as const
                }
            }
        };
        const result = await AegisEntryGuardOrchestrator.evaluate(momentumContext({
            momentumRideConfig: enforceMomentum,
            regime: {
                ...momentumContext().regime!,
                btcAction: 'LONG',
                ethAction: 'SHORT'
            }
        }), policy({
            regime_context: { enabled: true, mode: 'SHADOW' },
            momentum_ride: { enabled: true, mode: 'ENFORCE' },
            regime: { enabled: true, mode: 'SHADOW' }
        }));

        expect(result.strategyCandidates.momentum_ride.decision).toBe('DENY');
        expect(result.finalDecision).toBe('ALLOW');
        expect(result.finalStrategy).toBe('aegis_turbo');
        expect(result.riskProfile).toBeUndefined();
        expect(result.adjustedLeverage).toBe(20);
    });

    it('Momentum DENY por turbo contradict + Aegis ALLOW conserva finalStrategy aegis_turbo', async () => {
        const enforceMomentum = {
            ...momentumRideConfig,
            mode: 'ENFORCE' as const,
            symbols: {
                ADAUSDT: {
                    ...momentumRideConfig.symbols.ADAUSDT,
                    mode: 'ENFORCE' as const
                }
            }
        };
        const result = await AegisEntryGuardOrchestrator.evaluate(momentumContext({
            momentumRideConfig: enforceMomentum,
            rawAction: 'LONG',
            finalAction: 'SHORT'
        }), policy({
            regime_context: { enabled: true, mode: 'SHADOW' },
            momentum_ride: { enabled: true, mode: 'ENFORCE' }
        }));

        expect(result.strategyCandidates.momentum_ride.decision).toBe('DENY');
        expect(result.strategyCandidates.momentum_ride.reason).toBe('momentum_turbo_contradict');
        expect(result.decisions.momentumRide?.reasons).toContain('momentum_turbo_contradict');
        expect(result.finalDecision).toBe('ALLOW');
        expect(result.finalStrategy).toBe('aegis_turbo');
        expect(result.riskProfile).toBeUndefined();
        expect(result.adjustedLeverage).toBe(20);
        expect(result.adjustedPositionFraction).toBe(0.1);
    });

    it('Momentum DENY por turbo not confirmed + Aegis ALLOW conserva finalStrategy aegis_turbo', async () => {
        const enforceMomentum = {
            ...momentumRideConfig,
            mode: 'ENFORCE' as const,
            symbols: {
                ADAUSDT: {
                    ...momentumRideConfig.symbols.ADAUSDT,
                    mode: 'ENFORCE' as const
                }
            }
        };
        const result = await AegisEntryGuardOrchestrator.evaluate(momentumContext({
            momentumRideConfig: enforceMomentum,
            rawAction: 'HOLD',
            finalAction: 'HOLD'
        }), policy({
            regime_context: { enabled: true, mode: 'SHADOW' },
            momentum_ride: { enabled: true, mode: 'ENFORCE' }
        }));

        expect(result.strategyCandidates.momentum_ride.decision).toBe('DENY');
        expect(result.strategyCandidates.momentum_ride.reason).toBe('momentum_turbo_not_confirmed');
        expect(result.decisions.momentumRide?.reasons).toContain('momentum_turbo_not_confirmed');
        expect(result.finalDecision).toBe('ALLOW');
        expect(result.finalStrategy).toBe('aegis_turbo');
        expect(result.riskProfile).toBeUndefined();
    });

    it('allowWhenAegisDenied true no permite Momentum si Aegis tiene hard DENY real', async () => {
        const enforceMomentum = {
            ...momentumRideConfig,
            mode: 'ENFORCE' as const,
            allowWhenAegisDenied: true,
            symbols: {
                ADAUSDT: {
                    ...momentumRideConfig.symbols.ADAUSDT,
                    mode: 'ENFORCE' as const
                }
            }
        };
        const deniedContext = momentumContext({
            momentumRideConfig: enforceMomentum,
            decisionBrain: {
                decision: 'DO_NOT_ENTER',
                block: { decision: 'DO_NOT_ENTER', do_not_enter_prob: 0.9 }
            }
        });
        const denied = await AegisEntryGuardOrchestrator.evaluate(deniedContext, policy({
            regime_context: { enabled: true, mode: 'SHADOW' },
            momentum_ride: { enabled: true, mode: 'ENFORCE' }
        }));

        expect(denied.strategyCandidates.momentum_ride.decision).toBe('DENY');
        expect(denied.strategyCandidates.momentum_ride.reason).toBe('decision_brain_do_not_enter');
        expect(denied.finalDecision).toBe('DENY');
        expect(denied.finalStrategy).toBe('none');
        expect(denied.riskProfile).toBeUndefined();
        expect(denied.guards.find((guard) => guard.name === 'momentum_ride')?.metadata).toMatchObject({
            overrideStatus: 'reserved_not_active',
            overrideReason: 'momentum_override_reserved_not_active',
            hardSafetyPassed: false,
            hardSafetyReason: 'decision_brain_do_not_enter'
        });
    });

    it('Momentum ENFORCE ALLOW + hard safety fail no abre momentum ni overridea Aegis DENY', async () => {
        const enforceMomentum = {
            ...momentumRideConfig,
            mode: 'ENFORCE' as const,
            allowWhenAegisDenied: true,
            symbols: {
                ADAUSDT: {
                    ...momentumRideConfig.symbols.ADAUSDT,
                    mode: 'ENFORCE' as const
                }
            }
        };
        const result = await AegisEntryGuardOrchestrator.evaluate(momentumContext({
            momentumRideConfig: enforceMomentum,
            decisionBrain: {
                decision: 'DO_NOT_ENTER',
                block: { decision: 'DO_NOT_ENTER', do_not_enter_prob: 0.9 }
            },
            operational: {
                ...momentumContext().operational,
                sameSymbolPositionExists: true
            }
        }), policy({
            regime_context: { enabled: true, mode: 'SHADOW' },
            momentum_ride: { enabled: true, mode: 'ENFORCE' }
        }));

        expect(result.strategyCandidates.momentum_ride.decision).toBe('DENY');
        expect(result.decisions.momentumRide?.reasons).toContain('momentum_safety_cap_exceeded');
        expect(result.finalDecision).toBe('DENY');
        expect(result.finalStrategy).toBe('none');
        expect(result.riskProfile).toBeUndefined();
    });

    it('BTC/ETH contradict niega Momentum pero no Aegis normal', async () => {
        const enforceMomentum = {
            ...momentumRideConfig,
            mode: 'ENFORCE' as const,
            symbols: {
                ADAUSDT: {
                    ...momentumRideConfig.symbols.ADAUSDT,
                    mode: 'ENFORCE' as const
                }
            }
        };
        const result = await AegisEntryGuardOrchestrator.evaluate(momentumContext({
            momentumRideConfig: enforceMomentum,
            eventRisk: {
                ...momentumContext().eventRisk!,
                btcAction: 'SHORT',
                ethAction: 'LONG'
            },
            regime: undefined
        }), policy({
            regime_context: { enabled: false, mode: 'OFF' },
            momentum_ride: { enabled: true, mode: 'ENFORCE' },
            regime: { enabled: false, mode: 'OFF' }
        }));

        expect(result.decisions.momentumRide?.reasons).toContain('momentum_btc_eth_contradict');
        expect(result.finalDecision).toBe('ALLOW');
        expect(result.finalStrategy).toBe('aegis_turbo');
        expect(result.riskProfile).toBeUndefined();
    });
});
