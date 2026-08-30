import type { Candle } from '../types';

export type SharedCandleSource = 'WEBSOCKET' | 'REST_WARMUP' | 'REST_RECOVERY';
export type SharedCandleStatus = 'NO_DATA' | 'FRESH' | 'STALE';

export interface SharedCandleSnapshot {
  readonly symbol: string;
  readonly interval: string;
  readonly candles: readonly Candle[];
  readonly source?: SharedCandleSource;
  readonly status: SharedCandleStatus;
  readonly observedAtMs?: number;
  readonly ageMs?: number;
  readonly websocketObservedAtMs?: number;
  readonly restFallbackCount: number;
}

export interface CandleLease {
  readonly symbol: string;
  readonly interval: string;
  release(): void;
}

export interface CandleDataPlaneDeps {
  subscribe(
    symbol: string,
    interval: string,
    onCandle: (candle: Candle, observedAtMs: number) => void,
  ): () => void;
  fetch(symbol: string, interval: string, limit: number): Promise<Candle[]>;
  clock: { now(): number };
  freshnessMs?: number;
  maxCandles?: number;
}

type Entry = {
  refs: number;
  candles: Candle[];
  lastSource?: SharedCandleSource;
  observedAtMs?: number;
  websocketObservedAtMs?: number;
  restFallbackCount: number;
  unsubscribe: () => void;
  inFlight?: Promise<void>;
};

/**
 * Application-shared live candle cache.
 * WebSocket is steady state; REST only seeds history or recovers stale state.
 */
export class CandleDataPlane {
  private readonly entries = new Map<string, Entry>();
  private readonly freshnessMs: number;
  private readonly maxCandles: number;

  constructor(private readonly deps: CandleDataPlaneDeps) {
    this.freshnessMs = deps.freshnessMs ?? 10_000;
    this.maxCandles = deps.maxCandles ?? 1_000;
  }

  acquire(rawSymbol: string, interval = '5m'): CandleLease {
    const symbol = rawSymbol.toUpperCase();
    const key = this.key(symbol, interval);
    let entry = this.entries.get(key);
    if (!entry) {
      const next: Entry = {
        refs: 0,
        candles: [],
        restFallbackCount: 0,
        unsubscribe: () => {},
      };
      next.unsubscribe = this.deps.subscribe(symbol, interval, (candle, observedAtMs) => {
        this.merge(next, [candle]);
        next.lastSource = 'WEBSOCKET';
        next.observedAtMs = observedAtMs;
        next.websocketObservedAtMs = observedAtMs;
      });
      entry = next;
      this.entries.set(key, entry);
    }
    entry.refs += 1;
    let released = false;
    return {
      symbol,
      interval,
      release: () => {
        if (released) return;
        released = true;
        const current = this.entries.get(key);
        if (!current) return;
        current.refs = Math.max(0, current.refs - 1);
        if (current.refs === 0) {
          current.unsubscribe();
          this.entries.delete(key);
        }
      },
    };
  }

  async ensureWarm(rawSymbol: string, interval = '5m', limit = 320): Promise<void> {
    const symbol = rawSymbol.toUpperCase();
    const entry = this.requireEntry(symbol, interval);
    if (entry.candles.length >= limit) return;
    await this.fetchInto(entry, symbol, interval, limit, 'REST_WARMUP');
  }

  async recover(rawSymbol: string, interval = '5m', limit = 320): Promise<void> {
    const symbol = rawSymbol.toUpperCase();
    const entry = this.requireEntry(symbol, interval);
    await this.fetchInto(entry, symbol, interval, limit, 'REST_RECOVERY');
  }

  read(rawSymbol: string, interval = '5m', limit = 320): SharedCandleSnapshot {
    const symbol = rawSymbol.toUpperCase();
    const entry = this.entries.get(this.key(symbol, interval));
    if (!entry || entry.candles.length === 0) {
      return { symbol, interval, candles: [], status: 'NO_DATA', restFallbackCount: entry?.restFallbackCount ?? 0 };
    }
    const now = this.deps.clock.now();
    const observedAtMs = entry.observedAtMs;
    const ageMs = observedAtMs === undefined ? undefined : Math.max(0, now - observedAtMs);
    return {
      symbol,
      interval,
      candles: entry.candles.slice(-Math.max(0, limit)),
      source: entry.lastSource,
      status: ageMs !== undefined && ageMs <= this.freshnessMs ? 'FRESH' : 'STALE',
      observedAtMs,
      ageMs,
      websocketObservedAtMs: entry.websocketObservedAtMs,
      restFallbackCount: entry.restFallbackCount,
    };
  }

  getReferenceCount(rawSymbol: string, interval = '5m'): number {
    return this.entries.get(this.key(rawSymbol.toUpperCase(), interval))?.refs ?? 0;
  }

  close(): void {
    for (const entry of this.entries.values()) entry.unsubscribe();
    this.entries.clear();
  }

  private requireEntry(symbol: string, interval: string): Entry {
    const entry = this.entries.get(this.key(symbol, interval));
    if (!entry) throw new Error(`CANDLE_DATA_PLANE_LEASE_REQUIRED:${symbol}:${interval}`);
    return entry;
  }

  private async fetchInto(
    entry: Entry,
    symbol: string,
    interval: string,
    limit: number,
    source: 'REST_WARMUP' | 'REST_RECOVERY',
  ): Promise<void> {
    if (!entry.inFlight) {
      const websocketAtStart = entry.websocketObservedAtMs;
      entry.inFlight = this.deps
        .fetch(symbol, interval, limit)
        .then((candles) => {
          this.merge(entry, candles);
          const observedAtMs = this.deps.clock.now();
          const websocketAdvanced =
            entry.websocketObservedAtMs !== undefined && entry.websocketObservedAtMs !== websocketAtStart;
          if (source === 'REST_RECOVERY') {
            entry.restFallbackCount += 1;
            if (!websocketAdvanced) {
              entry.lastSource = 'REST_RECOVERY';
              entry.observedAtMs = observedAtMs;
            }
          } else if (!websocketAdvanced && entry.websocketObservedAtMs === undefined) {
            entry.lastSource = 'REST_WARMUP';
            entry.observedAtMs = observedAtMs;
          }
        })
        .finally(() => {
          entry.inFlight = undefined;
        });
    }
    await entry.inFlight;
  }

  private merge(entry: Entry, incoming: readonly Candle[]): void {
    const byOpenTime = new Map<number, Candle>();
    for (const candle of entry.candles) byOpenTime.set(candle.openTime, candle);
    for (const candle of incoming) byOpenTime.set(candle.openTime, { ...candle });
    entry.candles = [...byOpenTime.values()]
      .sort((a, b) => a.openTime - b.openTime)
      .slice(-this.maxCandles);
  }

  private key(symbol: string, interval: string): string {
    return `${symbol}|${interval}`;
  }
}
