import {
  AegisEntryContext,
  AegisEntryDecisionResult,
  AegisEntryFinalDecision,
  AegisEntryGuardName,
  AegisEntryGuardResult,
  AegisEntryPolicyRuntimeConfig,
  guardDisabledResult,
} from './AegisEntryDecisionTypes';
import {
  buildAegisEntryDecisionTrace,
  compactAegisEntryDecisionMetadata,
} from './AegisEntryDecisionTrace';
import { ShortGateGuardAdapter } from './guards/ShortGateGuardAdapter';
import { RegimeGuardAdapter } from './guards/RegimeGuardAdapter';
import { RegimeContextGuardAdapter } from './guards/RegimeContextGuardAdapter';
import { EntryQualityGuardAdapter } from './guards/EntryQualityGuardAdapter';
import { EventRiskGuardAdapter } from './guards/EventRiskGuardAdapter';
import { DecisionBrainGuardAdapter } from './guards/DecisionBrainGuardAdapter';
import {
  CleanEntryGuardAdapter,
  cleanEntryOutputFromDecisionEnforcementDenied,
} from './guards/CleanEntryGuardAdapter';
import { ProbeModeGuardAdapter } from './guards/ProbeModeGuardAdapter';
import { AegisLongRiskShadowGuardAdapter } from './guards/AegisLongRiskShadowGuardAdapter';
import { E4TailRiskGuardAdapter } from './guards/E4TailRiskGuardAdapter';

function defaultGuard(name: AegisEntryGuardName): AegisEntryGuardResult {
  return guardDisabledResult(name, `${name}_not_evaluated`);
}

const ENTRY_GUARD_ORDER: AegisEntryGuardName[] = [
  'regime_context',
  'regime',
  'short_gate',
  'entry_quality',
  'event_risk',
  'decision_brain',
  'clean_entry',
  'probe_mode',
  'long_risk_shadow',
  'e4_tail_risk',
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
  decisions: AegisEntryDecisionResult['decisions'];
}): AegisEntryDecisionResult {
  const strategyCandidates: AegisEntryDecisionResult['strategyCandidates'] = {
    aegis_turbo: {
      decision: input.finalDecision,
      reason: input.finalReason,
    },
  };
  const finalStrategy = input.finalDecision === 'ALLOW' ? 'aegis_turbo' : 'none';
  const trace = buildAegisEntryDecisionTrace({
    context: input.context,
    guards: input.guards,
    finalDecision: input.finalDecision,
    finalReason: input.finalReason,
    finalStrategy,
    strategyCandidates,
  });
  const allowed = input.finalDecision === 'ALLOW';
  return {
    finalDecision: input.finalDecision,
    finalReason: input.finalReason,
    allowed,
    shouldOpen: allowed,
    deniedBy: input.deniedBy,
    allowedBy: input.allowedBy,
    finalStrategy,
    strategy: finalStrategy,
    strategyCandidates,
    guards: input.guards,
    trace,
    metadata: compactAegisEntryDecisionMetadata(trace),
    warnings: input.warnings ?? [],
    adjustedLeverage: input.adjustedLeverage,
    adjustedPositionFraction: input.adjustedPositionFraction,
    decisions: input.decisions,
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
    guards: Object.fromEntries(input.guards.map((guard) => [guard.name, guard])),
  });
}

function shouldBlockProbeLongCritical(input: {
  context: AegisEntryContext;
  policy: AegisEntryPolicyRuntimeConfig;
  probeGuard: AegisEntryGuardResult;
  longRiskShadow: AegisEntryGuardResult;
}): boolean {
  const policy = input.policy.guards.long_risk_shadow;
  const assessment = (input.longRiskShadow.metadata.longRiskShadow ?? {}) as Record<
    string,
    unknown
  >;
  return (
    policy?.enabled === true &&
    policy.mode === 'ENFORCE_PROBE_LONG_CRITICAL' &&
    policy.probeLongCriticalAction !== 'SHADOW' &&
    policy.blockOnlyProbeMode !== false &&
    policy.blockOnlyLong !== false &&
    input.context.side === 'LONG' &&
    input.probeGuard.enforced === true &&
    input.probeGuard.decision === 'ALLOW' &&
    assessment.riskLevel === 'CRITICAL' &&
    assessment.suggestedAction === 'WOULD_BLOCK_SHADOW'
  );
}

function enforceProbeLongCriticalBlock(guard: AegisEntryGuardResult): AegisEntryGuardResult {
  const assessment = (guard.metadata.longRiskShadow ?? {}) as Record<string, unknown>;
  const enforcedAssessment = {
    ...assessment,
    enforced: true,
    enforcementApplied: true,
    enforcementScope: 'probe_long_critical',
    blockedProbeLong: true,
    actionTaken: 'BLOCK',
  };
  return {
    ...guard,
    decision: 'DENY',
    reason: 'long_risk_probe_long_critical',
    wouldBlock: true,
    enforced: true,
    metadata: {
      ...guard.metadata,
      longRiskShadow: enforcedAssessment,
      enforcementApplied: true,
      enforcementScope: 'probe_long_critical',
      blockedProbeLong: true,
      actionTaken: 'BLOCK',
    },
  };
}

export class AegisEntryGuardOrchestrator {
  static async evaluate(
    context: AegisEntryContext,
    policy: AegisEntryPolicyRuntimeConfig,
  ): Promise<AegisEntryDecisionResult> {
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
        decisions,
      });
    }

    const regimeContext = RegimeContextGuardAdapter.evaluate(
      context,
      policy.guards.regime_context ?? { enabled: false, mode: 'OFF' },
    );
    guards.push(regimeContext.guard);
    decisions.regimeContext = regimeContext.regimeContext;
    const contextWithRegimeContext: AegisEntryContext = {
      ...context,
      regimeContext: regimeContext.regimeContext,
    };

    const regime = RegimeGuardAdapter.evaluate(
      contextWithRegimeContext,
      policy.guards.regime ?? { enabled: false, mode: 'OFF' },
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
          defaultGuard('probe_mode'),
          defaultGuard('long_risk_shadow'),
          defaultGuard('e4_tail_risk'),
        ],
        adjustedLeverage,
        adjustedPositionFraction,
        decisions,
      });
    }

    const shortGate = ShortGateGuardAdapter.evaluate(
      contextWithRegimeContext,
      policy.guards.short_gate,
    );
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
        guards: [
          ...guards,
          defaultGuard('entry_quality'),
          defaultGuard('event_risk'),
          defaultGuard('decision_brain'),
          defaultGuard('clean_entry'),
          defaultGuard('probe_mode'),
          defaultGuard('long_risk_shadow'),
          defaultGuard('e4_tail_risk'),
        ],
        adjustedLeverage,
        adjustedPositionFraction,
        decisions,
      });
    }

    const adjustedContext: AegisEntryContext = {
      ...contextWithRegimeContext,
      leverage: adjustedLeverage,
      requestedPositionFraction: adjustedPositionFraction,
    };

    const entryQuality = EntryQualityGuardAdapter.evaluate(
      adjustedContext,
      policy.guards.entry_quality,
    );
    guards.push(entryQuality.guard);
    decisions.entryQuality = entryQuality.decision;
    if (entryQuality.guard.enforced && entryQuality.guard.wouldBlock) {
      return finalize({
        context: adjustedContext,
        finalDecision: 'DENY',
        finalReason: entryQuality.guard.reason,
        deniedBy: 'entry_quality',
        guards: [
          ...guards,
          defaultGuard('event_risk'),
          defaultGuard('decision_brain'),
          defaultGuard('clean_entry'),
          defaultGuard('probe_mode'),
          defaultGuard('long_risk_shadow'),
          defaultGuard('e4_tail_risk'),
        ],
        adjustedLeverage,
        adjustedPositionFraction,
        decisions,
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
        guards: [
          ...guards,
          defaultGuard('decision_brain'),
          defaultGuard('clean_entry'),
          defaultGuard('probe_mode'),
          defaultGuard('long_risk_shadow'),
          defaultGuard('e4_tail_risk'),
        ],
        adjustedLeverage,
        adjustedPositionFraction,
        decisions,
      });
    }

    const decisionBrain = DecisionBrainGuardAdapter.evaluate(
      adjustedContext,
      policy.guards.decision_brain,
      entryQuality.guard.enforced ? entryQuality.decision : undefined,
      eventRisk.decision,
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
        cleanEntry,
      );
      decisions.probeMode = probe.decision;
      return finalize({
        context: adjustedContext,
        finalDecision: 'DENY',
        finalReason: decisionBrain.guard.reason,
        deniedBy: 'decision_brain',
        guards: [
          ...guards,
          defaultGuard('clean_entry'),
          probe.guard,
          defaultGuard('long_risk_shadow'),
          defaultGuard('e4_tail_risk'),
        ],
        adjustedLeverage,
        adjustedPositionFraction,
        decisions,
      });
    }

    const cleanEntry = CleanEntryGuardAdapter.evaluate(
      adjustedContext,
      policy.guards.clean_entry,
      decisionBrain.decision,
      entryQuality.decision,
      eventRisk.decision,
    );
    guards.push(cleanEntry.guard);
    decisions.cleanEntry = cleanEntry.decision;
    if (cleanEntry.guard.enforced && cleanEntry.guard.wouldBlock) {
      const probe = ProbeModeGuardAdapter.evaluate(
        adjustedContext,
        policy.guards.probe_mode,
        decisionBrain.decision,
        cleanEntry.decision,
      );
      guards.push(probe.guard);
      decisions.probeMode = probe.decision;
      if (probe.decision?.allowed === true && probe.guard.enforced) {
        const longRiskShadow = evaluateLongRiskShadowGuard({
          context: adjustedContext,
          policy,
          guards,
        });
        const enforcedLongRiskShadow = shouldBlockProbeLongCritical({
          context: adjustedContext,
          policy,
          probeGuard: probe.guard,
          longRiskShadow,
        })
          ? enforceProbeLongCriticalBlock(longRiskShadow)
          : longRiskShadow;
        guards.push(enforcedLongRiskShadow);
        if (
          enforcedLongRiskShadow.enforced &&
          enforcedLongRiskShadow.reason === 'long_risk_probe_long_critical'
        ) {
          return finalize({
            context: adjustedContext,
            finalDecision: 'DENY',
            finalReason: 'long_risk_probe_long_critical',
            deniedBy: 'long_risk_shadow',
            guards: [...guards, defaultGuard('e4_tail_risk')],
            adjustedLeverage,
            adjustedPositionFraction,
            decisions,
          });
        }

        // Defect #13: ProbeMode ALLOW must pass through E4
        const e4TailRisk = await E4TailRiskGuardAdapter.evaluate(
          adjustedContext,
          policy.guards.e4_tail_risk ?? { enabled: false, mode: 'OFF' },
        );
        guards.push(e4TailRisk.guard);
        decisions.e4TailRisk = {
          available: e4TailRisk.e4Response.available,
          score: e4TailRisk.e4Response.score,
          threshold: e4TailRisk.e4Response.threshold,
          decision: e4TailRisk.e4Response.decision,
          reason: e4TailRisk.e4Response.reason,
          modelVersion: e4TailRisk.e4Response.model_version,
          featureHash: e4TailRisk.e4Response.feature_snapshot_hash,
        };

        if (e4TailRisk.guard.enforced && e4TailRisk.guard.wouldBlock) {
          return finalize({
            context: adjustedContext,
            finalDecision: 'DENY',
            finalReason: e4TailRisk.guard.reason,
            deniedBy: 'e4_tail_risk',
            guards,
            adjustedLeverage,
            adjustedPositionFraction,
            decisions,
          });
        }

        return finalize({
          context: adjustedContext,
          finalDecision: 'ALLOW',
          finalReason: 'probe_mode_allowed',
          allowedBy: 'probe_mode',
          guards,
          adjustedLeverage,
          adjustedPositionFraction,
          decisions,
        });
      }
      const probeEnforced = probe.guard.enforced && probe.guard.enabled;
      const finalDecision: AegisEntryFinalDecision = probeEnforced
        ? 'WAIT_CONFIRMATION'
        : 'WAIT_CONFIRMATION';
      const finalReason = probeEnforced ? probe.guard.reason : cleanEntry.guard.reason;
      const longRiskShadow = evaluateLongRiskShadowGuard({
        context: adjustedContext,
        policy,
        guards,
      });
      guards.push(longRiskShadow);
      return finalize({
        context: adjustedContext,
        finalDecision,
        finalReason,
        deniedBy: probeEnforced ? 'probe_mode' : 'clean_entry',
        guards: [...guards, defaultGuard('e4_tail_risk')],
        adjustedLeverage,
        adjustedPositionFraction,
        decisions,
      });
    }

    if (cleanEntry.guard.wouldBlock && !cleanEntry.guard.enforced) {
      const probe = ProbeModeGuardAdapter.evaluate(
        adjustedContext,
        policy.guards.probe_mode,
        decisionBrain.decision,
        cleanEntry.decision,
      );
      guards.push(probe.guard);
      decisions.probeMode = probe.decision;
    } else {
      guards.push(defaultGuard('probe_mode'));
    }
    const longRiskShadow = evaluateLongRiskShadowGuard({
      context: adjustedContext,
      policy,
      guards,
    });
    guards.push(longRiskShadow);

    const e4TailRisk = await E4TailRiskGuardAdapter.evaluate(
      adjustedContext,
      policy.guards.e4_tail_risk ?? { enabled: false, mode: 'OFF' },
    );
    guards.push(e4TailRisk.guard);
    decisions.e4TailRisk = {
      available: e4TailRisk.e4Response.available,
      score: e4TailRisk.e4Response.score,
      threshold: e4TailRisk.e4Response.threshold,
      decision: e4TailRisk.e4Response.decision,
      reason: e4TailRisk.e4Response.reason,
      modelVersion: e4TailRisk.e4Response.model_version,
      featureHash: e4TailRisk.e4Response.feature_snapshot_hash,
    };

    if (e4TailRisk.guard.enforced && e4TailRisk.guard.wouldBlock) {
      return finalize({
        context: adjustedContext,
        finalDecision: 'DENY',
        finalReason: e4TailRisk.guard.reason,
        deniedBy: 'e4_tail_risk',
        guards,
        adjustedLeverage,
        adjustedPositionFraction,
        decisions,
      });
    }

    return finalize({
      context: adjustedContext,
      finalDecision: 'ALLOW',
      finalReason: 'all_enforced_guards_allowed',
      allowedBy: 'entry_policy',
      guards,
      adjustedLeverage,
      adjustedPositionFraction,
      decisions,
    });
  }
}
