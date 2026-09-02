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
  /** Grace after a candle boundary while the just-closed candle is being published. */
  closedCandleGraceMs?: number;
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
  /** DIAGNOSTIC: timestamp of the last WebSocket kline event received */
  lastKlineEventAtMs?: number;
  /** DIAGNOSTIC: count of kline events received since acquire */
  klineEventCount: number;
};

/**
 * Application-shared live candle cache.
 * WebSocket is steady state; REST only seeds history or recovers stale state.
 */
export class CandleDataPlane {
  private readonly entries = new Map<string, Entry>();
  private readonly freshnessMs: number;
  private readonly closedCandleGraceMs: number;
  private readonly maxCandles: number;
  /** Tracks the most recent kline event across ALL subscribed symbols for route health. */
  private lastKlineEventAcrossAllSymbolsMs = 0;

  constructor(private readonly deps: CandleDataPlaneDeps) {
    this.freshnessMs = deps.freshnessMs ?? 10_000;
    this.closedCandleGraceMs = deps.closedCandleGraceMs ?? this.freshnessMs;
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
        klineEventCount: 0,
      };
      next.unsubscribe = this.deps.subscribe(symbol, interval, (candle, observedAtMs) => {
        this.merge(next, [candle]);
        next.lastSource = 'WEBSOCKET';
        next.observedAtMs = observedAtMs;
        next.websocketObservedAtMs = observedAtMs;
        next.lastKlineEventAtMs = observedAtMs;
        next.klineEventCount += 1;
        // Update route health: any kline event proves the route is alive
        if (observedAtMs > this.lastKlineEventAcrossAllSymbolsMs) {
          this.lastKlineEventAcrossAllSymbolsMs = observedAtMs;
        }
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
      return {
        symbol,
        interval,
        candles: [],
        status: 'NO_DATA',
        restFallbackCount: entry?.restFallbackCount ?? 0,
      };
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

  /** DIAGNOSTIC: returns detailed freshness info for a symbol */
  getDiagnostics(
    rawSymbol: string,
    interval = '5m',
  ): {
    exists: boolean;
    candleCount: number;
    lastSource?: SharedCandleSource;
    observedAtMs?: number;
    ageMs?: number;
    websocketObservedAtMs?: number;
    lastKlineEventAtMs?: number;
    klineEventCount: number;
    lastClosedCandleCloseTimeMs?: number;
    expectedLastClosedCandleCloseTimeMs?: number;
    seriesComplete: boolean;
    seriesReason: string;
    status: SharedCandleStatus;
    staleReason: string;
  } {
    const symbol = rawSymbol.toUpperCase();
    const entry = this.entries.get(this.key(symbol, interval));
    const now = this.deps.clock.now();
    if (!entry || entry.candles.length === 0) {
      return {
        exists: false,
        candleCount: 0,
        status: 'NO_DATA',
        klineEventCount: 0,
        seriesComplete: false,
        seriesReason: 'NO_ENTRY',
        staleReason: 'NO_ENTRY',
      };
    }
    const observedAtMs = entry.observedAtMs;
    const ageMs = observedAtMs === undefined ? undefined : Math.max(0, now - observedAtMs);
    const series = this.isSeriesComplete(symbol, interval, 96, now);
    const status: SharedCandleStatus =
      ageMs !== undefined && ageMs <= this.freshnessMs ? 'FRESH' : 'STALE';
    let staleReason = 'OK';
    if (status === 'STALE') {
      if (ageMs === undefined) {
        staleReason = 'NO_OBSERVED_AT';
      } else {
        staleReason = `AGE_${ageMs}_EXCEEDS_${this.freshnessMs}`;
      }
    }
    if (entry.candles.length < 96) {
      staleReason = `INSUFFICIENT_CANDLES_${entry.candles.length}_OF_96`;
    }
    if (entry.lastSource !== 'WEBSOCKET') {
      staleReason = `SOURCE_${entry.lastSource ?? 'NONE'}_NOT_WEBSOCKET`;
    }
    return {
      exists: true,
      candleCount: entry.candles.length,
      lastSource: entry.lastSource,
      observedAtMs,
      ageMs,
      websocketObservedAtMs: entry.websocketObservedAtMs,
      lastKlineEventAtMs: entry.lastKlineEventAtMs,
      klineEventCount: entry.klineEventCount,
      lastClosedCandleCloseTimeMs: series.latestClosedCandleCloseTimeMs,
      expectedLastClosedCandleCloseTimeMs: series.expectedLatestClosedCandleCloseTimeMs,
      seriesComplete: series.complete,
      seriesReason: series.reason,
      status,
      staleReason: series.complete ? staleReason : series.reason,
    };
  }

  /**
   * DIAGNOSTIC: Returns true if the WebSocket route is healthy.
   * Route health is determined by the most recent kline event across ALL symbols.
   * If ANY symbol received a kline event within the freshness window, the route is alive.
   */
  isRouteHealthy(now?: number): boolean {
    const ts = now ?? this.deps.clock.now();
    return (
      this.lastKlineEventAcrossAllSymbolsMs > 0 &&
      ts - this.lastKlineEventAcrossAllSymbolsMs <= this.freshnessMs
    );
  }

  /**
   * DIAGNOSTIC: Returns true if a symbol's candle series is complete and aligned,
   * regardless of when the last kline event was received.
   * Checks: (1) entry exists, (2) source is WEBSOCKET, (3) 96+ candles, (4) aligned close times.
   */
  isSeriesComplete(
    rawSymbol: string,
    interval = '5m',
    requiredCandles = 96,
    now?: number,
  ): {
    complete: boolean;
    reason: string;
    candleCount: number;
    lastSource?: SharedCandleSource;
    aligned: boolean;
    latestClosedCandleCloseTimeMs?: number;
    expectedLatestClosedCandleCloseTimeMs?: number;
  } {
    const symbol = rawSymbol.toUpperCase();
    const entry = this.entries.get(this.key(symbol, interval));
    if (!entry) return { complete: false, reason: 'NO_ENTRY', candleCount: 0, aligned: false };
    const intervalMs = this.parseIntervalMs(interval);
    if (intervalMs === undefined) {
      return {
        complete: false,
        reason: `UNSUPPORTED_INTERVAL_${interval}`,
        candleCount: entry.candles.length,
        aligned: false,
      };
    }
    if (entry.lastSource !== 'WEBSOCKET') {
      return {
        complete: false,
        reason: `SOURCE_${entry.lastSource ?? 'NONE'}_NOT_WEBSOCKET`,
        candleCount: entry.candles.length,
        aligned: false,
      };
    }
    if (entry.candles.length < requiredCandles) {
      return {
        complete: false,
        reason: `INSUFFICIENT_CANDLES_${entry.candles.length}_OF_${requiredCandles}`,
        candleCount: entry.candles.length,
        aligned: false,
      };
    }
    const evaluatedAtMs = now ?? this.deps.clock.now();
    const closedCandles = entry.candles.filter((candle) => candle.closeTime <= evaluatedAtMs);
    if (closedCandles.length < requiredCandles) {
      return {
        complete: false,
        reason: `CLOSED_CANDLES_${closedCandles.length}_OF_${requiredCandles}`,
        candleCount: entry.candles.length,
        aligned: false,
      };
    }
    const validationWindow = closedCandles.slice(-requiredCandles);
    for (let i = 1; i < validationWindow.length; i++) {
      const expected = validationWindow[i - 1].openTime + intervalMs;
      if (validationWindow[i].openTime !== expected) {
        return {
          complete: false,
          reason: 'GAP_DETECTED_IN_SERIES',
          candleCount: entry.candles.length,
          aligned: false,
        };
      }
    }
    for (const candle of validationWindow) {
      if (candle.closeTime !== candle.openTime + intervalMs - 1) {
        return {
          complete: false,
          reason: 'CANDLE_BOUNDARY_MISMATCH',
          candleCount: entry.candles.length,
          aligned: false,
        };
      }
    }
    const latestClosedCandle = closedCandles[closedCandles.length - 1];
    const expectedLatestOpenTimeMs =
      Math.floor(Math.max(0, evaluatedAtMs - this.closedCandleGraceMs) / intervalMs) * intervalMs -
      intervalMs;
    const expectedLatestClosedCandleCloseTimeMs = expectedLatestOpenTimeMs + intervalMs - 1;
    if (latestClosedCandle.openTime < expectedLatestOpenTimeMs) {
      return {
        complete: false,
        reason: `LATEST_CLOSED_CANDLE_STALE_${latestClosedCandle.closeTime}_EXPECTED_${expectedLatestClosedCandleCloseTimeMs}`,
        candleCount: entry.candles.length,
        aligned: true,
        latestClosedCandleCloseTimeMs: latestClosedCandle.closeTime,
        expectedLatestClosedCandleCloseTimeMs,
      };
    }
    if (latestClosedCandle.openTime > expectedLatestOpenTimeMs) {
      return {
        complete: false,
        reason: `LATEST_CLOSED_CANDLE_AHEAD_${latestClosedCandle.closeTime}_EXPECTED_${expectedLatestClosedCandleCloseTimeMs}`,
        candleCount: entry.candles.length,
        aligned: false,
        latestClosedCandleCloseTimeMs: latestClosedCandle.closeTime,
        expectedLatestClosedCandleCloseTimeMs,
      };
    }
    return {
      complete: true,
      reason: 'OK',
      candleCount: entry.candles.length,
      lastSource: entry.lastSource,
      aligned: true,
      latestClosedCandleCloseTimeMs: latestClosedCandle.closeTime,
      expectedLatestClosedCandleCloseTimeMs,
    };
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
            entry.websocketObservedAtMs !== undefined &&
            entry.websocketObservedAtMs !== websocketAtStart;
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

  private parseIntervalMs(interval: string): number | undefined {
    const match = /^(\d+)([smhd])$/.exec(interval);
    if (!match) return undefined;
    const amount = Number(match[1]);
    const unitMs = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[
      match[2] as 's' | 'm' | 'h' | 'd'
    ];
    return Number.isSafeInteger(amount) && amount > 0 ? amount * unitMs : undefined;
  }
}
