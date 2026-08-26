import { Side } from '../../../types';
import { evaluateMainStackingMomentum } from '../../MainStackingMomentumStrategy';
import { RegimeEngineV2 } from '../../regime-v2/RegimeEngineV2';
import { RegimeEngineV2Decision, RegimeEngineV2InputCandle, RegimeEngineV2MarketAction } from '../../regime-v2/RegimeEngineV2.types';
import {
    AegisEntryContext,
    AegisEntryGuardPolicy,
    AegisEntryGuardResult,
    AegisMomentumRideContext,
    AegisMomentumRideRuntimeConfig,
    AegisMomentumRideSideRuntimeConfig,
    AegisMomentumRiskProfile,
    guardDisabledResult,
    isGuardEnforced,
    isGuardShadow
} from '../AegisEntryDecisionTypes';

export interface MomentumRideGuardAdapterResult {
    guard: AegisEntryGuardResult;
    momentumRide?: AegisMomentumRideContext;
    riskProfile?: AegisMomentumRiskProfile;
}

type MomentumRegimeObservation = NonNullable<AegisMomentumRideContext['regimeEngineV2']>;

export class MomentumRideGuardAdapter {
    static evaluate(context: AegisEntryContext, policy: AegisEntryGuardPolicy): MomentumRideGuardAdapterResult {
        const config = context.momentumRideConfig;
        if (policy.enabled !== true || policy.mode === 'OFF' || config?.enabled !== true || config.mode === 'OFF') {
            return { guard: guardDisabledResult('momentum_ride', 'momentum_ride_disabled') };
        }

        const symbolConfig = config.symbols[context.symbol];
        if (!symbolConfig?.enabled || symbolConfig.mode === 'OFF') {
            return notApplicable(policy, 'momentum_symbol_disabled', baseContext(false, context.side, ['momentum_symbol_disabled']));
        }

        const sideConfig = context.side === 'LONG' ? symbolConfig.long : symbolConfig.short;
        const oppositeSide = context.side === 'LONG' ? 'SHORT' : 'LONG';
        const oppositeSideConfig = oppositeSide === 'LONG' ? symbolConfig.long : symbolConfig.short;
        if (!sideConfig.enabled) {
            return notApplicable(policy, 'momentum_side_disabled', baseContext(false, context.side, ['momentum_side_disabled']));
        }
        const effectiveMode = effectiveMomentumMode(policy, config.mode, symbolConfig.mode);
        const regimeObservation = observeRegimeEngineV2(context, config);

        const oppositePattern = detectMomentumPattern(context, oppositeSideConfig, oppositeSide);
        if (oppositePattern.patternDetected) {
            const sideContradictContext: AegisMomentumRideContext = {
                ...withRegimeObservation(oppositePattern, config, regimeObservation),
                turboAgreement: false,
                btcEthAgreement: false,
                btcEthContradict: false,
                regimeConfirmed: false,
                reasons: [...oppositePattern.reasons, 'momentum_side_contradict']
            };
            return enforceDeny(policy, effectiveMode, 'momentum_side_contradict', sideContradictContext, config);
        }

        const pattern = withRegimeObservation(detectMomentumPattern(context, sideConfig, context.side), config, regimeObservation);
        if (!pattern.patternDetected) {
            return notApplicable(policy, pattern.reasons[0] ?? 'momentum_no_pattern', pattern);
        }

        const evaluation = evaluateMomentum(context, config, sideConfig, pattern);
        const riskProfile = evaluation.allowed
            ? buildRiskProfile(context, config, sideConfig)
            : undefined;

        if (effectiveMode === 'SHADOW') {
            const decision = evaluation.allowed ? 'SHADOW_ALLOW' : 'SHADOW_DENY';
            const reason = evaluation.allowed ? 'momentum_shadow_allow' : 'momentum_shadow_deny';
            return {
                guard: {
                    name: 'momentum_ride',
                    enabled: true,
                    mode: 'SHADOW',
                    decision,
                    reason,
                    wouldBlock: false,
                    enforced: false,
                    metadata: {
                        momentumRide: evaluation.context,
                        riskProfile,
                        failedReasons: evaluation.failedReasons,
                        strategyWouldBlock: !evaluation.allowed,
                        effectiveMode,
                        allowWhenAegisDenied: config.allowWhenAegisDenied,
                        requireAegisDirectionConfirmation: config.requireAegisDirectionConfirmation,
                        allowMomentumAgainstAegis: config.allowMomentumAgainstAegis,
                        overrideStatus: config.allowWhenAegisDenied ? 'reserved_not_active' : 'disabled',
                        overrideReason: config.allowWhenAegisDenied ? 'momentum_override_reserved_not_active' : undefined,
                        againstAegisStatus: config.allowMomentumAgainstAegis ? 'reserved_not_active' : 'disabled',
                        againstAegisReason: config.allowMomentumAgainstAegis ? 'momentum_override_reserved_not_active' : undefined
                    }
                },
                momentumRide: evaluation.context,
                riskProfile
            };
        }

        return {
            guard: {
                name: 'momentum_ride',
                enabled: true,
                mode: 'ENFORCE',
                decision: evaluation.allowed ? 'ALLOW' : 'DENY',
                reason: evaluation.allowed ? 'momentum_pattern_detected' : evaluation.failedReasons[0] ?? 'momentum_denied',
                wouldBlock: false,
                enforced: isGuardEnforced(policy),
                metadata: {
                    momentumRide: evaluation.context,
                    riskProfile,
                    failedReasons: evaluation.failedReasons,
                    strategyWouldBlock: !evaluation.allowed,
                    effectiveMode,
                    allowWhenAegisDenied: config.allowWhenAegisDenied,
                    requireAegisDirectionConfirmation: config.requireAegisDirectionConfirmation,
                    allowMomentumAgainstAegis: config.allowMomentumAgainstAegis,
                    overrideStatus: config.allowWhenAegisDenied ? 'reserved_not_active' : 'disabled',
                    overrideReason: config.allowWhenAegisDenied ? 'momentum_override_reserved_not_active' : undefined,
                    againstAegisStatus: config.allowMomentumAgainstAegis ? 'reserved_not_active' : 'disabled',
                    againstAegisReason: config.allowMomentumAgainstAegis ? 'momentum_override_reserved_not_active' : undefined
                }
            },
            momentumRide: evaluation.context,
            riskProfile
        };
    }
}

function enforceDeny(
    policy: AegisEntryGuardPolicy,
    effectiveMode: 'ENFORCE' | 'SHADOW',
    reason: string,
    momentumRide: AegisMomentumRideContext,
    config: AegisMomentumRideRuntimeConfig
): MomentumRideGuardAdapterResult {
    const failedReasons = [
        reason,
        ...(config.allowMomentumAgainstAegis ? ['momentum_override_reserved_not_active'] : [])
    ];
    return {
        guard: {
            name: 'momentum_ride',
            enabled: true,
            mode: effectiveMode,
            decision: effectiveMode === 'ENFORCE' ? 'DENY' : 'SHADOW_DENY',
            reason,
            wouldBlock: false,
            enforced: isGuardEnforced(policy),
            metadata: {
                momentumRide,
                failedReasons,
                strategyWouldBlock: true,
                effectiveMode,
                allowWhenAegisDenied: config.allowWhenAegisDenied,
                requireAegisDirectionConfirmation: config.requireAegisDirectionConfirmation,
                allowMomentumAgainstAegis: config.allowMomentumAgainstAegis,
                overrideStatus: config.allowWhenAegisDenied ? 'reserved_not_active' : 'disabled',
                overrideReason: config.allowWhenAegisDenied ? 'momentum_override_reserved_not_active' : undefined,
                againstAegisStatus: config.allowMomentumAgainstAegis ? 'reserved_not_active' : 'disabled',
                againstAegisReason: config.allowMomentumAgainstAegis ? 'momentum_override_reserved_not_active' : undefined
            }
        },
        momentumRide: {
            ...momentumRide,
            reasons: [...momentumRide.reasons, ...failedReasons.filter((failed) => !momentumRide.reasons.includes(failed))]
        }
    };
}

function effectiveMomentumMode(
    policy: AegisEntryGuardPolicy,
    configMode: AegisMomentumRideRuntimeConfig['mode'],
    symbolMode: AegisMomentumRideRuntimeConfig['symbols'][string]['mode']
): 'ENFORCE' | 'SHADOW' {
    return policy.mode === 'ENFORCE' && symbolMode !== 'SHADOW' && configMode === 'ENFORCE'
        ? 'ENFORCE'
        : 'SHADOW';
}

function notApplicable(
    policy: AegisEntryGuardPolicy,
    reason: string,
    momentumRide: AegisMomentumRideContext
): MomentumRideGuardAdapterResult {
    return {
        guard: {
            name: 'momentum_ride',
            enabled: policy.enabled === true,
            mode: policy.mode,
            decision: 'NOT_APPLICABLE',
            reason,
            wouldBlock: false,
            enforced: isGuardEnforced(policy),
            metadata: {
                momentumRide,
                shadow: isGuardShadow(policy)
            }
        },
        momentumRide
    };
}

function evaluateMomentum(
    context: AegisEntryContext,
    config: AegisMomentumRideRuntimeConfig,
    sideConfig: AegisMomentumRideSideRuntimeConfig,
    pattern: AegisMomentumRideContext
): { allowed: boolean; failedReasons: string[]; context: AegisMomentumRideContext } {
    const failedReasons: string[] = [];
    const turboState = turboStateFor(context, sideConfig);
    const turboAgreement = turboState.confirmed
        && context.turboScore >= sideConfig.minTurboScore;
    const regimeContext = context.regimeContext;
    const legacyRegimeConfirmed = regimeContext !== undefined
        && sideConfig.allowedRegimes.includes(regimeContext.label)
        && (context.side === 'LONG' ? regimeContext.momentumLongAllowed : regimeContext.momentumShortAllowed);
    const regimeGateEnabled = config.regimeFilter.enabled === true
        && config.regimeFilter.useAsGate === true
        && config.regimeFilter.ignoreForEntry !== true;
    const regimeConfirmed = regimeGateEnabled ? legacyRegimeConfirmed : true;
    const btcEthState = btcEthStateFor(context);
    const btcEthAgreement = btcEthState.agreement;
    const btcEthContradict = btcEthState.contradict;
    const tailRisk = context.entryQuality.tailRiskScore;
    const tailRiskOk = tailRisk === undefined || tailRisk === null || tailRisk <= sideConfig.maxTailRiskScore;
    const safetyOk = safetyCapsAllow(context, config, failedReasons);

    if (!regimeConfirmed) failedReasons.push('momentum_regime_not_confirmed');
    if (turboState.contradict) failedReasons.push('momentum_turbo_contradict');
    else if (!turboAgreement) failedReasons.push('momentum_turbo_not_confirmed');
    if (config.allowMomentumAgainstAegis && (turboState.contradict || !turboAgreement)) {
        failedReasons.push('momentum_override_reserved_not_active');
    }
    if (config.requireBtcEthNotContradicting && btcEthContradict) failedReasons.push('momentum_btc_eth_contradict');
    if (config.requireBtcEthConfirmation && !btcEthAgreement) failedReasons.push('momentum_btc_eth_not_confirmed');
    if (!tailRiskOk) failedReasons.push('momentum_tail_risk_high');
    if (!safetyOk) failedReasons.push('momentum_safety_cap_exceeded');

    const nextContext: AegisMomentumRideContext = {
        ...pattern,
        turboAgreement,
        btcEthAgreement,
        btcEthContradict,
        regimeConfirmed,
        reasons: [
            ...pattern.reasons,
            ...(turboAgreement ? ['momentum_turbo_confirmed'] : []),
            ...regimeObservationReasons(pattern.regimeEngineV2, config),
            ...failedReasons
        ]
    };
    return {
        allowed: failedReasons.length === 0,
        failedReasons,
        context: nextContext
    };
}

function detectMomentumPattern(
    context: AegisEntryContext,
    config: AegisMomentumRideSideRuntimeConfig,
    side: Side
): AegisMomentumRideContext {
    const candles = context.entryQuality.ruleGate.recentCandles ?? [];
    if (context.signal.metadata?.momentum_stacking_replica === true) {
        const exact = evaluateMainStackingMomentum(candles as any, side);
        return {
            patternDetected: exact.allowed,
            patternSide: exact.allowed ? side : undefined,
            candlesCount: 3,
            volumeRatio: exact.diagnostics.volumeAverage && exact.diagnostics.requiredVolume
                ? exact.diagnostics.requiredVolume / exact.diagnostics.volumeAverage
                : undefined,
            closeNearExtreme: exact.diagnostics.checks.wicks,
            wickRatio: undefined,
            overextended: exact.diagnostics.checks.extension === false,
            turboAgreement: false,
            btcEthAgreement: false,
            btcEthContradict: false,
            regimeConfirmed: false,
            reasons: [exact.reason]
        };
    }
    const count = config.momentumCandles;
    if (candles.length < count + 1) {
        return baseContext(false, context.side, ['momentum_insufficient_candles']);
    }
    const window = candles.slice(-count);
    const allGreen = window.every((candle) => candle.close > candle.open);
    const allRed = window.every((candle) => candle.close < candle.open);
    const ascending = window.every((candle, index) => index === 0 || candle.close > window[index - 1].close);
    const descending = window.every((candle, index) => index === 0 || candle.close < window[index - 1].close);
    const sideMatches = side === 'LONG'
        ? allGreen && ascending
        : allRed && descending;
    if (!sideMatches) return baseContext(false, side, ['momentum_no_pattern']);

    const previousVolumes = candles.slice(0, -1)
        .map((candle) => candle.volume)
        .filter((value): value is number => isFiniteNumber(value));
    const avgVolume = average(previousVolumes.slice(-20));
    const latest = candles[candles.length - 1];
    if (!avgVolume || !isFiniteNumber(latest.volume)) {
        return baseContext(false, context.side, ['momentum_missing_volume']);
    }
    const volumeRatio = latest.volume / avgVolume;
    const range = latest.high - latest.low;
    const closeLocation = range > 0 ? (latest.close - latest.low) / range : 0.5;
    const closeNearExtreme = side === 'LONG'
        ? closeLocation >= config.minCloseLocation
        : closeLocation <= 1 - config.minCloseLocation;
    const wickRatio = range > 0
        ? side === 'LONG'
            ? (latest.high - Math.max(latest.open, latest.close)) / range
            : (Math.min(latest.open, latest.close) - latest.low) / range
        : 0;
    const bodyMovePct = window[0].open > 0
        ? Math.abs(window[window.length - 1].close - window[0].open) / window[0].open
        : 0;
    const overextended = bodyMovePct > config.maxOverextensionPct;
    const reasons = ['momentum_pattern_detected'];
    if (volumeRatio < config.minVolumeRatio) reasons.push('momentum_volume_ratio_low');
    if (config.requireCloseNearExtreme && !closeNearExtreme) reasons.push('momentum_close_not_near_extreme');
    if (wickRatio > config.maxWickRatio) reasons.push(side === 'LONG' ? 'momentum_upper_wick_excessive' : 'momentum_lower_wick_excessive');
    if (overextended) reasons.push('momentum_overextended');

    return {
        patternDetected: reasons.length === 1,
        patternSide: side,
        candlesCount: count,
        volumeRatio: round(volumeRatio),
        closeNearExtreme,
        wickRatio: round(wickRatio),
        overextended,
        turboAgreement: false,
        btcEthAgreement: false,
        btcEthContradict: false,
        regimeConfirmed: false,
        reasons
    };
}

function baseContext(patternDetected: boolean, side: Side, reasons: string[]): AegisMomentumRideContext {
    return {
        patternDetected,
        patternSide: patternDetected ? side : undefined,
        reasons
    };
}

function buildRiskProfile(
    context: AegisEntryContext,
    config: AegisMomentumRideRuntimeConfig,
    sideConfig: AegisMomentumRideSideRuntimeConfig
): AegisMomentumRiskProfile {
    return {
        strategy: 'momentum_ride',
        symbol: context.symbol,
        side: context.side,
        leverage: Math.min(sideConfig.leverage, config.safetyCaps.maxLeverage),
        positionFraction: Math.min(sideConfig.positionFraction, config.safetyCaps.maxPositionFraction),
        maxOpenPositions: config.safetyCaps.maxOpenMomentumPositions,
        cooldown: config.safetyCaps.cooldownAfterLossMinutes,
        sourceRule: `${context.symbol}.${context.side.toLowerCase()}`,
        source: 'effective_config',
        positionFractionSource: 'yaml'
    };
}

function observeRegimeEngineV2(context: AegisEntryContext, config: AegisMomentumRideRuntimeConfig): MomentumRegimeObservation | undefined {
    if (config.regimeFilter.recordMetadata !== true) return undefined;
    const candles = (context.entryQuality.ruleGate.recentCandles ?? [])
        .filter((candle) => isFiniteNumber(candle.open) && isFiniteNumber(candle.high) && isFiniteNumber(candle.low) && isFiniteNumber(candle.close))
        .map((candle): RegimeEngineV2InputCandle => ({
            timestamp: candle.timestamp,
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
            volume: isFiniteNumber(candle.volume) ? candle.volume : 0
        }));
    const decision = RegimeEngineV2.evaluate({
        symbol: context.symbol,
        candles,
        market: {
            btc: {
                action: normalizeMarketAction(context.regime?.btcAction ?? context.eventRisk.btcAction),
                score: context.regime?.btcScore ?? context.eventRisk.btcScore
            },
            eth: {
                action: normalizeMarketAction(context.regime?.ethAction ?? context.eventRisk.ethAction),
                score: context.regime?.ethScore ?? context.eventRisk.ethScore
            }
        }
    });
    return {
        technicalRegime: decision.technicalRegime,
        momentumEnvironment: decision.momentumEnvironment,
        transitionRisk: decision.transition.risk,
        confidence: decision.confidence,
        falseBreakoutRisk: falseBreakoutRisk(decision),
        reasons: decision.reasons,
        observedReason: observedRegimeReason(decision, config)
    };
}

function withRegimeObservation(
    context: AegisMomentumRideContext,
    config: AegisMomentumRideRuntimeConfig,
    observation: MomentumRegimeObservation | undefined
): AegisMomentumRideContext {
    return {
        ...context,
        researchMode: config.researchMode,
        regimeUsedAsGate: config.regimeFilter.enabled === true && config.regimeFilter.useAsGate === true && config.regimeFilter.ignoreForEntry !== true,
        regimeIgnoredForEntry: config.regimeFilter.ignoreForEntry === true || config.regimeFilter.useAsGate !== true,
        regimeIgnoreReason: config.researchMode && (config.regimeFilter.ignoreForEntry === true || config.regimeFilter.useAsGate !== true)
            ? 'research_mode'
            : undefined,
        regimeEngineV2: observation
    };
}

function regimeObservationReasons(
    observation: MomentumRegimeObservation | undefined,
    config: AegisMomentumRideRuntimeConfig
): string[] {
    if (!observation) return [];
    const ignored = config.researchMode && (config.regimeFilter.ignoreForEntry === true || config.regimeFilter.useAsGate !== true);
    if (ignored && observation.momentumEnvironment === 'AVOID_MOMENTUM') return ['regime_observed_avoid_ignored_by_research_mode'];
    if (ignored && observation.momentumEnvironment === 'UNKNOWN') return ['regime_observed_unknown_ignored_by_research_mode'];
    return [observation.observedReason];
}

function observedRegimeReason(decision: RegimeEngineV2Decision, config: AegisMomentumRideRuntimeConfig): string {
    const ignored = config.researchMode && (config.regimeFilter.ignoreForEntry === true || config.regimeFilter.useAsGate !== true);
    if (decision.momentumEnvironment.startsWith('ALLOW')) return 'regime_observed_allow';
    if (decision.momentumEnvironment.startsWith('WATCH')) return 'regime_observed_watch';
    if (decision.momentumEnvironment === 'UNKNOWN') return ignored
        ? 'regime_observed_unknown_ignored_by_research_mode'
        : 'regime_observed_unknown';
    return ignored
        ? 'regime_observed_avoid_ignored_by_research_mode'
        : 'regime_observed_avoid';
}

function falseBreakoutRisk(decision: RegimeEngineV2Decision): number | undefined {
    const values = [
        decision.indicators.failedBreakoutPressure,
        decision.indicators.adverseWickAgainstBreakout,
        decision.indicators.shortSweepRisk,
        decision.indicators.shortAbsorptionRisk
    ].filter(isFiniteNumber);
    return values.length > 0 ? round(Math.max(...values)) : undefined;
}

function normalizeMarketAction(value: unknown): RegimeEngineV2MarketAction | undefined {
    const normalized = String(value || '').trim().toUpperCase();
    if (normalized === 'LONG' || normalized === 'SHORT' || normalized === 'HOLD') return normalized;
    return undefined;
}

function safetyCapsAllow(
    context: AegisEntryContext,
    config: AegisMomentumRideRuntimeConfig,
    failedReasons: string[]
): boolean {
    let allowed = true;
    if (context.operational.sameSymbolPositionExists) {
        failedReasons.push('momentum_safety_same_symbol_position');
        allowed = false;
    }
    if ((context.operational.openMomentumPositions ?? 0) >= config.safetyCaps.maxOpenMomentumPositions) {
        failedReasons.push('momentum_safety_open_momentum_positions');
        allowed = false;
    }
    if (context.operational.openPositionsCount >= config.safetyCaps.maxTotalOpenPositionsWhenMomentum) {
        failedReasons.push('momentum_safety_total_open_positions');
        allowed = false;
    }
    if (context.operational.tradesToday >= config.safetyCaps.maxMomentumTradesPerDay) {
        failedReasons.push('momentum_safety_daily_trades');
        allowed = false;
    }
    if (context.operational.consecutiveLosses >= config.safetyCaps.maxConsecutiveMomentumLosses) {
        failedReasons.push('momentum_safety_consecutive_losses');
        allowed = false;
    }
    if (
        context.operational.recentStopLossMinutes !== undefined
        && context.operational.recentStopLossMinutes < config.safetyCaps.cooldownAfterLossMinutes
    ) {
        failedReasons.push('momentum_safety_loss_cooldown');
        allowed = false;
    }
    return allowed;
}

function turboStateFor(
    context: AegisEntryContext,
    sideConfig: AegisMomentumRideSideRuntimeConfig
): { confirmed: boolean; contradict: boolean } {
    const actions = [context.rawAction, context.finalAction]
        .map(normalizeAction)
        .filter((action): action is Side | 'HOLD' | 'NEUTRAL' => action !== undefined);
    const opposite = context.side === 'LONG' ? 'SHORT' : 'LONG';
    return {
        confirmed: actions.some((action) => action === context.side)
            && context.turboScore >= sideConfig.minTurboScore,
        contradict: actions.some((action) => action === opposite)
    };
}

function normalizeAction(action: string | undefined): Side | 'HOLD' | 'NEUTRAL' | undefined {
    const normalized = String(action || '').trim().toUpperCase();
    if (normalized === 'LONG' || normalized === 'SHORT' || normalized === 'HOLD' || normalized === 'NEUTRAL') return normalized;
    return undefined;
}

function btcEthStateFor(context: AegisEntryContext): { agreement: boolean; contradict: boolean } {
    const btc = context.regime?.btcAction ?? context.eventRisk.btcAction;
    const eth = context.regime?.ethAction ?? context.eventRisk.ethAction;
    const actions = [btc, eth].map((action) => String(action || '').trim().toUpperCase()).filter(Boolean);
    const opposite = context.side === 'LONG' ? 'SHORT' : 'LONG';
    return {
        agreement: actions.length > 0 && actions.every((action) => action === context.side),
        contradict: actions.some((action) => action === opposite)
    };
}

function average(values: number[]): number | undefined {
    return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function round(value: unknown, digits = 6): number | undefined {
    if (!isFiniteNumber(value)) return undefined;
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}
