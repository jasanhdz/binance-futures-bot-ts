import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { StrategyTelemetryEventV1 } from '../../core/telemetry/StrategyTelemetry';
import type { StrategyTelemetrySink } from '../../core/telemetry/StrategyTelemetryBus';

export class JsonlStrategyTelemetrySink implements StrategyTelemetrySink {
  constructor(
    private readonly filePath = 'data/strategy-telemetry/events-v1.jsonl',
  ) {}

  async append(event: StrategyTelemetryEventV1): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.appendFile(this.filePath, `${JSON.stringify(event)}\n`, 'utf8');
  }
}
