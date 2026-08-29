import {
  AegisEntryContext,
  AegisEntryGuardPolicy,
  AegisEntryGuardResult,
  guardDisabledResult,
  isGuardEnforced,
} from '../AegisEntryDecisionTypes';
import { AegisDecisionEnforcementDecision } from '../../services/AegisDecisionEnforcement';
import {
  AegisCleanEntryGuardOutput,
  evaluateAegisCleanEntryGuard,
} from '../../services/AegisCleanEntryGuard';
import { AegisEntryQualityGateDecision } from '../../services/AegisEntryQualityGate';
import { AegisEventRiskOverlayDecision } from '../../services/AegisEventRiskOverlay';

function recommendationFromEntryQualityGateAction(action?: string): string | undefined {
  if (action === 'ALLOW' || action === 'SHADOW_ALLOW') return 'ALLOW_SHADOW';
  if (action === 'BLOCK' || action === 'SHADOW_BLOCK') return 'BLOCK_SHADOW';
  return undefined;
}

export function cleanEntryOutputFromDecisionEnforcementDenied(
  context: AegisEntryContext,
  decisionEnforcement: AegisDecisionEnforcementDecision,
): AegisCleanEntryGuardOutput {
  const config = context.cleanEntry?.config;
  const mode = config?.mode === 'ENFORCE' ? 'ENFORCE' : 'SHADOW';
  const reasons = [decisionEnforcement.reason];
  const metadata: AegisCleanEntryGuardOutput['metadata'] = {
    enabled: config?.enabled === true,
    mode,
    decision: mode === 'ENFORCE' ? 'WAIT_CONFIRMATION' : 'SHADOW_WAIT_CONFIRMATION',
    allowed: false,
    wouldBlock: true,
    clean: false,
    dirty: true,
    reasons,
    symbol: context.symbol,
    side: context.side,
    turboScore: context.turboScore,
    votes: context.votes,
    setupGrade: decisionEnforcement.metadata.setupGrade,
    decisionBrain: decisionEnforcement.metadata.decisionBrainDecision,
    entryQualityRecommendation:
      decisionEnforcement.metadata.entryQualityModelRecommendation ??
      decisionEnforcement.metadata.entryQualityRecommendation,
    entryQualityGateReason:
      decisionEnforcement.metadata.entryQualityRuleGateReason ??
      decisionEnforcement.metadata.entryQualityGateReason,
    entryQualityGateAction:
      decisionEnforcement.metadata.entryQualityRuleGateDecision ??
      decisionEnforcement.metadata.entryQualityGateAction,
    entryQualityModelPresent:
      decisionEnforcement.metadata.entryQualityModelRecommendation !== undefined,
    entryQualityModelRecommendation: decisionEnforcement.metadata.entryQualityModelRecommendation,
    entryQualityModelScore: decisionEnforcement.metadata.entryQualityModelScore,
    entryQualityModelFeatureStatus: decisionEnforcement.metadata.entryQualityModelFeatureStatus,
    entryQualityModelFeatureParityPct:
      decisionEnforcement.metadata.entryQualityModelFeatureParityPct,
    entryQualityModelMissingFeaturesCount:
      decisionEnforcement.metadata.entryQualityModelMissingFeaturesCount,
    entryQualityModelScope: decisionEnforcement.metadata.entryQualityModelScope,
    entryQualityModelVersion: decisionEnforcement.metadata.entryQualityModelVersion,
    featureStatus: decisionEnforcement.metadata.entryQualityModelFeatureStatus,
    featureParityPct: decisionEnforcement.metadata.entryQualityModelFeatureParityPct,
    missingFeaturesCount: decisionEnforcement.metadata.entryQualityModelMissingFeaturesCount,
    modelScope: decisionEnforcement.metadata.entryQualityModelScope,
    modelVersion: decisionEnforcement.metadata.entryQualityModelVersion,
    entryQualityRuleGateReason: decisionEnforcement.metadata.entryQualityRuleGateReason,
    entryQualityRuleGateDecision: decisionEnforcement.metadata.entryQualityRuleGateDecision,
    entryQualityScore: decisionEnforcement.metadata.entryQualityScore,
    tailRiskScore: decisionEnforcement.metadata.tailRiskScore,
    eventRiskMode: decisionEnforcement.metadata.eventRiskMode,
    eventRiskWouldBlock: decisionEnforcement.metadata.eventRiskWouldBlock,
    eventRiskReason: decisionEnforcement.metadata.eventRiskReason,
  };

  return {
    decision: metadata.decision,
    allowed: false,
    wouldBlock: true,
    reasons,
    clean: false,
    dirty: true,
    mode,
    metadata,
  };
}

export interface CleanEntryGuardAdapterResult {
  guard: AegisEntryGuardResult;
  decision?: AegisCleanEntryGuardOutput;
}

export class CleanEntryGuardAdapter {
  static evaluate(
    context: AegisEntryContext,
    policy: AegisEntryGuardPolicy,
    decisionEnforcement?: AegisDecisionEnforcementDecision,
    entryQualityDecision?: AegisEntryQualityGateDecision,
    eventRiskDecision?: AegisEventRiskOverlayDecision,
  ): CleanEntryGuardAdapterResult {
    if (policy.enabled !== true || policy.mode === 'OFF') {
      return { guard: guardDisabledResult('clean_entry') };
    }
    if (!decisionEnforcement) {
      return {
        guard: guardDisabledResult('clean_entry', 'clean_entry_missing_decision_enforcement'),
      };
    }

    const config = context.cleanEntry!.config;
    const decision = evaluateAegisCleanEntryGuard({
      ...config,
      mode: policy.mode === 'SHADOW' ? 'SHADOW' : config?.mode,
      symbol: context.symbol,
      side: context.side,
      turboScore: context.turboScore,
      votes: context.votes,
      setupGrade: decisionEnforcement.metadata.setupGrade,
      decisionBrain: decisionEnforcement.metadata.decisionBrainDecision,
      entryQualityRecommendation:
        decisionEnforcement.metadata.entryQualityModelRecommendation ??
        decisionEnforcement.metadata.entryQualityRecommendation ??
        recommendationFromEntryQualityGateAction(entryQualityDecision?.action),
      entryQualityGateAction:
        decisionEnforcement.metadata.entryQualityRuleGateDecision ?? entryQualityDecision?.action,
      entryQualityGateReason:
        decisionEnforcement.metadata.entryQualityRuleGateReason ?? entryQualityDecision?.reason,
      entryQualityModelPresent: context.entryQuality.model !== undefined,
      entryQualityModelRecommendation:
        decisionEnforcement.metadata.entryQualityModelRecommendation ??
        context.entryQuality.model?.recommendation,
      entryQualityModelScore:
        decisionEnforcement.metadata.entryQualityModelScore ??
        context.entryQuality.model?.entry_quality_score,
      entryQualityModelFeatureStatus:
        decisionEnforcement.metadata.entryQualityModelFeatureStatus ??
        context.entryQuality.model?.feature_status,
      entryQualityModelFeatureParityPct:
        decisionEnforcement.metadata.entryQualityModelFeatureParityPct ??
        context.entryQuality.model?.feature_parity_pct,
      entryQualityModelMissingFeaturesCount:
        decisionEnforcement.metadata.entryQualityModelMissingFeaturesCount ??
        context.entryQuality.model?.missing_features_count,
      entryQualityModelScope:
        decisionEnforcement.metadata.entryQualityModelScope ??
        context.entryQuality.model?.model_scope,
      entryQualityModelVersion:
        decisionEnforcement.metadata.entryQualityModelVersion ??
        context.entryQuality.model?.model_version,
      featureStatus:
        decisionEnforcement.metadata.entryQualityModelFeatureStatus ??
        context.entryQuality.featureStatus,
      featureParityPct:
        decisionEnforcement.metadata.entryQualityModelFeatureParityPct ??
        context.entryQuality.featureParityPct,
      missingFeaturesCount:
        decisionEnforcement.metadata.entryQualityModelMissingFeaturesCount ??
        context.entryQuality.missingFeaturesCount,
      modelScope:
        decisionEnforcement.metadata.entryQualityModelScope ?? context.entryQuality.modelScope,
      modelVersion:
        decisionEnforcement.metadata.entryQualityModelVersion ?? context.entryQuality.modelVersion,
      entryQualityRuleGateReason:
        decisionEnforcement.metadata.entryQualityRuleGateReason ?? entryQualityDecision?.reason,
      entryQualityRuleGateDecision:
        decisionEnforcement.metadata.entryQualityRuleGateDecision ?? entryQualityDecision?.action,
      entryQualityScore: decisionEnforcement.metadata.entryQualityScore,
      tailRiskScore:
        decisionEnforcement.metadata.tailRiskScore ?? eventRiskDecision?.metadata.tailRiskScore,
      eventRiskMode: decisionEnforcement.metadata.eventRiskMode,
      eventRiskWouldBlock: decisionEnforcement.metadata.eventRiskWouldBlock,
      eventRiskReason: decisionEnforcement.metadata.eventRiskReason,
      isPremiumSymbol: context.requestedPositionFraction > context.basePositionFraction,
    });
    const enforced = isGuardEnforced(policy);
    const wouldBlock = decision.wouldBlock === true || decision.allowed !== true;
    const guard: AegisEntryGuardResult = {
      name: 'clean_entry',
      enabled: true,
      mode: policy.mode,
      decision: wouldBlock ? (enforced ? 'WAIT' : 'SHADOW_DENY') : 'ALLOW',
      reason: decision.reasons[0] ?? decision.decision,
      wouldBlock,
      enforced,
      metadata: decision.metadata as unknown as Record<string, unknown>,
    };

    return { guard, decision };
  }
}
