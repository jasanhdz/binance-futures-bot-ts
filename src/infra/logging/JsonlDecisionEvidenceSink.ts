import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type {
  DecisionEvidenceSink,
  StrategyDecisionEvidenceV1,
} from '../../core/blackbox/StrategyDecisionBlackBox';

/** Append-only V1 evidence sink. It has no exchange dependency or trading authority. */
export class JsonlDecisionEvidenceSink implements DecisionEvidenceSink {
  constructor(private readonly filePath: string) {}

  async append(record: StrategyDecisionEvidenceV1): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(record)}\n`, 'utf8');
  }
}
