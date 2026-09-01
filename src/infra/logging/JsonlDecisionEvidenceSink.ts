import type {
  DecisionEvidenceSink,
  StrategyDecisionEvidenceV1,
} from '../../core/blackbox/StrategyDecisionBlackBox';
import {
  RotatingJsonlWriter,
  type RotatingJsonlWriterMetrics,
  type RotatingJsonlWriterOptions,
} from './RotatingJsonlWriter';

/** Append-only V1 evidence sink. It has no exchange dependency or trading authority. */
export class JsonlDecisionEvidenceSink implements DecisionEvidenceSink {
  private readonly writer: RotatingJsonlWriter;

  constructor(filePath: string, options?: RotatingJsonlWriterOptions) {
    this.writer = new RotatingJsonlWriter(filePath, options);
  }

  async append(record: StrategyDecisionEvidenceV1): Promise<void> {
    await this.writer.append(record);
  }

  health(): Readonly<RotatingJsonlWriterMetrics> {
    return this.writer.health();
  }

  async drain(): Promise<void> {
    await this.writer.drain();
  }
}
