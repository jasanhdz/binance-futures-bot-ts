import {
  createStrategyTelemetryEvent,
  type StrategyTelemetryEventInput,
  type StrategyTelemetryEventV1,
} from './StrategyTelemetry';

export interface StrategyTelemetrySink {
  append(event: StrategyTelemetryEventV1): Promise<void>;
}

export interface StrategyTelemetryHealth {
  attempted: number;
  written: number;
  failed: number;
}

/** Observational only: telemetry failures never change trading authority. */
export class StrategyTelemetryBus {
  private readonly metrics: StrategyTelemetryHealth = { attempted: 0, written: 0, failed: 0 };

  constructor(
    private readonly sinks: readonly StrategyTelemetrySink[],
    private readonly now: () => number = Date.now,
  ) {}

  async publish(input: StrategyTelemetryEventInput): Promise<void> {
    this.metrics.attempted += 1;
    const event = createStrategyTelemetryEvent(input, this.now());
    const results = await Promise.allSettled(this.sinks.map((sink) => sink.append(event)));
    const failures = results.filter((result) => result.status === 'rejected').length;
    if (failures > 0) this.metrics.failed += 1;
    else this.metrics.written += 1;
  }

  health(): Readonly<StrategyTelemetryHealth> {
    return { ...this.metrics };
  }
}
