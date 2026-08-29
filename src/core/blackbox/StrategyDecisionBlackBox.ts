import { createHash } from 'node:crypto';
import type { MarketSnapshotV1 } from '../market-data/MarketSnapshotProvider';
import type { StrategyDecisionEnvelope } from '../strategy/StrategyDecision';

export const STRATEGY_DECISION_BLACKBOX_V1 = 'STRATEGY_DECISION_BLACKBOX_V1' as const;
export const STRATEGY_DECISION_BLACKBOX_SCHEMA_VERSION = 1 as const;

export interface StrategyDecisionEvidenceV1 {
  readonly schemaVersion: 1;
  readonly decisionId: string;
  readonly marketSnapshotId: string;
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
    readonly schema: typeof STRATEGY_DECISION_BLACKBOX_V1;
    readonly schemaVersion: 1;
    readonly marketSnapshotSchemaVersion: 1;
    readonly causalClock: 'LOCAL_RECEIVE_TIME';
  };
}

export interface DecisionEvidenceSink {
  append(record: StrategyDecisionEvidenceV1): Promise<void>;
}

export interface MarketSnapshotEvidenceSink {
  append(snapshot: MarketSnapshotV1): Promise<void>;
}

export interface DecisionBlackBoxMetrics {
  attempted: number;
  written: number;
  failed: number;
  snapshotsAttempted: number;
  snapshotsWritten: number;
  snapshotsFailed: number;
}

export class StrategyDecisionBlackBox {
  private readonly metrics: DecisionBlackBoxMetrics = {
    attempted: 0,
    written: 0,
    failed: 0,
    snapshotsAttempted: 0,
    snapshotsWritten: 0,
    snapshotsFailed: 0,
  };

  constructor(
    private readonly sink: DecisionEvidenceSink,
    private readonly now: () => number = Date.now,
    private readonly marketSnapshotSink?: MarketSnapshotEvidenceSink,
  ) {}

  async observe(
    snapshot: MarketSnapshotV1,
    decision: StrategyDecisionEnvelope,
    evaluatedAtReceivedMs: number = snapshot.capturedAtMs,
  ): Promise<void> {
    this.metrics.attempted += 1;
    try {
      if (this.marketSnapshotSink) {
        this.metrics.snapshotsAttempted += 1;
        try {
          await this.marketSnapshotSink.append(snapshot);
          this.metrics.snapshotsWritten += 1;
        } catch (error) {
          this.metrics.snapshotsFailed += 1;
          throw error;
        }
      }
      await this.sink.append(
        createDecisionEvidenceV1(snapshot, decision, this.now(), evaluatedAtReceivedMs),
      );
      this.metrics.written += 1;
    } catch {
      // V1 is observational: collection failure must never change strategy authority/decision semantics.
      this.metrics.failed += 1;
    }
  }

  health(): Readonly<DecisionBlackBoxMetrics> {
    return { ...this.metrics };
  }
}

export function createDecisionEvidenceV1(
  snapshot: MarketSnapshotV1,
  decision: StrategyDecisionEnvelope,
  recordedAtMs: number = Date.now(),
  evaluatedAtReceivedMs: number = snapshot.capturedAtMs,
): StrategyDecisionEvidenceV1 {
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

  const decisionId = createHash('sha256')
    .update(
      JSON.stringify({
        strategyId: decision.identity.strategyId,
        strategyVersion: decision.identity.strategyVersion,
        codeCommitSha: decision.identity.codeCommitSha,
        symbol: decision.symbol,
        strategyTimestampMs: decision.timestamp,
        evaluatedAtReceivedMs,
        marketSnapshotId: snapshot.snapshotId,
        decision: decision.decision,
        side: decision.side ?? null,
      }),
    )
    .digest('hex');

  return {
    schemaVersion: 1,
    decisionId,
    marketSnapshotId: snapshot.snapshotId,
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
    diagnostics: { ...decision.diagnostics },
    marketHealth: snapshot.health,
    provenance: {
      schema: STRATEGY_DECISION_BLACKBOX_V1,
      schemaVersion: 1,
      marketSnapshotSchemaVersion: 1,
      causalClock: 'LOCAL_RECEIVE_TIME',
    },
  };
}
