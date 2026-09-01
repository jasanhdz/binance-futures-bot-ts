import { createHash } from 'node:crypto';
import type { MarketSnapshotV1 } from '../market-data/MarketSnapshotProvider';
import type { StrategyDecisionEnvelope } from '../strategy/StrategyDecision';

export const STRATEGY_DECISION_BLACKBOX_V2 = 'STRATEGY_DECISION_BLACKBOX_V2' as const;
export const STRATEGY_DECISION_BLACKBOX_SCHEMA_VERSION = 2 as const;
export const STRATEGY_MARKET_SNAPSHOT_EVIDENCE_V2 = 'STRATEGY_MARKET_SNAPSHOT_EVIDENCE_V2' as const;

export interface StrategyDecisionEvidenceV2 {
  readonly schemaVersion: 2;
  readonly decisionId: string;
  readonly marketSnapshotId: string;
  /** Original capture id when the snapshot sink deduplicated to a canonical record. */
  readonly observedMarketSnapshotId?: string;
  readonly marketSnapshotStored: boolean;
  readonly marketSnapshotContentHash: string;
  readonly evidenceLevel: 'COMPACT' | 'FULL_REPLAY';
  readonly symbol: string;
  /** Local receive-time boundary. Never compare this with exchange/server timestamps. */
  readonly evaluatedAtReceivedMs: number;
  /** Strategy-owned timestamp retained verbatim for exact decision reconstruction. */
  readonly strategyTimestampMs: number;
  readonly recordedAtMs: number;
  readonly strategy: StrategyDecisionEnvelope['identity'];
  readonly mode: StrategyDecisionEnvelope['mode'];
  readonly decision: StrategyDecisionEnvelope['decision'];
  readonly side?: StrategyDecisionEnvelope['side'];
  readonly reason: string;
  readonly confidence?: number;
  readonly structuralInvalidation?: number;
  readonly destinationPrice?: number;
  readonly requestedRisk?: number;
  readonly diagnostics: Readonly<Record<string, unknown>>;
  readonly marketHealth: MarketSnapshotV1['health'];
  readonly provenance: {
    readonly schema: typeof STRATEGY_DECISION_BLACKBOX_V2;
    readonly schemaVersion: 2;
    readonly marketSnapshotSchemaVersion: 1;
    readonly causalClock: 'LOCAL_RECEIVE_TIME';
    readonly storagePolicy: 'TIERED_DEDUPLICATED_ROTATING_JSONL_V2';
  };
}

export interface DecisionEvidenceSink {
  append(record: StrategyDecisionEvidenceV2): Promise<void>;
}

export function assertStrategyDecisionEvidenceV2(
  record: unknown,
): asserts record is StrategyDecisionEvidenceV2 {
  if (!record || typeof record !== 'object') throw new Error('BLACKBOX_V2_RECORD_REQUIRED');
  const candidate = record as Partial<StrategyDecisionEvidenceV2>;
  const provenance = candidate.provenance as
    | Partial<StrategyDecisionEvidenceV2['provenance']>
    | undefined;
  if (
    candidate.schemaVersion !== STRATEGY_DECISION_BLACKBOX_SCHEMA_VERSION ||
    provenance?.schema !== STRATEGY_DECISION_BLACKBOX_V2 ||
    provenance.schemaVersion !== STRATEGY_DECISION_BLACKBOX_SCHEMA_VERSION ||
    provenance.storagePolicy !== 'TIERED_DEDUPLICATED_ROTATING_JSONL_V2' ||
    typeof candidate.decisionId !== 'string' ||
    typeof candidate.marketSnapshotId !== 'string' ||
    typeof candidate.marketSnapshotStored !== 'boolean' ||
    typeof candidate.marketSnapshotContentHash !== 'string' ||
    !['COMPACT', 'FULL_REPLAY'].includes(candidate.evidenceLevel ?? '')
  ) {
    throw new Error('UNSUPPORTED_STRATEGY_DECISION_BLACKBOX_SCHEMA');
  }
}

export interface MarketSnapshotEvidenceSink {
  append(snapshot: MarketSnapshotV1): Promise<MarketSnapshotEvidenceReference>;
}

export interface MarketSnapshotEvidenceReference {
  readonly snapshotId: string;
  readonly stored: boolean;
  readonly contentHash: string;
}

export interface MarketSnapshotEvidenceV2 {
  readonly schemaVersion: 2;
  readonly schema: typeof STRATEGY_MARKET_SNAPSHOT_EVIDENCE_V2;
  readonly snapshotId: string;
  readonly contentHash: string;
  readonly recordedAtMs: number;
  readonly marketSnapshot: MarketSnapshotV1;
  readonly provenance: {
    readonly marketSnapshotSchemaVersion: 1;
    readonly storagePolicy: 'DEDUPLICATED_ROTATING_JSONL_V2';
  };
}

export function createMarketSnapshotEvidenceV2(
  snapshot: MarketSnapshotV1,
  contentHash: string,
  recordedAtMs: number,
): MarketSnapshotEvidenceV2 {
  return {
    schemaVersion: STRATEGY_DECISION_BLACKBOX_SCHEMA_VERSION,
    schema: STRATEGY_MARKET_SNAPSHOT_EVIDENCE_V2,
    snapshotId: snapshot.snapshotId,
    contentHash,
    recordedAtMs,
    marketSnapshot: snapshot,
    provenance: {
      marketSnapshotSchemaVersion: snapshot.schemaVersion,
      storagePolicy: 'DEDUPLICATED_ROTATING_JSONL_V2',
    },
  };
}

export interface DecisionBlackBoxMetrics {
  attempted: number;
  written: number;
  failed: number;
  snapshotsAttempted: number;
  snapshotsWritten: number;
  snapshotsDeduplicated: number;
  snapshotsFailed: number;
}

export class StrategyDecisionBlackBox {
  private readonly metrics: DecisionBlackBoxMetrics = {
    attempted: 0,
    written: 0,
    failed: 0,
    snapshotsAttempted: 0,
    snapshotsWritten: 0,
    snapshotsDeduplicated: 0,
    snapshotsFailed: 0,
  };

  constructor(
    private readonly sink: DecisionEvidenceSink,
    private readonly now: () => number,
    private readonly marketSnapshotSink: MarketSnapshotEvidenceSink,
  ) {}

  async observe(
    snapshot: MarketSnapshotV1,
    decision: StrategyDecisionEnvelope,
    evaluatedAtReceivedMs: number = snapshot.capturedAtMs,
  ): Promise<void> {
    this.metrics.attempted += 1;
    try {
      this.metrics.snapshotsAttempted += 1;
      let reference: MarketSnapshotEvidenceReference;
      try {
        reference = await this.marketSnapshotSink.append(snapshot);
        if (reference.stored) this.metrics.snapshotsWritten += 1;
        else this.metrics.snapshotsDeduplicated += 1;
      } catch (error) {
        this.metrics.snapshotsFailed += 1;
        throw error;
      }
      await this.sink.append(
        createDecisionEvidenceV2(
          snapshot,
          decision,
          {
            marketSnapshotId: reference.snapshotId,
            marketSnapshotStored: reference.stored,
            marketSnapshotContentHash: reference.contentHash,
          },
          this.now(),
          evaluatedAtReceivedMs,
        ),
      );
      this.metrics.written += 1;
    } catch {
      // Black Box is observational: collection failure must never change strategy authority.
      this.metrics.failed += 1;
    }
  }

  health(): Readonly<DecisionBlackBoxMetrics> {
    return { ...this.metrics };
  }
}

export function createDecisionEvidenceV2(
  snapshot: MarketSnapshotV1,
  decision: StrategyDecisionEnvelope,
  snapshotReference: {
    marketSnapshotId: string;
    marketSnapshotStored: boolean;
    marketSnapshotContentHash: string;
  },
  recordedAtMs: number = Date.now(),
  evaluatedAtReceivedMs: number = snapshot.capturedAtMs,
): StrategyDecisionEvidenceV2 {
  if (snapshot.symbol !== decision.symbol) {
    throw new Error(
      `black-box symbol mismatch: snapshot=${snapshot.symbol} decision=${decision.symbol}`,
    );
  }
  if (!Number.isFinite(evaluatedAtReceivedMs) || evaluatedAtReceivedMs < snapshot.capturedAtMs) {
    throw new Error(
      `black-box causal violation: snapshot capturedAtMs=${snapshot.capturedAtMs} after local evaluation boundary=${evaluatedAtReceivedMs}`,
    );
  }

  const marketSnapshotId = snapshotReference.marketSnapshotId;
  const decisionId = createHash('sha256')
    .update(
      JSON.stringify({
        evidenceSchemaVersion: STRATEGY_DECISION_BLACKBOX_SCHEMA_VERSION,
        strategyId: decision.identity.strategyId,
        strategyVersion: decision.identity.strategyVersion,
        codeCommitSha: decision.identity.codeCommitSha,
        symbol: decision.symbol,
        strategyTimestampMs: decision.timestamp,
        evaluatedAtReceivedMs,
        marketSnapshotId,
        decision: decision.decision,
        side: decision.side ?? null,
      }),
    )
    .digest('hex');

  const compacted = compactDecisionDiagnostics(decision, snapshot);
  return {
    schemaVersion: STRATEGY_DECISION_BLACKBOX_SCHEMA_VERSION,
    decisionId,
    marketSnapshotId,
    ...(marketSnapshotId !== snapshot.snapshotId
      ? { observedMarketSnapshotId: snapshot.snapshotId }
      : {}),
    marketSnapshotStored: snapshotReference.marketSnapshotStored,
    marketSnapshotContentHash: snapshotReference.marketSnapshotContentHash,
    evidenceLevel: compacted.evidenceLevel,
    symbol: decision.symbol,
    evaluatedAtReceivedMs,
    strategyTimestampMs: decision.timestamp,
    recordedAtMs,
    strategy: { ...decision.identity },
    mode: decision.mode,
    decision: decision.decision,
    side: decision.side,
    reason: decision.reason,
    confidence: decision.confidence,
    structuralInvalidation: decision.structuralInvalidation,
    destinationPrice: decision.destinationPrice,
    requestedRisk: decision.requestedRisk,
    diagnostics: compacted.diagnostics,
    marketHealth: snapshot.health,
    provenance: {
      schema: STRATEGY_DECISION_BLACKBOX_V2,
      schemaVersion: STRATEGY_DECISION_BLACKBOX_SCHEMA_VERSION,
      marketSnapshotSchemaVersion: 1,
      causalClock: 'LOCAL_RECEIVE_TIME',
      storagePolicy: 'TIERED_DEDUPLICATED_ROTATING_JSONL_V2',
    },
  };
}

function compactDecisionDiagnostics(
  decision: StrategyDecisionEnvelope,
  snapshot: MarketSnapshotV1,
): {
  evidenceLevel: 'COMPACT' | 'FULL_REPLAY';
  diagnostics: Readonly<Record<string, unknown>>;
} {
  const diagnostics = decision.diagnostics ?? {};
  const replay = diagnostics.strategyInputReplay;
  if (!replay || typeof replay !== 'object') {
    return { evidenceLevel: 'COMPACT', diagnostics: { ...diagnostics } };
  }
  const keepFullReplay =
    decision.decision === 'ENTRY_INTENT' ||
    diagnostics.patternMatched === true ||
    diagnostics.evaluationError !== undefined;
  if (keepFullReplay) {
    return { evidenceLevel: 'FULL_REPLAY', diagnostics: { ...diagnostics } };
  }

  const replayRecord = replay as Record<string, unknown>;
  const candles = Array.isArray(replayRecord.candles) ? replayRecord.candles : [];
  const replayWithoutCandles = { ...replayRecord };
  delete replayWithoutCandles.candles;
  const replayHash = createHash('sha256').update(JSON.stringify(replayRecord)).digest('hex');
  const first = candles[0] as Record<string, unknown> | undefined;
  const last = candles[candles.length - 1] as Record<string, unknown> | undefined;
  return {
    evidenceLevel: 'COMPACT',
    diagnostics: {
      ...diagnostics,
      strategyInputReplay: {
        ...replayWithoutCandles,
        candleReplaySummary: {
          count: candles.length,
          firstOpenTime: first?.openTime,
          lastCloseTime: last?.closeTime,
          sha256: replayHash,
        },
      },
      strategyInputReplayCompacted: true,
      marketSnapshotHealth: snapshot.health,
    },
  };
}
