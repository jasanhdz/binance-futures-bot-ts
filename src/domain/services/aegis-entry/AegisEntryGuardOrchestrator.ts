import {
    AegisEntryContext,
    AegisEntryDecisionResult,
    AegisEntryFinalDecision,
    AegisEntryGuardName,
    AegisEntryGuardResult,
    AegisEntryPolicyRuntimeConfig,
    guardDisabledResult
} from './AegisEntryDecisionTypes';
import {
    buildAegisEntryDecisionTrace,
    compactAegisEntryDecisionMetadata
} from './AegisEntryDecisionTrace';
import { ShortGateGuardAdapter } from './guards/ShortGateGuardAdapter';
import { EntryQualityGuardAdapter } from './guards/EntryQualityGuardAdapter';
import { EventRiskGuardAdapter } from './guards/EventRiskGuardAdapter';
import { DecisionBrainGuardAdapter } from './guards/DecisionBrainGuardAdapter';
import {
    CleanEntryGuardAdapter,
    cleanEntryOutputFromDecisionEnforcementDenied
} from './guards/CleanEntryGuardAdapter';
import { ProbeModeGuardAdapter } from './guards/ProbeModeGuardAdapter';

function defaultGuard(name: AegisEntryGuardName): AegisEntryGuardResult {
    return guardDisabledResult(name, `${name}_not_evaluated`);
}

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
    decisions: AegisEntryDecisionResult['decisions'];
}): AegisEntryDecisionResult {
    const trace = buildAegisEntryDecisionTrace({
        context: input.context,
        guards: input.guards,
        finalDecision: input.finalDecision,
        finalReason: input.finalReason
    });
    const allowed = input.finalDecision === 'ALLOW';
    return {
        finalDecision: input.finalDecision,
        finalReason: input.finalReason,
        allowed,
        shouldOpen: allowed,
        deniedBy: input.deniedBy,
        allowedBy: input.allowedBy,
        guards: input.guards,
        trace,
        metadata: compactAegisEntryDecisionMetadata(trace),
        warnings: input.warnings ?? [],
        adjustedLeverage: input.adjustedLeverage,
        adjustedPositionFraction: input.adjustedPositionFraction,
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
            for (const name of ['short_gate', 'entry_quality', 'event_risk', 'decision_brain', 'clean_entry', 'probe_mode'] as AegisEntryGuardName[]) {
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

        const shortGate = ShortGateGuardAdapter.evaluate(context, policy.guards.short_gate);
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
                decisions
            });
        }

        const adjustedContext: AegisEntryContext = {
            ...context,
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
            decisions
        });
    }
}
