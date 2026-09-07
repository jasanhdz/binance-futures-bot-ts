import type { Logger } from '../ports/Logger';

/** Window counts are bounded and contain the first blocking gate, not every failed predicate. */
export class EntryGateDiagnostics {
  private readonly counts = new Map<string, number>();
  private total = 0;
  private windowStart: number;
  private lastSample?: Record<string, unknown>;

  constructor(
    private readonly logger: Logger,
    private readonly strategy: string,
    private readonly now: () => number,
    private readonly intervalMs = 60_000,
  ) {
    this.windowStart = now();
  }

  record(stage: string, reason: string, sample?: Record<string, unknown>): void {
    const requestedKey = `${stage}:${reason}`;
    const key = this.counts.has(requestedKey) || this.counts.size < 63 ? requestedKey : 'OTHER';
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    this.total++;
    this.lastSample = sample;
    this.heartbeat();
  }

  heartbeat(): void {
    const now = this.now();
    if (now - this.windowStart < this.intervalMs) return;
    this.logger.info('strategy_entry_gate_summary', {
      strategy: this.strategy,
      windowStartMs: this.windowStart,
      windowEndMs: now,
      total: this.total,
      counts: Object.fromEntries(this.counts),
      lastSample: this.lastSample,
    });
    this.counts.clear();
    this.total = 0;
    this.lastSample = undefined;
    this.windowStart = now;
  }
}
