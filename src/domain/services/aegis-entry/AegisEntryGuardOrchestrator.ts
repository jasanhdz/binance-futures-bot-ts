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
    'probe_mode'
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
    const strategyCandidates: AegisEntryDecisionResult['strategyCandidates'] = {
        momentum_ride: {
            decision: input.momentumGuard?.decision ?? 'NOT_APPLICABLE',
            reason: input.momentumGuard?.reason ?? 'momentum_ride_not_evaluated',
            riskProfile: input.momentumRiskProfile
        },
        aegis_turbo: {
            decision: input.finalDecision,
            reason: input.finalReason
        }
    };
    const momentumCanOpen = input.momentumGuard?.decision === 'ALLOW'
        && input.momentumRiskProfile !== undefined
        && input.finalDecision === 'ALLOW';
    const finalDecision = momentumCanOpen ? 'ALLOW' : input.finalDecision;
    const finalReason = momentumCanOpen ? input.momentumGuard!.reason : input.finalReason;
    const finalStrategy = momentumCanOpen
        ? 'momentum_ride'
        : finalDecision === 'ALLOW' ? 'aegis_turbo' : 'none';
    const riskProfile = momentumCanOpen ? input.momentumRiskProfile : undefined;
    const adjustedLeverage = momentumCanOpen ? input.momentumRiskProfile!.leverage : input.adjustedLeverage;
    const adjustedPositionFraction = momentumCanOpen ? input.momentumRiskProfile!.positionFraction : input.adjustedPositionFraction;
    const trace = buildAegisEntryDecisionTrace({
        context: input.context,
        guards: input.guards,
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
        guards: input.guards,
        trace,
        metadata: compactAegisEntryDecisionMetadata(trace),
        warnings: input.warnings ?? [],
        adjustedLeverage,
        adjustedPositionFraction,
        decisions: input.decisions
    };
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

        const regime = RegimeGuardAdapter.evaluate(
            contextWithRegimeContext,
            policy.guards.regime ?? { enabled: false, mode: 'OFF' }
        );
        guards.push(regime.guard);
        decisions.regime = regime.decision;
        if (regime.guard.enforced && regime.guard.wouldBlock) {
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
                    defaultGuard('probe_mode')
                ],
                adjustedLeverage,
                adjustedPositionFraction,
                ...momentumSelection,
                decisions
            });
        }

        const shortGate = ShortGateGuardAdapter.evaluate(contextWithRegimeContext, policy.guards.short_gate);
        guards.push(shortGate.guard);
        decisions.shortGate = shortGate.decision;
        adjustedLeverage = shortGate.adjustedLeverage;
        adjustedPositionFraction = shortGate.adjustedPositionFraction;
        if (shortGate.guard.enforced && shortGate.guard.wouldBlock) {
            return finalize({
                context,
                finalDecision: 'DENY',
                finalReason: shortGate.guard.reason,
                deniedBy: 'short_gate',
                guards: [...guards, defaultGuard('entry_quality'), defaultGuard('event_risk'), defaultGuard('decision_brain'), defaultGuard('clean_entry'), defaultGuard('probe_mode')],
                adjustedLeverage,
                adjustedPositionFraction,
                ...momentumSelection,
                decisions
            });
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
            return finalize({
                context: adjustedContext,
                finalDecision: 'DENY',
                finalReason: entryQuality.guard.reason,
                deniedBy: 'entry_quality',
                guards: [...guards, defaultGuard('event_risk'), defaultGuard('decision_brain'), defaultGuard('clean_entry'), defaultGuard('probe_mode')],
                adjustedLeverage,
                adjustedPositionFraction,
                ...momentumSelection,
                decisions
            });
        }

        const eventRisk = EventRiskGuardAdapter.evaluate(adjustedContext, policy.guards.event_risk);
        guards.push(eventRisk.guard);
        decisions.eventRisk = eventRisk.decision;
        if (eventRisk.guard.enforced && eventRisk.decision?.allowed !== true) {
            return finalize({
                context: adjustedContext,
                finalDecision: 'DENY',
                finalReason: eventRisk.guard.reason,
                deniedBy: 'event_risk',
                guards: [...guards, defaultGuard('decision_brain'), defaultGuard('clean_entry'), defaultGuard('probe_mode')],
                adjustedLeverage,
                adjustedPositionFraction,
                ...momentumSelection,
                decisions
            });
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
                guards: [...guards, defaultGuard('clean_entry'), probe.guard],
                adjustedLeverage,
                adjustedPositionFraction,
                ...momentumSelection,
                decisions
            });
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
            return finalize({
                context: adjustedContext,
                finalDecision: 'WAIT_CONFIRMATION',
                finalReason: probeEnforced ? probe.guard.reason : cleanEntry.guard.reason,
                deniedBy: probeEnforced ? 'probe_mode' : 'clean_entry',
                guards,
                adjustedLeverage,
                adjustedPositionFraction,
                ...momentumSelection,
                decisions
            });
        }

        guards.push(defaultGuard('probe_mode'));
        return finalize({
            context: adjustedContext,
            finalDecision: 'ALLOW',
            finalReason: 'all_enforced_guards_allowed',
            allowedBy: 'entry_policy',
            guards,
            adjustedLeverage,
            adjustedPositionFraction,
            ...momentumSelection,
            decisions
        });
    }
}
