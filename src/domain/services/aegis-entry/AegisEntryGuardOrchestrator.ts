import {
    AegisEntryContext,
    AegisEntryDecisionResult,
    AegisEntryFinalDecision,
    AegisEntryGuardName,
    AegisEntryGuardResult,
    AegisMomentumRiskProfile,
    AegisEntryPolicyRuntimeConfig,
    guardDisabledResult
} from './AegisEntryDecisionTypes';
import {
    buildAegisEntryDecisionTrace,
    compactAegisEntryDecisionMetadata
} from './AegisEntryDecisionTrace';
import { ShortGateGuardAdapter } from './guards/ShortGateGuardAdapter';
import { RegimeGuardAdapter } from './guards/RegimeGuardAdapter';
import { RegimeContextGuardAdapter } from './guards/RegimeContextGuardAdapter';
import { EntryQualityGuardAdapter } from './guards/EntryQualityGuardAdapter';
import { EventRiskGuardAdapter } from './guards/EventRiskGuardAdapter';
import { DecisionBrainGuardAdapter } from './guards/DecisionBrainGuardAdapter';
import {
    CleanEntryGuardAdapter,
    cleanEntryOutputFromDecisionEnforcementDenied
} from './guards/CleanEntryGuardAdapter';
import { MomentumRideGuardAdapter } from './guards/MomentumRideGuardAdapter';
import { ProbeModeGuardAdapter } from './guards/ProbeModeGuardAdapter';
import { AegisLongRiskShadowGuardAdapter } from './guards/AegisLongRiskShadowGuardAdapter';

function defaultGuard(name: AegisEntryGuardName): AegisEntryGuardResult {
    return guardDisabledResult(name, `${name}_not_evaluated`);
}

const ENTRY_GUARD_ORDER: AegisEntryGuardName[] = [
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

function finalize(input: {
    context: AegisEntryContext;
    finalDecision: AegisEntryFinalDecision;
    finalReason: string;
    deniedBy?: AegisEntryGuardName;
    allowedBy?: AegisEntryGuardName | 'entry_policy';
    guards: AegisEntryGuardResult[];
    warnings?: string[];
    adjustedLeverage: number;
    adjustedPositionFraction: number;
    momentumGuard?: AegisEntryGuardResult;
    momentumRiskProfile?: AegisMomentumRiskProfile;
    decisions: AegisEntryDecisionResult['decisions'];
}): AegisEntryDecisionResult {
    const hardSafety = momentumHardSafety(input);
    const enrichedMomentumGuard = enrichMomentumGuard(input.momentumGuard, input, hardSafety);
    const guards = input.guards.map((guard) => guard.name === 'momentum_ride' && enrichedMomentumGuard ? enrichedMomentumGuard : guard);
    const strategyCandidates: AegisEntryDecisionResult['strategyCandidates'] = {
        momentum_ride: {
            decision: enrichedMomentumGuard?.decision ?? 'NOT_APPLICABLE',
            reason: enrichedMomentumGuard?.reason ?? 'momentum_ride_not_evaluated',
            riskProfile: input.momentumRiskProfile
        },
        aegis_turbo: {
            decision: input.finalDecision,
            reason: input.finalReason
        }
    };
    const momentumCanOpen = enrichedMomentumGuard?.decision === 'ALLOW'
        && input.momentumRiskProfile !== undefined
        && !hardSafety.blocked;
    const finalDecision = momentumCanOpen ? 'ALLOW' : input.finalDecision;
    const finalReason = momentumCanOpen ? enrichedMomentumGuard!.reason : input.finalReason;
    const finalStrategy = momentumCanOpen
        ? 'momentum_ride'
        : finalDecision === 'ALLOW' ? 'aegis_turbo' : 'none';
    const riskProfile = momentumCanOpen ? input.momentumRiskProfile : undefined;
    const adjustedLeverage = momentumCanOpen ? input.momentumRiskProfile!.leverage : input.adjustedLeverage;
    const adjustedPositionFraction = momentumCanOpen ? input.momentumRiskProfile!.positionFraction : input.adjustedPositionFraction;
    const trace = buildAegisEntryDecisionTrace({
        context: input.context,
        guards,
        finalDecision,
        finalReason,
        finalStrategy,
        strategyCandidates,
        riskProfile
    });
    const allowed = finalDecision === 'ALLOW';
    return {
        finalDecision,
        finalReason,
        allowed,
        shouldOpen: allowed,
        deniedBy: momentumCanOpen ? undefined : input.deniedBy,
        allowedBy: momentumCanOpen ? 'momentum_ride' : input.allowedBy,
        finalStrategy,
        strategy: finalStrategy,
        strategyCandidates,
        riskProfile,
        guards,
        trace,
        metadata: compactAegisEntryDecisionMetadata(trace),
        warnings: input.warnings ?? [],
        adjustedLeverage,
        adjustedPositionFraction,
        decisions: input.decisions
    };
}

function canMomentumOverrideNonHard(input: {
    momentumGuard?: AegisEntryGuardResult;
    momentumRiskProfile?: AegisMomentumRiskProfile;
}): boolean {
    return input.momentumGuard?.decision === 'ALLOW' && input.momentumRiskProfile !== undefined;
}

function momentumHardSafety(input: {
    finalDecision: AegisEntryFinalDecision;
    finalReason: string;
    deniedBy?: AegisEntryGuardName;
    decisions: AegisEntryDecisionResult['decisions'];
}): { blocked: boolean; reason?: string } {
    if (input.finalDecision === 'ALLOW') return { blocked: false };
    const eventRisk = input.decisions.eventRisk;
    if (input.deniedBy === 'event_risk' && eventRisk && (eventRisk.mode === 'RISK_OFF' || eventRisk.mode === 'MANUAL_ONLY')) {
        return { blocked: true, reason: eventRisk.reason };
    }
    if (input.deniedBy === 'decision_brain' && (
        input.finalReason === 'decision_brain_do_not_enter'
        || input.finalReason === 'decision_brain_manual_only'
        || input.finalReason === 'event_risk_risk_off_denied_non_a_plus'
        || input.finalReason === 'event_risk_manual_only'
        || input.finalReason === 'entry_quality_shadow_block_hard_denied'
    )) {
        return { blocked: true, reason: input.finalReason };
    }
    if (input.finalReason.includes('tail_risk_high')) {
        return { blocked: true, reason: input.finalReason };
    }
    return { blocked: false };
}

function enrichMomentumGuard(
    guard: AegisEntryGuardResult | undefined,
    input: {
        finalDecision: AegisEntryFinalDecision;
        finalReason: string;
        decisions: AegisEntryDecisionResult['decisions'];
    },
    hardSafety: { blocked: boolean; reason?: string }
): AegisEntryGuardResult | undefined {
    if (!guard) return undefined;
    const hardSafetyPassed = !hardSafety.blocked;
    return {
        ...guard,
        decision: guard.decision === 'ALLOW' && hardSafety.blocked ? 'DENY' : guard.decision,
        reason: guard.decision === 'ALLOW' && hardSafety.blocked ? hardSafety.reason ?? 'momentum_hard_safety_block' : guard.reason,
        metadata: {
            ...guard.metadata,
            aegisEntryPolicyFinalDecision: input.finalDecision,
            aegisEntryPolicyFinalReason: input.finalReason,
            cleanEntryDecision: input.decisions.cleanEntry?.decision,
            entryQualityDecision: input.decisions.entryQuality?.action,
            eventRiskMode: input.decisions.eventRisk?.mode,
            eventRiskWouldBlock: input.decisions.eventRisk?.wouldBlock,
            regimeObserved: (guard.metadata?.momentumRide as any)?.regimeEngineV2,
            regimeIgnoredForEntry: (guard.metadata?.momentumRide as any)?.regimeIgnoredForEntry,
            momentumUsedAegisDirectionOnly: true,
            momentumDidNotRequireCleanEntry: true,
            hardSafetyPassed,
            hardSafetyReason: hardSafety.reason
        }
    };
}

function evaluateLongRiskShadowGuard(input: {
    context: AegisEntryContext;
    policy: AegisEntryPolicyRuntimeConfig;
    guards: AegisEntryGuardResult[];
}): AegisEntryGuardResult {
    return AegisLongRiskShadowGuardAdapter.evaluate({
        context: input.context,
        policy: input.policy.guards.long_risk_shadow ?? { enabled: true, mode: 'SHADOW' },
        guards: Object.fromEntries(input.guards.map((guard) => [guard.name, guard]))
    });
}

export class AegisEntryGuardOrchestrator {
    static evaluate(context: AegisEntryContext, policy: AegisEntryPolicyRuntimeConfig): AegisEntryDecisionResult {
        const guards: AegisEntryGuardResult[] = [];
        const decisions: AegisEntryDecisionResult['decisions'] = {};
        let adjustedLeverage = context.leverage;
        let adjustedPositionFraction = context.requestedPositionFraction;
        if (policy.enabled !== true) {
            for (const name of ENTRY_GUARD_ORDER) {
                guards.push(guardDisabledResult(name, 'entry_policy_disabled'));
            }
            return finalize({
                context,
                finalDecision: 'ALLOW',
                finalReason: 'entry_policy_disabled',
                allowedBy: 'entry_policy',
                guards,
                adjustedLeverage,
                adjustedPositionFraction,
                decisions
            });
        }

        const regimeContext = RegimeContextGuardAdapter.evaluate(
            context,
            policy.guards.regime_context ?? { enabled: false, mode: 'OFF' }
        );
        guards.push(regimeContext.guard);
        decisions.regimeContext = regimeContext.regimeContext;
        const contextWithRegimeContext: AegisEntryContext = {
            ...context,
            regimeContext: regimeContext.regimeContext
        };

        const momentumRide = MomentumRideGuardAdapter.evaluate(
            contextWithRegimeContext,
            policy.guards.momentum_ride ?? { enabled: false, mode: 'OFF' }
        );
        guards.push(momentumRide.guard);
        decisions.momentumRide = momentumRide.momentumRide;
        const momentumRiskProfile = momentumRide.riskProfile;
        const momentumSelection = {
            momentumGuard: momentumRide.guard,
            momentumRiskProfile
        };
        let aegisBlockedByNonHard: {
            finalDecision: AegisEntryFinalDecision;
            finalReason: string;
            deniedBy?: AegisEntryGuardName;
        } | undefined;

        const regime = RegimeGuardAdapter.evaluate(
            contextWithRegimeContext,
            policy.guards.regime ?? { enabled: false, mode: 'OFF' }
        );
        guards.push(regime.guard);
        decisions.regime = regime.decision;
        if (regime.guard.enforced && regime.guard.wouldBlock) {
            if (canMomentumOverrideNonHard(momentumSelection)) {
                aegisBlockedByNonHard = {
                    finalDecision: 'DENY',
                    finalReason: regime.decision?.reason ?? regime.guard.reason,
                    deniedBy: 'regime'
                };
            } else {
            return finalize({
                context,
                finalDecision: 'DENY',
                finalReason: regime.decision?.reason ?? regime.guard.reason,
                deniedBy: 'regime',
                guards: [
                    ...guards,
                    defaultGuard('short_gate'),
                    defaultGuard('entry_quality'),
                    defaultGuard('event_risk'),
                    defaultGuard('decision_brain'),
                    defaultGuard('clean_entry'),
                    defaultGuard('probe_mode'),
                    defaultGuard('long_risk_shadow')
                ],
                adjustedLeverage,
                adjustedPositionFraction,
                ...momentumSelection,
                decisions
            });
            }
        }

        const shortGate = ShortGateGuardAdapter.evaluate(contextWithRegimeContext, policy.guards.short_gate);
        guards.push(shortGate.guard);
        decisions.shortGate = shortGate.decision;
        adjustedLeverage = shortGate.adjustedLeverage;
        adjustedPositionFraction = shortGate.adjustedPositionFraction;
        if (shortGate.guard.enforced && shortGate.guard.wouldBlock) {
            if (canMomentumOverrideNonHard(momentumSelection)) {
                aegisBlockedByNonHard = {
                    finalDecision: 'DENY',
                    finalReason: shortGate.guard.reason,
                    deniedBy: 'short_gate'
                };
            } else {
            return finalize({
                context,
                finalDecision: 'DENY',
                finalReason: shortGate.guard.reason,
                deniedBy: 'short_gate',
                guards: [...guards, defaultGuard('entry_quality'), defaultGuard('event_risk'), defaultGuard('decision_brain'), defaultGuard('clean_entry'), defaultGuard('probe_mode'), defaultGuard('long_risk_shadow')],
                adjustedLeverage,
                adjustedPositionFraction,
                ...momentumSelection,
                decisions
            });
            }
        }

        const adjustedContext: AegisEntryContext = {
            ...contextWithRegimeContext,
            leverage: adjustedLeverage,
            requestedPositionFraction: adjustedPositionFraction
        };

        const entryQuality = EntryQualityGuardAdapter.evaluate(adjustedContext, policy.guards.entry_quality);
        guards.push(entryQuality.guard);
        decisions.entryQuality = entryQuality.decision;
        if (entryQuality.guard.enforced && entryQuality.guard.wouldBlock) {
            if (canMomentumOverrideNonHard(momentumSelection)) {
                aegisBlockedByNonHard = {
                    finalDecision: 'DENY',
                    finalReason: entryQuality.guard.reason,
                    deniedBy: 'entry_quality'
                };
            } else {
            return finalize({
                context: adjustedContext,
                finalDecision: 'DENY',
                finalReason: entryQuality.guard.reason,
                deniedBy: 'entry_quality',
                guards: [...guards, defaultGuard('event_risk'), defaultGuard('decision_brain'), defaultGuard('clean_entry'), defaultGuard('probe_mode'), defaultGuard('long_risk_shadow')],
                adjustedLeverage,
                adjustedPositionFraction,
                ...momentumSelection,
                decisions
            });
            }
        }

        const eventRisk = EventRiskGuardAdapter.evaluate(adjustedContext, policy.guards.event_risk);
        guards.push(eventRisk.guard);
        decisions.eventRisk = eventRisk.decision;
        if (eventRisk.guard.enforced && eventRisk.decision?.allowed !== true) {
            const hardEventRisk = eventRisk.decision?.mode === 'RISK_OFF' || eventRisk.decision?.mode === 'MANUAL_ONLY';
            if (canMomentumOverrideNonHard(momentumSelection) && !hardEventRisk) {
                aegisBlockedByNonHard = {
                    finalDecision: 'DENY',
                    finalReason: eventRisk.guard.reason,
                    deniedBy: 'event_risk'
                };
            } else {
            return finalize({
                context: adjustedContext,
                finalDecision: 'DENY',
                finalReason: eventRisk.guard.reason,
                deniedBy: 'event_risk',
                guards: [...guards, defaultGuard('decision_brain'), defaultGuard('clean_entry'), defaultGuard('probe_mode'), defaultGuard('long_risk_shadow')],
                adjustedLeverage,
                adjustedPositionFraction,
                ...momentumSelection,
                decisions
            });
            }
        }

        const decisionBrain = DecisionBrainGuardAdapter.evaluate(
            adjustedContext,
            policy.guards.decision_brain,
            entryQuality.guard.enforced ? entryQuality.decision : undefined,
            eventRisk.decision
        );
        guards.push(decisionBrain.guard);
        decisions.decisionEnforcement = decisionBrain.decision;
        if (decisionBrain.guard.enforced && decisionBrain.guard.wouldBlock) {
            const hardDecisionBrain = decisionBrain.guard.reason === 'decision_brain_do_not_enter'
                || decisionBrain.guard.reason === 'decision_brain_manual_only'
                || decisionBrain.guard.reason === 'event_risk_risk_off_denied_non_a_plus'
                || decisionBrain.guard.reason === 'event_risk_manual_only'
                || decisionBrain.guard.reason === 'entry_quality_shadow_block_hard_denied';
            if (canMomentumOverrideNonHard(momentumSelection) && !hardDecisionBrain) {
                aegisBlockedByNonHard = {
                    finalDecision: 'DENY',
                    finalReason: decisionBrain.guard.reason,
                    deniedBy: 'decision_brain'
                };
            } else {
            const cleanEntry = decisionBrain.decision
                ? cleanEntryOutputFromDecisionEnforcementDenied(adjustedContext, decisionBrain.decision)
                : undefined;
            decisions.cleanEntry = cleanEntry;
            const probe = ProbeModeGuardAdapter.evaluate(
                adjustedContext,
                policy.guards.probe_mode,
                decisionBrain.decision,
                cleanEntry
            );
            decisions.probeMode = probe.decision;
            return finalize({
                context: adjustedContext,
                finalDecision: 'DENY',
                finalReason: decisionBrain.guard.reason,
                deniedBy: 'decision_brain',
                guards: [...guards, defaultGuard('clean_entry'), probe.guard, defaultGuard('long_risk_shadow')],
                adjustedLeverage,
                adjustedPositionFraction,
                ...momentumSelection,
                decisions
            });
            }
        }

        const cleanEntry = CleanEntryGuardAdapter.evaluate(
            adjustedContext,
            policy.guards.clean_entry,
            decisionBrain.decision,
            entryQuality.decision,
            eventRisk.decision
        );
        guards.push(cleanEntry.guard);
        decisions.cleanEntry = cleanEntry.decision;
        if (cleanEntry.guard.enforced && cleanEntry.guard.wouldBlock) {
            const probe = ProbeModeGuardAdapter.evaluate(
                adjustedContext,
                policy.guards.probe_mode,
                decisionBrain.decision,
                cleanEntry.decision
            );
            guards.push(probe.guard);
            decisions.probeMode = probe.decision;
            if (probe.decision?.allowed === true && probe.guard.enforced) {
                const longRiskShadow = evaluateLongRiskShadowGuard({ context: adjustedContext, policy, guards });
                guards.push(longRiskShadow);
                return finalize({
                    context: adjustedContext,
                    finalDecision: 'ALLOW',
                    finalReason: 'probe_mode_allowed',
                    allowedBy: 'probe_mode',
                    guards,
                    adjustedLeverage,
                    adjustedPositionFraction,
                    ...momentumSelection,
                    decisions
                });
            }
            const probeEnforced = probe.guard.enforced && probe.guard.enabled;
            const finalDecision: AegisEntryFinalDecision = probeEnforced ? 'WAIT_CONFIRMATION' : 'WAIT_CONFIRMATION';
            const finalReason = probeEnforced ? probe.guard.reason : cleanEntry.guard.reason;
            const longRiskShadow = evaluateLongRiskShadowGuard({ context: adjustedContext, policy, guards });
            guards.push(longRiskShadow);
            return finalize({
                context: adjustedContext,
                finalDecision,
                finalReason,
                deniedBy: probeEnforced ? 'probe_mode' : 'clean_entry',
                guards,
                adjustedLeverage,
                adjustedPositionFraction,
                ...momentumSelection,
                decisions
            });
        }

        guards.push(defaultGuard('probe_mode'));
        const longRiskShadow = evaluateLongRiskShadowGuard({ context: adjustedContext, policy, guards });
        guards.push(longRiskShadow);
        return finalize({
            context: adjustedContext,
            finalDecision: aegisBlockedByNonHard?.finalDecision ?? 'ALLOW',
            finalReason: aegisBlockedByNonHard?.finalReason ?? 'all_enforced_guards_allowed',
            deniedBy: aegisBlockedByNonHard?.deniedBy,
            allowedBy: aegisBlockedByNonHard ? undefined : 'entry_policy',
            guards,
            adjustedLeverage,
            adjustedPositionFraction,
            ...momentumSelection,
            decisions
        });
    }
}
