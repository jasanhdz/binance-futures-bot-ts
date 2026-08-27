import {
  AegisEntryContext,
  AegisEntryGuardPolicy,
  AegisEntryGuardResult,
  guardDisabledResult,
  isGuardEnforced,
} from '../AegisEntryDecisionTypes';
import { AegisCleanEntryGuardOutput } from '../../AegisCleanEntryGuard';
import { AegisDecisionEnforcementDecision } from '../../AegisDecisionEnforcement';
import { AegisProbeMode, AegisProbeModeDecision } from '../../AegisProbeMode';

export interface ProbeModeGuardAdapterResult {
  guard: AegisEntryGuardResult;
  decision?: AegisProbeModeDecision;
}

export class ProbeModeGuardAdapter {
  static evaluate(
    context: AegisEntryContext,
    policy: AegisEntryGuardPolicy,
    decisionEnforcement?: AegisDecisionEnforcementDecision,
    cleanEntryGuard?: AegisCleanEntryGuardOutput,
  ): ProbeModeGuardAdapterResult {
    if (policy.enabled !== true || policy.mode === 'OFF') {
      return { guard: guardDisabledResult('probe_mode') };
    }
    if (!decisionEnforcement || !cleanEntryGuard) {
      return { guard: guardDisabledResult('probe_mode', 'probe_mode_not_applicable') };
    }

    const shadow = policy.mode === 'SHADOW';
    const candidateDecision = AegisProbeMode.evaluate({
      config: {
        ...context.probe!.config,
        // Probe's domain evaluator historically treats SHADOW as
        // disabled. Evaluate its unchanged criteria as a counterfactual
        // while the adapter keeps the result non-enforcing.
        mode: shadow ? 'ENFORCE' : context.probe!.config.mode,
      },
      nowMs: context.operational.timestamp,
      symbol: context.symbol,
      side: context.side,
      turboScore: context.turboScore,
      votes: context.votes,
      setupGrade: decisionEnforcement.metadata.setupGrade,
      decisionBrain: decisionEnforcement.metadata.decisionBrainDecision,
      entryQualityRecommendation:
        decisionEnforcement.metadata.entryQualityModelRecommendation ??
        decisionEnforcement.metadata.entryQualityRecommendation,
      entryQualityGateAction: decisionEnforcement.metadata.entryQualityRuleGateDecision,
      featureStatus: decisionEnforcement.metadata.entryQualityModelFeatureStatus,
      featureParityPct: decisionEnforcement.metadata.entryQualityModelFeatureParityPct,
      tailRiskScore: decisionEnforcement.metadata.tailRiskScore,
      eventRiskMode: decisionEnforcement.metadata.eventRiskMode,
      eventRiskReason: decisionEnforcement.metadata.eventRiskReason,
      eventRiskWouldBlock: decisionEnforcement.metadata.eventRiskWouldBlock,
      cleanEntryReasons: cleanEntryGuard.reasons,
      lastProbeAt: context.operational.lastProbeAt,
      probeEntryTimestamps: context.operational.probeEntryTimestamps,
      openProbePositions: context.operational.openProbePositions,
      totalOpenPositions: context.operational.openPositionsCount,
      sameSymbolOpen: context.operational.sameSymbolPositionExists,
      consecutiveLosses: context.operational.consecutiveLosses,
      lastStopLossAt: context.operational.lastStopLossAt,
    });
    const enforced = isGuardEnforced(policy);
    const wouldBlock = candidateDecision.allowed !== true;
    const decision: AegisProbeModeDecision = shadow
      ? {
          ...candidateDecision,
          allowed: false,
          metadata: {
            ...candidateDecision.metadata,
            allowed: false,
            mode: 'SHADOW',
            wouldAllow: candidateDecision.allowed,
            counterfactualReason: candidateDecision.reason,
          },
        }
      : candidateDecision;
    const guard: AegisEntryGuardResult = {
      name: 'probe_mode',
      enabled: true,
      mode: policy.mode,
      decision: candidateDecision.allowed
        ? enforced
          ? 'ALLOW'
          : 'SHADOW_ALLOW'
        : enforced
          ? 'DENY'
          : 'SHADOW_DENY',
      reason: candidateDecision.reason,
      wouldBlock,
      enforced,
      metadata: decision.metadata as unknown as Record<string, unknown>,
    };

    return { guard, decision };
  }
}
