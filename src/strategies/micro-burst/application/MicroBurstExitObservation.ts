import type { StrategyIdentity } from '../../../core/strategy/StrategyIdentity';
import type { MicroBurstExitContext, MicroBurstExitDecision } from '../domain/MicroBurstTypes';

export interface MicroBurstExitObservationRecord {
  schemaVersion: 1;
  authority: 'OBSERVATION_ONLY';
  identity: StrategyIdentity;
  symbol: string;
  tradeId: string;
  decisionId: string;
  observedAtMs: number | null;
  phase: 'DECISION' | 'APPLICATION_RESULT';
  decision: MicroBurstExitDecision;
  context: MicroBurstExitContext | null;
  actionApplied: boolean | null;
  applicationStatus: 'NOT_ATTEMPTED' | 'APPLIED' | 'NOT_APPLIED' | 'UNKNOWN';
  /** Actual fills, fees and funding belong to the trade journal, joined by tradeId. */
  realizedNetPnl: null;
}

/** Bounded, failure-isolated fan-out to an existing logger/journal sink. Never awaited by risk. */
export class MicroBurstExitObservation {
  private readonly inFlight = new Set<Promise<void>>();
  private closed = false;
  private written = 0;
  private failed = 0;
  private dropped = 0;

  constructor(
    private readonly sink: {
      append(record: MicroBurstExitObservationRecord): void | Promise<void>;
    },
  ) {}

  observe(record: MicroBurstExitObservationRecord): void {
    if (this.closed || this.inFlight.size >= 64) {
      this.dropped++;
      return;
    }
    let snapshot: MicroBurstExitObservationRecord;
    try {
      snapshot = structuredClone(record);
    } catch {
      this.failed++;
      return;
    }
    const task = Promise.resolve()
      .then(() => this.sink.append(snapshot))
      .then(
        () => {
          this.written++;
        },
        () => {
          this.failed++;
        },
      )
      .finally(() => {
        this.inFlight.delete(task);
      });
    this.inFlight.add(task);
  }

  /** Seal admission after strategy tasks drain. A stuck sink cannot hold shutdown indefinitely. */
  async close(timeoutMs = 1_000): Promise<void> {
    this.closed = true;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 30_000)
      throw new Error('MICRO_EXIT_OBSERVER_DRAIN_TIMEOUT_INVALID');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([...this.inFlight]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('MICRO_EXIT_OBSERVER_DRAIN_TIMEOUT')),
            timeoutMs,
          );
        }),
      ]);
      if (this.failed || this.dropped) throw new Error('MICRO_EXIT_OBSERVER_DATA_INCOMPLETE');
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  health(): { pending: number; written: number; failed: number; dropped: number; closed: boolean } {
    return {
      pending: this.inFlight.size,
      written: this.written,
      failed: this.failed,
      dropped: this.dropped,
      closed: this.closed,
    };
  }
}
