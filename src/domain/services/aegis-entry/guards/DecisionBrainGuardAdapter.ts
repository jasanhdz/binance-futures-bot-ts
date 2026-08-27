import {
  AegisEntryContext,
  AegisEntryGuardPolicy,
  AegisEntryGuardResult,
  guardDisabledResult,
  isGuardEnforced,
} from '../AegisEntryDecisionTypes';
import {
  AegisDecisionEnforcement,
  AegisDecisionEnforcementDecision,
} from '../../AegisDecisionEnforcement';
import { AegisEntryQualityGateDecision } from '../../AegisEntryQualityGate';
import { AegisEventRiskOverlayDecision } from '../../AegisEventRiskOverlay';

export interface DecisionBrainGuardAdapterResult {
  guard: AegisEntryGuardResult;
  decision?: AegisDecisionEnforcementDecision;
}

export class DecisionBrainGuardAdapter {
  static evaluate(
    context: AegisEntryContext,
    policy: AegisEntryGuardPolicy,
    entryQualityDecision?: AegisEntryQualityGateDecision,
    eventRiskDecision?: AegisEventRiskOverlayDecision,
  ): DecisionBrainGuardAdapterResult {
    const decision = AegisDecisionEnforcement.evaluate({
      symbol: context.symbol,
      side: context.side,
      turboScore: context.turboScore,
      decisionBrain: context.decisionBrain?.block,
      entryQualityModel: context.entryQuality.model,
      entryQualityGate: entryQualityDecision,
      eventRiskMode: eventRiskDecision?.mode ?? context.eventRisk.mode,
      eventRiskWouldBlock: eventRiskDecision?.wouldBlock ?? context.eventRisk.wouldBlock,
      eventRiskReason: eventRiskDecision?.reason ?? context.eventRisk.reason,
      eventRiskAuto: context.eventRisk.auto,
      isAltSymbol: context.eventRisk.isAltSymbol,
      config: context.decisionEnforcement.config,
      riskOffTailMax: context.decisionEnforcement.riskOffTailMax,
    });
    if (policy.enabled !== true || policy.mode === 'OFF') {
      return {
        guard: guardDisabledResult('decision_brain'),
        decision,
      };
    }

    const enforced = isGuardEnforced(policy);
    const wouldBlock = decision.allowed !== true;
    const guard: AegisEntryGuardResult = {
      name: 'decision_brain',
      enabled: true,
      mode: policy.mode,
      decision: wouldBlock ? (enforced ? 'DENY' : 'SHADOW_DENY') : 'ALLOW',
      reason: decision.reason,
      wouldBlock,
      enforced,
      metadata: decision.metadata as unknown as Record<string, unknown>,
    };

    return { guard, decision };
  }
}
