import {
  AegisEntryDecisionTrace,
  AegisEntryFinalDecision,
  AegisEntryGuardResult,
  AegisEntryContext,
} from './AegisEntryDecisionTypes';
import { RegimeAvoidShadowEvaluator } from './guards/RegimeAvoidShadowEvaluator';

export function buildAegisEntryDecisionTrace(input: {
  context: AegisEntryContext;
  guards: AegisEntryGuardResult[];
  finalDecision: AegisEntryFinalDecision;
  finalReason: string;
  finalStrategy?: AegisEntryDecisionTrace['finalStrategy'];
  strategyCandidates?: AegisEntryDecisionTrace['strategyCandidates'];
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
      setupGrade: input.context.setupGrade,
    },
    guards,
    strategyCandidates: input.strategyCandidates ?? {
      aegis_turbo: { decision: input.finalDecision, reason: input.finalReason },
    },
    finalDecision: input.finalDecision,
    finalReason: input.finalReason,
    finalStrategy:
      input.finalStrategy ?? (input.finalDecision === 'ALLOW' ? 'aegis_turbo' : 'none'),
    strategy: input.finalStrategy ?? (input.finalDecision === 'ALLOW' ? 'aegis_turbo' : 'none'),
  };
}

export function compactAegisEntryDecisionMetadata(
  trace: AegisEntryDecisionTrace,
): Record<string, unknown> {
  const regime = trace.guards.regime;
  const regimeMetadata = regime?.metadata ?? {};
  const regimeContext = trace.guards.regime_context;
  const longRiskShadow = trace.guards.long_risk_shadow;
  const regimeContextMetadata =
    asRecord(regimeContext?.metadata.regimeContext) ?? regimeContext?.metadata;
  const regimeAvoidShadow = RegimeAvoidShadowEvaluator.evaluate({
    symbol: trace.symbol,
    side: trace.side,
    technicalRegime: regimeContextMetadata?.label as string | undefined,
    finalDecision: trace.finalDecision,
    finalStrategy: trace.finalStrategy,
  });
  return {
    symbol: trace.symbol,
    side: trace.side,
    turboScore: trace.turbo.score,
    votes: trace.turbo.votes,
    setupGrade: trace.turbo.setupGrade,
    finalDecision: trace.finalDecision,
    finalReason: trace.finalReason,
    finalStrategy: trace.finalStrategy,
    strategy: trace.strategy,
    strategyCandidates: trace.strategyCandidates,
    regime: regime
      ? {
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
          modelUnavailable: regimeMetadata.modelUnavailable,
        }
      : undefined,
    regimeContext: regimeContextMetadata,
    regimeAvoidShadow,
    longRiskShadow: longRiskShadow?.metadata.longRiskShadow ?? longRiskShadow?.metadata,
    guards: Object.fromEntries(
      Object.entries(trace.guards).map(([name, guard]) => [
        name,
        {
          enabled: guard.enabled,
          mode: guard.mode,
          decision: guard.decision,
          reason: guard.reason,
          wouldBlock: guard.wouldBlock,
          enforced: guard.enforced,
        },
      ]),
    ),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
