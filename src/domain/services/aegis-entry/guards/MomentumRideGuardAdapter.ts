import { Side } from '../../../types';
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

        const oppositePattern = detectMomentumPattern(context, oppositeSideConfig, oppositeSide);
        if (oppositePattern.patternDetected) {
            const sideContradictContext: AegisMomentumRideContext = {
                ...oppositePattern,
                turboAgreement: false,
                btcEthAgreement: false,
                btcEthContradict: false,
                regimeConfirmed: false,
                reasons: [...oppositePattern.reasons, 'momentum_side_contradict']
            };
            return enforceDeny(policy, effectiveMode, 'momentum_side_contradict', sideContradictContext, config);
        }

        const pattern = detectMomentumPattern(context, sideConfig, context.side);
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
        && context.turboScore >= sideConfig.minTurboScore
        && sideVotes(context) >= sideConfig.minVotesAgreement;
    const regimeContext = context.regimeContext;
    const regimeConfirmed = regimeContext !== undefined
        && sideConfig.allowedRegimes.includes(regimeContext.label)
        && (context.side === 'LONG' ? regimeContext.momentumLongAllowed : regimeContext.momentumShortAllowed);
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
        sourceRule: `${context.symbol}.${context.side.toLowerCase()}`
    };
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
            && context.turboScore >= sideConfig.minTurboScore
            && sideVotes(context) >= sideConfig.minVotesAgreement,
        contradict: actions.some((action) => action === opposite)
    };
}

function normalizeAction(action: string | undefined): Side | 'HOLD' | 'NEUTRAL' | undefined {
    const normalized = String(action || '').trim().toUpperCase();
    if (normalized === 'LONG' || normalized === 'SHORT' || normalized === 'HOLD' || normalized === 'NEUTRAL') return normalized;
    return undefined;
}

function sideVotes(context: AegisEntryContext): number {
    return context.side === 'LONG' ? context.votes?.long ?? 0 : context.votes?.short ?? 0;
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
