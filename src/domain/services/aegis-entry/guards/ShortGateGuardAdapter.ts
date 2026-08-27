import {
  AegisEntryContext,
  AegisEntryGuardPolicy,
  AegisEntryGuardResult,
  guardDisabledResult,
  isGuardEnforced,
} from '../AegisEntryDecisionTypes';
import { AegisShortGate, AegisShortGateDecision } from '../../AegisShortGate';
import { inspectCurrentBrainCanonicalDecision } from '../../CurrentBrainCanonicalDecision';

export interface ShortGateGuardAdapterResult {
  guard: AegisEntryGuardResult;
  decision?: AegisShortGateDecision;
  adjustedLeverage: number;
  adjustedPositionFraction: number;
}

export class ShortGateGuardAdapter {
  static evaluate(
    context: AegisEntryContext,
    policy: AegisEntryGuardPolicy,
  ): ShortGateGuardAdapterResult {
    if (policy.enabled !== true || policy.mode === 'OFF') {
      return {
        guard: guardDisabledResult('short_gate'),
        adjustedLeverage: context.leverage,
        adjustedPositionFraction: context.requestedPositionFraction,
      };
    }

    const canonicalDecision = inspectCurrentBrainCanonicalDecision(
      context.signal.metadata?.aegis ?? context.signal.aegis,
      context.symbol,
    );
    const decision = AegisShortGate.evaluate({
      symbol: context.symbol,
      side: context.side,
      canonicalDecisionAuthorized:
        canonicalDecision.valid &&
        canonicalDecision.selected &&
        canonicalDecision.side === context.side,
      leverage: context.leverage,
      positionFraction: context.requestedPositionFraction,
      config: context.shortGate.config,
    });
    const enforced = isGuardEnforced(policy);
    const wouldBlock = decision.allowed !== true;
    const guard: AegisEntryGuardResult = {
      name: 'short_gate',
      enabled: true,
      mode: policy.mode,
      decision: wouldBlock ? (enforced ? 'DENY' : 'SHADOW_DENY') : 'ALLOW',
      reason: decision.reason,
      wouldBlock,
      enforced,
      metadata: decision.metadata,
    };

    return {
      guard,
      decision,
      adjustedLeverage: enforced && decision.allowed ? decision.adjustedLeverage : context.leverage,
      adjustedPositionFraction:
        enforced && decision.allowed
          ? decision.adjustedPositionFraction
          : context.requestedPositionFraction,
    };
  }
}
