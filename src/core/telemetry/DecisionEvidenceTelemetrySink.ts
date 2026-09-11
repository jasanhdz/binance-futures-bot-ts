import type {
  DecisionEvidenceSink,
  StrategyDecisionEvidenceV2,
  DecisionPersistenceTiming,
} from '../blackbox/StrategyDecisionBlackBox';
import type { StrategyTelemetryBus } from './StrategyTelemetryBus';

/** Keeps the existing Black Box sink authoritative and mirrors decisions into generic telemetry. */
export class DecisionEvidenceTelemetrySink implements DecisionEvidenceSink {
  constructor(
    private readonly primary: DecisionEvidenceSink,
    private readonly telemetry: StrategyTelemetryBus,
  ) {}

  async appendPersistenceTiming(record: DecisionPersistenceTiming): Promise<void> {
    await this.primary.appendPersistenceTiming?.(record);
  }

  async append(record: StrategyDecisionEvidenceV2): Promise<void> {
    await this.primary.append(record);
    await this.telemetry.publish({
      eventType: 'DECISION',
      strategyId: record.strategy.strategyId,
      identity: record.strategy,
      symbol: record.symbol,
      occurredAtMs: record.evaluatedAtReceivedMs,
      decisionId: record.decisionId,
      marketSnapshotId: record.marketSnapshotId,
      side: record.side,
      status: record.decision,
      reason: record.reason,
      details: {
        evidenceSchemaVersion: record.schemaVersion,
        evidenceLevel: record.evidenceLevel,
        evidenceRecordId: record.decisionId,
        marketSnapshotStored: record.marketSnapshotStored,
        marketSnapshotContentHash: record.marketSnapshotContentHash,
        observedMarketSnapshotId: record.observedMarketSnapshotId,
        mode: record.mode,
        confidence: record.confidence,
        structuralInvalidation: record.structuralInvalidation,
        destinationPrice: record.destinationPrice,
        requestedRisk: record.requestedRisk,
        marketHealth: record.marketHealth,
      },
    });
  }
}
