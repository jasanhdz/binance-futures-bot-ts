import {
    AegisEntryContext,
    AegisEntryGuardPolicy,
    AegisEntryGuardResult,
    guardDisabledResult,
    isGuardEnforced
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
        cleanEntryGuard?: AegisCleanEntryGuardOutput
    ): ProbeModeGuardAdapterResult {
        if (policy.enabled !== true || policy.mode === 'OFF') {
            return { guard: guardDisabledResult('probe_mode') };
        }
        if (!decisionEnforcement || !cleanEntryGuard) {
            return { guard: guardDisabledResult('probe_mode', 'probe_mode_not_applicable') };
        }

        const decision = AegisProbeMode.evaluate({
            config: {
                ...context.probe!.config,
                mode: policy.mode === 'SHADOW' ? 'SHADOW' : context.probe!.config.mode
            },
            nowMs: context.operational.timestamp,
            symbol: context.symbol,
            side: context.side,
            turboScore: context.turboScore,
            votes: context.votes,
            setupGrade: decisionEnforcement.metadata.setupGrade,
            decisionBrain: decisionEnforcement.metadata.decisionBrainDecision,
            entryQualityRecommendation: decisionEnforcement.metadata.entryQualityModelRecommendation
                ?? decisionEnforcement.metadata.entryQualityRecommendation,
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
            lastStopLossAt: context.operational.lastStopLossAt
        });
        const enforced = isGuardEnforced(policy);
        const wouldBlock = decision.allowed !== true;
        const guard: AegisEntryGuardResult = {
            name: 'probe_mode',
            enabled: true,
            mode: policy.mode,
            decision: decision.allowed ? 'ALLOW' : (enforced ? 'DENY' : 'SHADOW_DENY'),
            reason: decision.reason,
            wouldBlock,
            enforced,
            metadata: decision.metadata as unknown as Record<string, unknown>
        };

        return { guard, decision };
    }
}
