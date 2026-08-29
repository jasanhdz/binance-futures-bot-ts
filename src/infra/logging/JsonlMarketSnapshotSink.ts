import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { MarketSnapshotV1 } from '../../core/market-data/MarketSnapshotProvider';
import type { MarketSnapshotEvidenceSink } from '../../core/blackbox/StrategyDecisionBlackBox';

/** Append-only shared market snapshot sink with no exchange or execution authority. */
export class JsonlMarketSnapshotSink implements MarketSnapshotEvidenceSink {
  constructor(private readonly filePath: string) {}

  async append(snapshot: MarketSnapshotV1): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(snapshot)}\n`, 'utf8');
  }
}
