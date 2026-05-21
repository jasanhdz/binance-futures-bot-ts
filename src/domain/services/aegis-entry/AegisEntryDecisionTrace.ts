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
    return {
        finalDecision: trace.finalDecision,
        finalReason: trace.finalReason,
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
