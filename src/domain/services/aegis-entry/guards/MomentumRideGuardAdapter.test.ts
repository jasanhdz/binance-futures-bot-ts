import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    AegisEntryContext,
    AegisMomentumRideRuntimeConfig,
    AegisRegimeContext
} from '../AegisEntryDecisionTypes';
import { RegimeEngineV2 } from '../../regime-v2/RegimeEngineV2';
import { RegimeEngineV2Decision } from '../../regime-v2/RegimeEngineV2.types';
import { MomentumRideGuardAdapter } from './MomentumRideGuardAdapter';

const regimeContext: AegisRegimeContext = {
    label: 'MOMENTUM_UP',
    confidence: 0.82,
    momentumLongAllowed: true,
    momentumShortAllowed: false,
    trendDirection: 'UP',
    chopRisk: 0.1,
    exhaustionRisk: 0.1,
    volatilityState: 'NORMAL',
    volumeState: 'HIGH',
    reasons: ['test'],
    indicators: { volumeRatio: 1.8, adx: 25, choppiness: 40 }
};

const momentumConfig: AegisMomentumRideRuntimeConfig = {
    enabled: true,
    mode: 'ENFORCE',
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
        XRPUSDT: {
            enabled: true,
            mode: 'ENFORCE',
            long: {
                enabled: true,
                leverage: 50,
                positionFraction: 0.02,
                minTurboScore: 0.85,
                minVolumeRatio: 1.5,
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
                leverage: 25,
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

function validCandles() {
    return [
        ...Array.from({ length: 20 }, (_, index) => ({ open: 1 + index * 0.001, high: 1.01, low: 0.99, close: 1 + index * 0.0015, volume: 100 })),
        { open: 1.10, high: 1.12, low: 1.09, close: 1.115, volume: 130 },
        { open: 1.115, high: 1.14, low: 1.11, close: 1.135, volume: 150 },
        { open: 1.135, high: 1.17, low: 1.13, close: 1.165, volume: 220 }
    ];
}

function validShortCandles() {
    return [
        ...Array.from({ length: 20 }, (_, index) => ({ open: 1.2 - index * 0.001, high: 1.21, low: 1.18, close: 1.2 - index * 0.0015, volume: 100 })),
        { open: 1.16, high: 1.17, low: 1.12, close: 1.125, volume: 130 },
        { open: 1.125, high: 1.13, low: 1.09, close: 1.095, volume: 150 },
        { open: 1.095, high: 1.10, low: 1.05, close: 1.055, volume: 220 }
    ];
}

function momentumConfigWithShortEnabled(overrides: Partial<AegisMomentumRideRuntimeConfig> = {}): AegisMomentumRideRuntimeConfig {
    return {
        ...momentumConfig,
        symbols: {
            XRPUSDT: {
                ...momentumConfig.symbols.XRPUSDT,
                short: {
                    ...momentumConfig.symbols.XRPUSDT.short,
                    enabled: true,
                    minTurboScore: 0.85,
                    maxOverextensionPct: 0.1
                }
            }
        },
        ...overrides
    };
}

function context(overrides: Partial<AegisEntryContext> = {}): AegisEntryContext {
    return {
        symbol: 'XRPUSDT',
        side: 'LONG',
        rawAction: 'LONG',
        finalAction: 'LONG',
        turboScore: 0.91,
        votes: { long: 3, short: 0, neutral: 0 },
        leverage: 20,
        requestedPositionFraction: 0.01,
        basePositionFraction: 0.01,
        signal: { symbol: 'XRPUSDT', action: 'LONG', confidence: 0.91, source: 'AEGIS_TURBO', longProb: 0.91, shortProb: 0.04, neutralProb: 0.05 },
        gate: { allowed: true, side: 'LONG', reason: 'ok', leverage: 20, positionFraction: 0.01, stopRoe: -0.15, takeProfitRoe: 0.25, trailingActivationRoe: 0.15, trailingCallbackRoe: 0.08, turboScore: 0.91, votes: { long: 3 } },
        entryQuality: {
            tailRiskScore: 0.2,
            ruleGate: {
                enabled: true,
                mode: 'ENFORCE',
                config: {
                    minScoreLong: 0.65,
                    minScoreShort: 0.7,
                    requireMomentumConfirm: false,
                    antiFallingKnifeEnabled: false,
                    antiFallingKnifeLookbackCandles: 3,
                    maxAdverseRecentReturn: 0.003,
                    overextensionEnabled: false,
                    emaDistanceLimit: 0.006,
                    volatilityEnabled: false,
                    maxAtrPercentile: 0.75
                },
                recentCandles: validCandles()
            }
        },
        eventRisk: { enabled: true, mode: 'NORMAL', enforce: false, isAltSymbol: true, btcAction: 'LONG', ethAction: 'LONG' },
        regimeContext,
        momentumRideConfig: momentumConfig,
        shortGate: { config: { enabled: false, mode: 'PREMIUM_ONLY', position_fraction_multiplier: 1, max_leverage: 0, block_symbols: [], allow_if_regime_bearish: false } },
        decisionEnforcement: { config: { enabled: false, mode: 'OFF', block_do_not_enter: false, block_wait_confirmation: false, block_manual_only: false, block_entry_quality_shadow_block_when_event_risk: { enabled: false, event_modes: [] }, event_risk_enforcement: { caution_blocks_weak_entries: false, risk_off_blocks_non_a_plus: false, manual_only_blocks_all_new_entries: false }, block_caution_would_block_unless_a_plus: false, block_all_entry_quality_shadow_block: false, block_all_tail_risk_high: false } },
        operational: { consecutiveLosses: 0, tradesToday: 0, openPositionsCount: 0, openProbePositions: 0, sameSymbolPositionExists: false, timestamp: Date.now() },
        ...overrides
    };
}

function regimeEngineDecision(overrides: Partial<RegimeEngineV2Decision> = {}): RegimeEngineV2Decision {
    return {
        symbol: 'XRPUSDT',
        timestamp: '2026-05-23T00:00:00.000Z',
        timeframe: '5m',
        technicalRegime: 'CHOP',
        technicalDirection: 'NONE',
        momentumEnvironment: 'AVOID_MOMENTUM',
        confidence: 0.72,
        scores: {
            trendStrength: 0.1,
            momentumQuality: 0.2,
            chopRisk: 0.8,
            exhaustionRisk: 0.3,
            transitionRisk: 0.7,
            volatilityRisk: 0.2,
            marketConfirmationScore: 0.5
        },
        marketConfirmation: { state: 'NEUTRAL' },
        transition: { risk: 'HIGH', reasons: ['mock_transition'] },
        indicators: { failedBreakoutPressure: 0.6 },
        reasons: ['mock_regime_observation'],
        ...overrides
    };
}

describe('MomentumRideGuardAdapter', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('OFF no evalua', () => {
        const result = MomentumRideGuardAdapter.evaluate(context(), { enabled: false, mode: 'OFF' });
        expect(result.guard.enabled).toBe(false);
    });

    it('SHADOW con patron valido no abre pero marca shadow allow', () => {
        const result = MomentumRideGuardAdapter.evaluate(context(), { enabled: true, mode: 'SHADOW' });
        expect(result.guard.decision).toBe('SHADOW_ALLOW');
        expect(result.riskProfile?.leverage).toBe(50);
    });

    it('ENFORCE con patron valido, regimen y turbo confirmados propone riskProfile', () => {
        const result = MomentumRideGuardAdapter.evaluate(context(), { enabled: true, mode: 'ENFORCE' });
        expect(result.guard.decision).toBe('ALLOW');
        expect(result.riskProfile).toMatchObject({ strategy: 'momentum_ride', leverage: 50, positionFraction: 0.02 });
        expect(result.momentumRide?.reasons).toContain('momentum_turbo_confirmed');
    });

    it('ENFORCE con CHOP permite momentum en research mode porque regimen solo observa', () => {
        const result = MomentumRideGuardAdapter.evaluate(context({
            regimeContext: { ...regimeContext, label: 'CHOP', momentumLongAllowed: false }
        }), { enabled: true, mode: 'ENFORCE' });
        expect(result.guard.decision).toBe('ALLOW');
        expect(result.momentumRide?.reasons).not.toContain('momentum_regime_not_confirmed');
        expect(result.momentumRide).toMatchObject({
            researchMode: true,
            regimeUsedAsGate: false,
            regimeIgnoredForEntry: true,
            regimeIgnoreReason: 'research_mode'
        });
    });

    it('RegimeEngineV2 AVOID/UNKNOWN queda como metadata y no bloquea en research mode', () => {
        for (const [environment, expectedReason] of [
            ['AVOID_MOMENTUM', 'regime_observed_avoid_ignored_by_research_mode'],
            ['UNKNOWN', 'regime_observed_unknown_ignored_by_research_mode']
        ] as const) {
            vi.spyOn(RegimeEngineV2, 'evaluate').mockReturnValueOnce(regimeEngineDecision({
                momentumEnvironment: environment,
                technicalRegime: environment === 'UNKNOWN' ? 'UNKNOWN' : 'CHOP',
                transition: { risk: environment === 'UNKNOWN' ? 'MODERATE' : 'HIGH', reasons: ['mock_transition'] }
            }));

            const result = MomentumRideGuardAdapter.evaluate(context(), { enabled: true, mode: 'ENFORCE' });

            expect(result.guard.decision).toBe('ALLOW');
            expect(result.momentumRide?.regimeUsedAsGate).toBe(false);
            expect(result.momentumRide?.regimeIgnoredForEntry).toBe(true);
            expect(result.momentumRide?.regimeIgnoreReason).toBe('research_mode');
            expect(result.momentumRide?.regimeEngineV2).toMatchObject({
                momentumEnvironment: environment,
                transitionRisk: environment === 'UNKNOWN' ? 'MODERATE' : 'HIGH'
            });
            expect(result.momentumRide?.reasons).toContain(expectedReason);
            vi.mocked(RegimeEngineV2.evaluate).mockRestore();
        }
    });

    it('regime_filter useAsGate=true mantiene bloqueo legacy por regimen', () => {
        const result = MomentumRideGuardAdapter.evaluate(context({
            regimeContext: { ...regimeContext, label: 'CHOP', momentumLongAllowed: false },
            momentumRideConfig: {
                ...momentumConfig,
                regimeFilter: {
                    enabled: true,
                    useAsGate: true,
                    recordMetadata: true,
                    ignoreForEntry: false
                }
            }
        }), { enabled: true, mode: 'ENFORCE' });

        expect(result.guard.decision).toBe('DENY');
        expect(result.momentumRide?.reasons).toContain('momentum_regime_not_confirmed');
    });

    it('ENFORCE con turbo contrario no permite momentum', () => {
        const result = MomentumRideGuardAdapter.evaluate(context({ finalAction: 'SHORT' }), { enabled: true, mode: 'ENFORCE' });
        expect(result.guard.decision).toBe('DENY');
        expect(result.guard.reason).toBe('momentum_turbo_contradict');
        expect(result.momentumRide?.reasons).toContain('momentum_turbo_contradict');
    });

    it('ENFORCE con rawAction contrario no permite momentum', () => {
        const result = MomentumRideGuardAdapter.evaluate(context({ rawAction: 'SHORT', finalAction: 'LONG' }), { enabled: true, mode: 'ENFORCE' });
        expect(result.guard.decision).toBe('DENY');
        expect(result.guard.reason).toBe('momentum_turbo_contradict');
        expect(result.momentumRide?.reasons).toContain('momentum_turbo_contradict');
    });

    it('ENFORCE con turbo HOLD no confirma momentum', () => {
        const result = MomentumRideGuardAdapter.evaluate(context({ rawAction: 'HOLD', finalAction: 'HOLD' }), { enabled: true, mode: 'ENFORCE' });
        expect(result.guard.decision).toBe('DENY');
        expect(result.guard.reason).toBe('momentum_turbo_not_confirmed');
        expect(result.momentumRide?.reasons).toContain('momentum_turbo_not_confirmed');
    });

    it('Momentum SHORT con Aegis LONG deniega por turbo contradict', () => {
        const downRegime: AegisRegimeContext = {
            ...regimeContext,
            label: 'MOMENTUM_DOWN',
            momentumLongAllowed: false,
            momentumShortAllowed: true,
            trendDirection: 'DOWN'
        };
        const result = MomentumRideGuardAdapter.evaluate(context({
            side: 'SHORT',
            rawAction: 'LONG',
            finalAction: 'LONG',
            votes: { long: 3, short: 0, neutral: 0 },
            regimeContext: downRegime,
            momentumRideConfig: momentumConfigWithShortEnabled(),
            entryQuality: {
                ...context().entryQuality,
                ruleGate: {
                    ...context().entryQuality.ruleGate,
                    recentCandles: validShortCandles()
                }
            },
            eventRisk: { ...context().eventRisk, btcAction: 'SHORT', ethAction: 'SHORT' }
        }), { enabled: true, mode: 'ENFORCE' });

        expect(result.guard.decision).toBe('DENY');
        expect(result.guard.reason).toBe('momentum_turbo_contradict');
        expect(result.momentumRide?.reasons).toContain('momentum_turbo_contradict');
    });

    it('Momentum pattern SHORT mientras context.side LONG deniega side contradict', () => {
        const result = MomentumRideGuardAdapter.evaluate(context({
            momentumRideConfig: momentumConfigWithShortEnabled(),
            entryQuality: {
                ...context().entryQuality,
                ruleGate: {
                    ...context().entryQuality.ruleGate,
                    recentCandles: validShortCandles()
                }
            }
        }), { enabled: true, mode: 'ENFORCE' });

        expect(result.guard.decision).toBe('DENY');
        expect(result.guard.reason).toBe('momentum_side_contradict');
        expect(result.momentumRide?.patternSide).toBe('SHORT');
        expect(result.momentumRide?.reasons).toContain('momentum_side_contradict');
    });

    it('Momentum pattern LONG mientras context.side SHORT deniega side contradict', () => {
        const result = MomentumRideGuardAdapter.evaluate(context({
            side: 'SHORT',
            rawAction: 'SHORT',
            finalAction: 'SHORT',
            votes: { short: 3, long: 0, neutral: 0 },
            momentumRideConfig: momentumConfigWithShortEnabled(),
            eventRisk: { ...context().eventRisk, btcAction: 'SHORT', ethAction: 'SHORT' }
        }), { enabled: true, mode: 'ENFORCE' });

        expect(result.guard.decision).toBe('DENY');
        expect(result.guard.reason).toBe('momentum_side_contradict');
        expect(result.momentumRide?.patternSide).toBe('LONG');
        expect(result.momentumRide?.reasons).toContain('momentum_side_contradict');
    });

    it('allowMomentumAgainstAegis=true queda reservado y no permite abrir contra Aegis', () => {
        const result = MomentumRideGuardAdapter.evaluate(context({
            finalAction: 'SHORT',
            momentumRideConfig: {
                ...momentumConfig,
                allowMomentumAgainstAegis: true
            }
        }), { enabled: true, mode: 'ENFORCE' });

        expect(result.guard.decision).toBe('DENY');
        expect(result.guard.reason).toBe('momentum_turbo_contradict');
        expect(result.momentumRide?.reasons).toContain('momentum_override_reserved_not_active');
        expect(result.guard.metadata).toMatchObject({
            allowMomentumAgainstAegis: true,
            againstAegisStatus: 'reserved_not_active',
            againstAegisReason: 'momentum_override_reserved_not_active'
        });
    });

    it('requireAegisDirectionConfirmation=true por default', () => {
        expect(momentumConfig.requireAegisDirectionConfirmation).toBe(true);
    });

    it('ENFORCE con tail risk alto no permite momentum', () => {
        const result = MomentumRideGuardAdapter.evaluate(context({
            entryQuality: { ...context().entryQuality, tailRiskScore: 0.5 }
        }), { enabled: true, mode: 'ENFORCE' });
        expect(result.momentumRide?.reasons).toContain('momentum_tail_risk_high');
    });

    it('simbolo deshabilitado es not applicable', () => {
        const result = MomentumRideGuardAdapter.evaluate(context({ symbol: 'ADAUSDT' }), { enabled: true, mode: 'ENFORCE' });
        expect(result.guard.reason).toBe('momentum_symbol_disabled');
    });

    it('lado deshabilitado es not applicable', () => {
        const result = MomentumRideGuardAdapter.evaluate(context({ side: 'SHORT', finalAction: 'SHORT', votes: { short: 3 } }), { enabled: true, mode: 'ENFORCE' });
        expect(result.guard.reason).toBe('momentum_side_disabled');
    });

    it('cappea leverage y position fraction con safety caps', () => {
        const cappedConfig = {
            ...momentumConfig,
            safetyCaps: { ...momentumConfig.safetyCaps, maxLeverage: 30, maxPositionFraction: 0.01 }
        };
        const result = MomentumRideGuardAdapter.evaluate(context({ momentumRideConfig: cappedConfig }), { enabled: true, mode: 'ENFORCE' });
        expect(result.riskProfile).toMatchObject({ leverage: 30, positionFraction: 0.01 });
    });

    it('riskProfile declara effective_config/yaml como fuente de position fraction', () => {
        const result = MomentumRideGuardAdapter.evaluate(context(), { enabled: true, mode: 'ENFORCE' });

        expect(result.riskProfile).toMatchObject({
            source: 'effective_config',
            positionFractionSource: 'yaml',
            positionFraction: 0.02
        });
    });

    it('safety cap de posiciones abiertas deniega momentum', () => {
        const result = MomentumRideGuardAdapter.evaluate(context({
            operational: { ...context().operational, openPositionsCount: 2 }
        }), { enabled: true, mode: 'ENFORCE' });
        expect(result.momentumRide?.reasons).toContain('momentum_safety_cap_exceeded');
    });

    it('maxOpenMomentumPositions=1 deniega si ya hay una posicion Momentum abierta', () => {
        const result = MomentumRideGuardAdapter.evaluate(context({
            operational: { ...context().operational, openMomentumPositions: 1 }
        }), { enabled: true, mode: 'ENFORCE' });

        expect(result.guard.decision).toBe('DENY');
        expect(result.momentumRide?.reasons).toContain('momentum_safety_open_momentum_positions');
        expect(result.momentumRide?.reasons).toContain('momentum_safety_cap_exceeded');
    });

    it('maxMomentumTradesPerDay=3 deniega al alcanzar el limite diario', () => {
        const result = MomentumRideGuardAdapter.evaluate(context({
            operational: { ...context().operational, tradesToday: 3 }
        }), { enabled: true, mode: 'ENFORCE' });

        expect(result.guard.decision).toBe('DENY');
        expect(result.momentumRide?.reasons).toContain('momentum_safety_daily_trades');
        expect(result.momentumRide?.reasons).toContain('momentum_safety_cap_exceeded');
    });

    it('maxConsecutiveMomentumLosses=2 deniega al alcanzar perdidas consecutivas', () => {
        const result = MomentumRideGuardAdapter.evaluate(context({
            operational: { ...context().operational, consecutiveLosses: 2 }
        }), { enabled: true, mode: 'ENFORCE' });

        expect(result.guard.decision).toBe('DENY');
        expect(result.momentumRide?.reasons).toContain('momentum_safety_consecutive_losses');
        expect(result.momentumRide?.reasons).toContain('momentum_safety_cap_exceeded');
    });

    it('cooldownAfterLossMinutes=60 deniega durante cooldown post perdida', () => {
        const result = MomentumRideGuardAdapter.evaluate(context({
            operational: { ...context().operational, recentStopLossMinutes: 30 }
        }), { enabled: true, mode: 'ENFORCE' });

        expect(result.guard.decision).toBe('DENY');
        expect(result.momentumRide?.reasons).toContain('momentum_safety_loss_cooldown');
        expect(result.momentumRide?.reasons).toContain('momentum_safety_cap_exceeded');
    });

    it('BTC/ETH contradictorio deniega solo momentum', () => {
        const result = MomentumRideGuardAdapter.evaluate(context({
            eventRisk: { ...context().eventRisk, btcAction: 'SHORT', ethAction: 'LONG' },
            regime: undefined
        }), { enabled: true, mode: 'ENFORCE' });

        expect(result.guard.decision).toBe('DENY');
        expect(result.momentumRide?.btcEthContradict).toBe(true);
        expect(result.momentumRide?.reasons).toContain('momentum_btc_eth_contradict');
    });

    it('posicion abierta del mismo simbolo es hard safety para momentum', () => {
        const result = MomentumRideGuardAdapter.evaluate(context({
            operational: { ...context().operational, sameSymbolPositionExists: true }
        }), { enabled: true, mode: 'ENFORCE' });

        expect(result.guard.decision).toBe('DENY');
        expect(result.momentumRide?.reasons).toContain('momentum_safety_cap_exceeded');
        expect(result.momentumRide?.reasons).toContain('momentum_safety_same_symbol_position');
    });
});
