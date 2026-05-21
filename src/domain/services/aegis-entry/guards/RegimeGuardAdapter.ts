import {
    AegisEntryContext,
    AegisEntryGuardPolicy,
    AegisEntryGuardResult,
    guardDisabledResult,
    isGuardEnforced
} from '../AegisEntryDecisionTypes';
import { AegisRegimeDecision, AegisRegimeGuard } from '../../AegisRegimeGuard';

export interface RegimeGuardAdapterResult {
    guard: AegisEntryGuardResult;
    decision?: AegisRegimeDecision;
}

export class RegimeGuardAdapter {
    static evaluate(context: AegisEntryContext, policy: AegisEntryGuardPolicy): RegimeGuardAdapterResult {
        if (policy.enabled !== true || policy.mode === 'OFF' || context.regime?.config.enabled !== true) {
            const decision = context.regime?.config
                ? AegisRegimeGuard.evaluate({
                    symbol: context.symbol,
                    side: context.side,
                    isAltSymbol: context.eventRisk.isAltSymbol,
                    turboScore: context.turboScore,
                    votes: context.votes,
                    setupGrade: context.setupGrade,
                    entryQualityScore: context.entryQuality.entryQualityScore,
                    tailRiskScore: context.entryQuality.tailRiskScore,
                    eventRiskMode: context.eventRisk.mode,
                    eventRiskReason: context.eventRisk.reason,
                    eventRiskWouldBlock: context.eventRisk.wouldBlock,
                    eventRiskAuto: context.eventRisk.auto,
                    btcAction: context.regime.btcAction ?? context.eventRisk.btcAction,
                    btcScore: context.regime.btcScore ?? context.eventRisk.btcScore,
                    btcVotes: context.regime.btcVotes,
                    ethAction: context.regime.ethAction ?? context.eventRisk.ethAction,
                    ethScore: context.regime.ethScore ?? context.eventRisk.ethScore,
                    ethVotes: context.regime.ethVotes,
                    marketDistribution: context.regime.marketDistribution,
                    snapshotAgeSeconds: context.regime.snapshotAgeSeconds,
                    nowMs: context.operational.timestamp,
                    config: { ...context.regime.config, enabled: false, mode: 'OFF' }
                })
                : undefined;
            return {
                guard: guardDisabledResult('regime', decision?.reason ?? 'regime_disabled'),
                decision
            };
        }

        const decision = AegisRegimeGuard.evaluate({
            symbol: context.symbol,
            side: context.side,
            isAltSymbol: context.eventRisk.isAltSymbol,
            turboScore: context.turboScore,
            votes: context.votes,
            setupGrade: context.setupGrade,
            entryQualityScore: context.entryQuality.entryQualityScore,
            tailRiskScore: context.entryQuality.tailRiskScore,
            eventRiskMode: context.eventRisk.mode,
            eventRiskReason: context.eventRisk.reason,
            eventRiskWouldBlock: context.eventRisk.wouldBlock,
            eventRiskAuto: context.eventRisk.auto,
            btcAction: context.regime.btcAction ?? context.eventRisk.btcAction,
            btcScore: context.regime.btcScore ?? context.eventRisk.btcScore,
            btcVotes: context.regime.btcVotes,
            ethAction: context.regime.ethAction ?? context.eventRisk.ethAction,
            ethScore: context.regime.ethScore ?? context.eventRisk.ethScore,
            ethVotes: context.regime.ethVotes,
            marketDistribution: context.regime.marketDistribution,
            snapshotAgeSeconds: context.regime.snapshotAgeSeconds,
            nowMs: context.operational.timestamp,
            config: {
                ...context.regime.config,
                mode: policy.mode
            }
        });
        const enforced = isGuardEnforced(policy);
        const wouldBlock = decision.wouldBlock === true || decision.allowed !== true;
        const guard: AegisEntryGuardResult = {
            name: 'regime',
            enabled: true,
            mode: policy.mode,
            decision: wouldBlock ? (enforced ? 'DENY' : 'SHADOW_DENY') : 'ALLOW',
            reason: wouldBlock && !enforced ? 'regime_shadow_would_block' : decision.reason,
            wouldBlock,
            enforced,
            metadata: {
                ...decision.metadata,
                regime: decision.regime,
                confidence: decision.confidence,
                source: decision.source,
                reason: decision.reason,
                policyMode: policy.mode,
                effectiveMode: policy.mode,
                btcAction: context.regime.btcAction ?? context.eventRisk.btcAction,
                ethAction: context.regime.ethAction ?? context.eventRisk.ethAction,
                tailRiskScore: context.entryQuality.tailRiskScore,
                eventRiskMode: context.eventRisk.mode,
                snapshotAgeSeconds: context.regime.snapshotAgeSeconds
            }
        };

        return { guard, decision };
    }
}
