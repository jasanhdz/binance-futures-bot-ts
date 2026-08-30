import type {
  DecisionEvidenceSink,
  StrategyDecisionEvidenceV1,
} from '../blackbox/StrategyDecisionBlackBox';
import type { StrategyTelemetryBus } from './StrategyTelemetryBus';

/** Keeps the existing Black Box sink authoritative and mirrors decisions into generic telemetry. */
export class DecisionEvidenceTelemetrySink implements DecisionEvidenceSink {
  constructor(
    private readonly primary: DecisionEvidenceSink,
    private readonly telemetry: StrategyTelemetryBus,
  ) {}

  async append(record: StrategyDecisionEvidenceV1): Promise<void> {
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
        mode: record.mode,
        confidence: record.confidence,
        structuralInvalidation: record.structuralInvalidation,
        destinationPrice: record.destinationPrice,
        requestedRisk: record.requestedRisk,
        diagnostics: record.diagnostics,
        marketHealth: record.marketHealth,
      },
    });
  }
}
