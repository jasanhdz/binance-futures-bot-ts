import {
    AegisEntryDecisionTrace,
    AegisEntryFinalDecision,
    AegisEntryGuardResult,
    AegisEntryContext
} from './AegisEntryDecisionTypes';

export function buildAegisEntryDecisionTrace(input: {
    context: AegisEntryContext;
    guards: AegisEntryGuardResult[];
    finalDecision: AegisEntryFinalDecision;
    finalReason: string;
}): AegisEntryDecisionTrace {
    const guards: AegisEntryDecisionTrace['guards'] = {};
    for (const guard of input.guards) {
        guards[guard.name] = guard;
    }

    return {
        symbol: input.context.symbol,
        side: input.context.side,
        turbo: {
            score: input.context.turboScore,
            votes: input.context.votes,
            setupGrade: input.context.setupGrade
        },
        guards,
        finalDecision: input.finalDecision,
        finalReason: input.finalReason
    };
}

export function compactAegisEntryDecisionMetadata(trace: AegisEntryDecisionTrace): Record<string, unknown> {
    const regime = trace.guards.regime;
    const regimeMetadata = regime?.metadata ?? {};
    return {
        symbol: trace.symbol,
        side: trace.side,
        turboScore: trace.turbo.score,
        votes: trace.turbo.votes,
        setupGrade: trace.turbo.setupGrade,
        finalDecision: trace.finalDecision,
        finalReason: trace.finalReason,
        regime: regime ? {
            enabled: regime.enabled,
            mode: regime.mode,
            decision: regime.decision,
            reason: regime.reason,
            wouldBlock: regime.wouldBlock,
            enforced: regime.enforced,
            regime: regimeMetadata.regime,
            confidence: regimeMetadata.confidence,
            source: regimeMetadata.source,
            btcAction: regimeMetadata.btcAction,
            btcScore: regimeMetadata.btcScore,
            ethAction: regimeMetadata.ethAction,
            ethScore: regimeMetadata.ethScore,
            entryQualityScore: regimeMetadata.entryQualityScore,
            tailRiskScore: regimeMetadata.tailRiskScore,
            eventRiskMode: regimeMetadata.eventRiskMode,
            snapshotAgeSeconds: regimeMetadata.snapshotAgeSeconds,
            modelScope: regimeMetadata.modelScope,
            modelVersion: regimeMetadata.modelVersion,
            modelUnavailable: regimeMetadata.modelUnavailable
        } : undefined,
        guards: Object.fromEntries(
            Object.entries(trace.guards).map(([name, guard]) => [
                name,
                {
                    enabled: guard.enabled,
                    mode: guard.mode,
                    decision: guard.decision,
                    reason: guard.reason,
                    wouldBlock: guard.wouldBlock,
                    enforced: guard.enforced
                }
            ])
        )
    };
}
