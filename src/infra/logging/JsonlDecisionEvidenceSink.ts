import {
  assertStrategyDecisionEvidenceV2,
  type StrategyDecisionEvidenceV2,
  type DecisionEvidenceSink,
  type DecisionPersistenceTiming,
} from '../../core/blackbox/StrategyDecisionBlackBox';
import {
  RotatingJsonlWriter,
  type RotatingJsonlWriterMetrics,
  type RotatingJsonlWriterOptions,
} from './RotatingJsonlWriter';

/** Append-only V2 evidence sink. It has no exchange dependency or trading authority. */
export class JsonlDecisionEvidenceSink implements DecisionEvidenceSink {
  private readonly writer: RotatingJsonlWriter;
  private readonly timingWriter: RotatingJsonlWriter;

  constructor(filePath: string, options?: RotatingJsonlWriterOptions) {
    this.writer = new RotatingJsonlWriter(filePath, options);
    this.timingWriter = new RotatingJsonlWriter(`${filePath}.timing.jsonl`, options);
  }

  async append(record: StrategyDecisionEvidenceV2): Promise<void> {
    assertStrategyDecisionEvidenceV2(record);
    await this.writer.append(record);
  }

  health(): Readonly<RotatingJsonlWriterMetrics> {
    return this.writer.health();
  }

  async appendPersistenceTiming(record: DecisionPersistenceTiming): Promise<void> {
    if (
      record.schema !== 'DECISION_PERSISTENCE_TIMING' ||
      record.schemaVersion !== 1 ||
      !record.decisionId ||
      ![
        record.persistenceStartedAtMs,
        record.persistenceFinishedAtMs,
        record.persistenceDurationMs,
        record.serializationDurationMs,
      ].every(Number.isFinite) ||
      record.persistenceDurationMs < 0 ||
      record.serializationDurationMs < 0
    )
      throw new Error('INVALID_DECISION_PERSISTENCE_TIMING');
    await this.timingWriter.append(record);
  }

  async drain(): Promise<void> {
    await this.writer.drain();
    await this.timingWriter.drain();
  }
}
