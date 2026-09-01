import {
  assertStrategyDecisionEvidenceV2,
  type StrategyDecisionEvidenceV2,
  type DecisionEvidenceSink,
} from '../../core/blackbox/StrategyDecisionBlackBox';
import {
  RotatingJsonlWriter,
  type RotatingJsonlWriterMetrics,
  type RotatingJsonlWriterOptions,
} from './RotatingJsonlWriter';

/** Append-only V2 evidence sink. It has no exchange dependency or trading authority. */
export class JsonlDecisionEvidenceSink implements DecisionEvidenceSink {
  private readonly writer: RotatingJsonlWriter;

  constructor(filePath: string, options?: RotatingJsonlWriterOptions) {
    this.writer = new RotatingJsonlWriter(filePath, options);
  }

  async append(record: StrategyDecisionEvidenceV2): Promise<void> {
    assertStrategyDecisionEvidenceV2(record);
    await this.writer.append(record);
  }

  health(): Readonly<RotatingJsonlWriterMetrics> {
    return this.writer.health();
  }

  async drain(): Promise<void> {
    await this.writer.drain();
  }
}
