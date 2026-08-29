import {
  AegisEntryContext,
  AegisEntryGuardPolicy,
  AegisEntryGuardResult,
  guardDisabledResult,
  isGuardEnforced,
} from '../AegisEntryDecisionTypes';
import { AegisEventRiskOverlay, AegisEventRiskOverlayDecision } from '../../services/AegisEventRiskOverlay';

export interface EventRiskGuardAdapterResult {
  guard: AegisEntryGuardResult;
  decision?: AegisEventRiskOverlayDecision;
}

export class EventRiskGuardAdapter {
  static evaluate(
    context: AegisEntryContext,
    policy: AegisEntryGuardPolicy,
  ): EventRiskGuardAdapterResult {
    if (policy.enabled !== true || policy.mode === 'OFF') {
      const decision = AegisEventRiskOverlay.evaluate({
        enabled: false,
        mode: context.eventRisk.mode,
        enforce: false,
        symbol: context.symbol,
        side: context.side,
        turboScore: context.turboScore,
        entryQualityScore: context.entryQuality.entryQualityScore ?? undefined,
        tailRiskScore: context.entryQuality.tailRiskScore ?? undefined,
        isAltSymbol: context.eventRisk.isAltSymbol,
        config: context.eventRisk.config,
      });
      return {
        guard: guardDisabledResult('event_risk'),
        decision,
      };
    }

    const decision = AegisEventRiskOverlay.evaluate({
      enabled: context.eventRisk.enabled,
      mode: context.eventRisk.mode,
      enforce: policy.mode === 'SHADOW' ? false : context.eventRisk.enforce,
      symbol: context.symbol,
      side: context.side,
      turboScore: context.turboScore,
      entryQualityScore: context.entryQuality.entryQualityScore ?? undefined,
      tailRiskScore: context.entryQuality.tailRiskScore ?? undefined,
      // Preserve the current TradingService behavior: EventRiskOverlay did not
      // consume BTC/ETH context directly before the entry-policy extraction.
      btcAction: undefined,
      btcScore: undefined,
      ethAction: undefined,
      ethScore: undefined,
      isAltSymbol: context.eventRisk.isAltSymbol,
      config: context.eventRisk.config,
    });
    const enforced = isGuardEnforced(policy) && context.eventRisk.enforce === true;
    const wouldBlock = decision.wouldBlock === true || decision.allowed !== true;
    const guard: AegisEntryGuardResult = {
      name: 'event_risk',
      enabled: true,
      mode: enforced ? 'ENFORCE' : 'SHADOW',
      decision: wouldBlock
        ? enforced && decision.allowed !== true
          ? 'DENY'
          : 'SHADOW_DENY'
        : 'ALLOW',
      reason: decision.reason,
      wouldBlock,
      enforced,
      metadata: {
        ...decision.metadata,
        action: decision.action,
        wouldBlock: decision.wouldBlock,
        policyMode: policy.mode,
        legacyEnforce: context.eventRisk.enforce === true,
      },
    };

    return { guard, decision };
  }
}
