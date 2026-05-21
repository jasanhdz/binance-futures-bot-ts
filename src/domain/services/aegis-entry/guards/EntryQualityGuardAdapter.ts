import {
    AegisEntryContext,
    AegisEntryGuardPolicy,
    AegisEntryGuardResult,
    guardDisabledResult,
    isGuardEnforced
} from '../AegisEntryDecisionTypes';
import { AegisEntryQualityGateDecision, evaluateAegisEntryQualityGate } from '../../AegisEntryQualityGate';

export interface EntryQualityGuardAdapterResult {
    guard: AegisEntryGuardResult;
    decision?: AegisEntryQualityGateDecision;
}

export class EntryQualityGuardAdapter {
    static evaluate(context: AegisEntryContext, policy: AegisEntryGuardPolicy): EntryQualityGuardAdapterResult {
        if (policy.enabled !== true || policy.mode === 'OFF') {
            return { guard: guardDisabledResult('entry_quality') };
        }

        const ruleGate = context.entryQuality.ruleGate;
        const legacyMode = ruleGate.mode === 'ENFORCE' || ruleGate.mode === 'SHADOW' ? ruleGate.mode : 'OFF';
        const effectiveMode = policy.mode === 'SHADOW' ? 'SHADOW' : legacyMode;
        const decision = evaluateAegisEntryQualityGate({
            enabled: ruleGate.enabled,
            mode: effectiveMode,
            symbol: context.symbol,
            side: context.side,
            turboScore: context.turboScore,
            votes: context.votes,
            recentCandles: ruleGate.recentCandles,
            currentPrice: ruleGate.currentPrice,
            emaFast: ruleGate.emaFast,
            atrPct: ruleGate.atrPct,
            atrPercentile: ruleGate.atrPercentile,
            config: ruleGate.config
        });
        const enforced = isGuardEnforced(policy) && effectiveMode === 'ENFORCE';
        const wouldBlock = decision.wouldBlock === true || decision.allowed !== true;
        const guard: AegisEntryGuardResult = {
            name: 'entry_quality',
            enabled: true,
            mode: effectiveMode,
            decision: wouldBlock ? (enforced ? 'DENY' : 'SHADOW_DENY') : 'ALLOW',
            reason: decision.reason,
            wouldBlock,
            enforced,
            metadata: {
                ...decision.metadata,
                action: decision.action,
                confidence: decision.confidence,
                policyMode: policy.mode,
                legacyMode,
                effectiveMode
            }
        };

        return { guard, decision };
    }
}
