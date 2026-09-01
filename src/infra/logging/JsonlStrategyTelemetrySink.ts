import type { StrategyTelemetryEventV1 } from '../../core/telemetry/StrategyTelemetry';
import type { StrategyTelemetrySink } from '../../core/telemetry/StrategyTelemetryBus';
import {
  RotatingJsonlWriter,
  type RotatingJsonlWriterMetrics,
  type RotatingJsonlWriterOptions,
} from './RotatingJsonlWriter';

export class JsonlStrategyTelemetrySink implements StrategyTelemetrySink {
  private readonly writer: RotatingJsonlWriter;

  constructor(
    filePath = 'data/strategy-telemetry/events-v2.jsonl',
    options?: RotatingJsonlWriterOptions,
  ) {
    this.writer = new RotatingJsonlWriter(filePath, options);
  }

  async append(event: StrategyTelemetryEventV1): Promise<void> {
    await this.writer.append(event);
  }

  health(): Readonly<RotatingJsonlWriterMetrics> {
    return this.writer.health();
  }

  async drain(): Promise<void> {
    await this.writer.drain();
  }
}
