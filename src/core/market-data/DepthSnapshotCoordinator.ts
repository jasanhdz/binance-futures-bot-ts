import {
  isRateLimited,
  noteRateLimitUntil,
  parseRateLimitError,
} from '../../infra/adapters/rate-limit';

export interface DepthSnapshotCoordinatorOptions {
  clock?: { now(): number };
  sleep?: (ms: number) => Promise<void>;
  maxWeightPerMinute?: number;
  maxConcurrent?: number;
  symbolCooldownMs?: number;
  stableEventsToReset?: number;
  jitterMs?: number;
}

type Pending<T> = { resolve: (value: T) => void; reject: (error: unknown) => void };

export interface DepthSnapshotSymbolMetrics {
  requests: number;
  coalesced: number;
  successes: number;
  failures: number;
}

export interface DepthSnapshotCoordinatorMetrics {
  requests: number;
  coalesced: number;
  blocked: number;
  successes: number;
  failures: number;
  totalWeight: number;
  maxWeightPerMinute: number;
  circuitBreakerActivations: number;
  requestsExecutedDuringBan: number;
  queueDepth: number;
  queueHighWaterMark: number;
  inflightCount: number;
  symbols: Record<string, DepthSnapshotSymbolMetrics>;
}

const DEFAULT_WEIGHT_PER_SNAPSHOT = 20;
const DEFAULT_WINDOW_MS = 60_000;

function weightForLevels(levels: number): number {
  if (levels <= 100) return 5;
  if (levels <= 500) return 10;
  return DEFAULT_WEIGHT_PER_SNAPSHOT;
}

/** Global, weighted and fail-closed scheduler for public depth snapshots. */
export class DepthSnapshotCoordinator<T> {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxWeightPerMinute: number;
  private readonly maxConcurrent: number;
  private readonly symbolCooldownMs: number;
  private readonly stableEventsToReset: number;
  private readonly jitterMs: number;
  private readonly queue: string[] = [];
  private readonly pending = new Map<string, Pending<T>[]>();
  private readonly inflight = new Set<string>();
  private readonly recent: { at: number; weight: number }[] = [];
  private readonly symbolFailures = new Map<string, number>();
  private nextAllowedBySymbol = new Map<string, number>();
  private circuitUntil = 0;
  private globalFailureStreak = 0;
  private stableEvents = 0;
  private pumpScheduled = false;
  private circuitTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private sequence = 0;
  private nextDispatchAt = 0;
  private readonly metrics: DepthSnapshotCoordinatorMetrics;

  constructor(
    private readonly fetch: (symbol: string, levels: number) => Promise<T>,
    private readonly logger: { warn?(message: string, context?: unknown): void },
    options: DepthSnapshotCoordinatorOptions = {},
  ) {
    this.now = options.clock?.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxWeightPerMinute = options.maxWeightPerMinute ?? 1_200;
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 1);
    this.symbolCooldownMs = options.symbolCooldownMs ?? 15_000;
    this.stableEventsToReset = options.stableEventsToReset ?? 100;
    this.jitterMs = options.jitterMs ?? 250;
    this.metrics = {
      requests: 0,
      coalesced: 0,
      blocked: 0,
      successes: 0,
      failures: 0,
      totalWeight: 0,
      maxWeightPerMinute: 0,
      circuitBreakerActivations: 0,
      requestsExecutedDuringBan: 0,
      queueDepth: 0,
      queueHighWaterMark: 0,
      inflightCount: 0,
      symbols: {},
    };
  }

  request(symbol: string, levels = 1_000): Promise<T> {
    const key = symbol.toUpperCase();
    const requestKey = `${key}:${levels}`;
    this.metrics.requests++;
    const symbolMetrics = (this.metrics.symbols[key] ??= {
      requests: 0,
      coalesced: 0,
      successes: 0,
      failures: 0,
    });
    symbolMetrics.requests++;
    if (this.closed) {
      this.metrics.blocked++;
      return Promise.reject(new Error('DEPTH_SNAPSHOT_COORDINATOR_CLOSED'));
    }
    if (this.now() < this.circuitUntil || isRateLimited(this.now())) {
      this.metrics.blocked++;
      return Promise.reject(new Error('DEPTH_SNAPSHOT_CIRCUIT_OPEN'));
    }
    const existing = this.pending.get(requestKey);
    if (existing) {
      this.metrics.coalesced++;
      symbolMetrics.coalesced++;
      return new Promise<T>((resolve, reject) => existing.push({ resolve, reject }));
    }
    const promise = new Promise<T>((resolve, reject) =>
      this.pending.set(requestKey, [{ resolve, reject }]),
    );
    this.queue.push(requestKey);
    this.metrics.queueDepth = this.queue.length;
    this.metrics.queueHighWaterMark = Math.max(this.metrics.queueHighWaterMark, this.queue.length);
    this.schedulePump();
    return promise;
  }

  getCircuitUntil(): number {
    return this.circuitUntil;
  }
  getWeightUsed(now = this.now()): number {
    this.prune(now);
    return this.recent.reduce((total, item) => total + item.weight, 0);
  }

  getMetrics(): DepthSnapshotCoordinatorMetrics {
    return {
      ...this.metrics,
      queueDepth: this.queue.length,
      inflightCount: this.inflight.size,
      symbols: Object.fromEntries(
        Object.entries(this.metrics.symbols).map(([symbol, metrics]) => [symbol, { ...metrics }]),
      ),
    };
  }

  close(): void {
    this.closed = true;
    for (const entries of this.pending.values()) {
      for (const entry of entries) entry.reject(new Error('DEPTH_SNAPSHOT_COORDINATOR_CLOSED'));
    }
    this.pending.clear();
    this.queue.length = 0;
    if (this.circuitTimer) clearTimeout(this.circuitTimer);
    this.circuitTimer = null;
  }

  private schedulePump(): void {
    if (this.pumpScheduled || this.closed) return;
    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    while (!this.closed && this.inflight.size < this.maxConcurrent && this.queue.length) {
      const now = this.now();
      if (now < this.circuitUntil || isRateLimited(now)) {
        this.circuitUntil = Math.max(this.circuitUntil, now + 1_000);
        this.scheduleCircuitWake();
        return;
      }
      this.prune(now);
      if (this.nextDispatchAt > now) {
        await this.sleep(this.nextDispatchAt - now);
        continue;
      }
      const eligibleIndex = this.queue.findIndex(
        (queuedSymbol) => (this.nextAllowedBySymbol.get(queuedSymbol) ?? 0) <= now,
      );
      if (eligibleIndex < 0) {
        const nextAllowed = Math.min(
          ...this.queue.map((queuedSymbol) => this.nextAllowedBySymbol.get(queuedSymbol) ?? now),
        );
        await this.sleep(Math.max(1, nextAllowed - now));
        continue;
      }
      const requestKey = this.queue.splice(eligibleIndex, 1)[0];
      this.metrics.queueDepth = this.queue.length;
      const separator = requestKey.lastIndexOf(':');
      const symbol = requestKey.slice(0, separator);
      const levels = Number(requestKey.slice(separator + 1));
      const requestWeight = weightForLevels(levels);
      const waitForBudget =
        this.getWeightUsed(now) + requestWeight > this.maxWeightPerMinute
          ? Math.max(1, this.recent[0].at + DEFAULT_WINDOW_MS - now)
          : 0;
      if (waitForBudget) {
        this.queue.splice(eligibleIndex, 0, requestKey);
        this.metrics.queueDepth = this.queue.length;
        await this.sleep(waitForBudget);
        continue;
      }
      const entries = this.pending.get(requestKey);
      if (!entries) continue;
      this.inflight.add(requestKey);
      this.recent.push({ at: now, weight: requestWeight });
      this.metrics.totalWeight += requestWeight;
      this.metrics.maxWeightPerMinute = Math.max(
        this.metrics.maxWeightPerMinute,
        this.getWeightUsed(now),
      );
      if (isRateLimited(now) || now < this.circuitUntil) this.metrics.requestsExecutedDuringBan++;
      this.nextDispatchAt = now + (requestWeight * DEFAULT_WINDOW_MS) / this.maxWeightPerMinute;
      void this.run(requestKey, symbol, levels, entries);
    }
  }

  private async run(
    requestKey: string,
    symbol: string,
    levels: number,
    entries: Pending<T>[],
  ): Promise<void> {
    try {
      const value = await this.fetch(symbol, levels);
      this.metrics.successes++;
      this.metrics.symbols[symbol].successes++;
      for (const entry of entries) entry.resolve(value);
      this.symbolFailures.delete(symbol);
      this.stableEvents++;
      if (this.stableEvents >= this.stableEventsToReset) {
        this.globalFailureStreak = 0;
        this.stableEvents = 0;
      }
    } catch (error) {
      const details = parseRateLimitError(error, this.now());
      if (details) {
        const until = details.banUntil ?? this.now() + 60_000;
        noteRateLimitUntil(until);
        if (this.circuitUntil <= this.now()) this.metrics.circuitBreakerActivations++;
        this.circuitUntil = Math.max(this.circuitUntil, until + this.jitter());
        this.scheduleCircuitWake();
        this.logger.warn?.('depth_snapshot_rate_limit_circuit_open', {
          status: details.status,
          banUntil: until,
        });
      }
      this.stableEvents = 0;
      this.globalFailureStreak++;
      this.metrics.failures++;
      this.metrics.symbols[symbol].failures++;
      const failures = (this.symbolFailures.get(symbol) ?? 0) + 1;
      this.symbolFailures.set(symbol, failures);
      this.nextAllowedBySymbol.set(symbol, this.now() + this.backoff(failures));
      for (const entry of entries) entry.reject(error);
    } finally {
      this.pending.delete(requestKey);
      this.inflight.delete(requestKey);
      this.metrics.queueDepth = this.queue.length;
      this.schedulePump();
    }
  }

  private backoff(failures: number): number {
    const exponent = Math.min(8, failures + this.globalFailureStreak - 1);
    return Math.min(60_000, 1_000 * 2 ** exponent) + this.jitter();
  }

  private jitter(): number {
    if (!this.jitterMs) return 0;
    const value = (this.sequence++ * 1103515245 + 12345) % 2_147_483_647;
    return value % (this.jitterMs + 1);
  }

  private prune(now: number): void {
    while (this.recent.length && this.recent[0].at <= now - DEFAULT_WINDOW_MS) this.recent.shift();
  }

  private scheduleCircuitWake(): void {
    if (this.circuitTimer || this.closed) return;
    const delay = Math.max(1, this.circuitUntil - this.now());
    this.circuitTimer = setTimeout(() => {
      this.circuitTimer = null;
      this.schedulePump();
    }, delay);
    this.circuitTimer.unref?.();
  }
}
