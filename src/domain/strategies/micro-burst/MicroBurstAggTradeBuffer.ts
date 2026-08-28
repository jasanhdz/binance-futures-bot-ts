import { AggTradeEvent } from './MicroBurstMarketDataTypes';

// Time retention is authoritative; this only prevents unbounded memory use during a feed failure.
const DEFAULT_EMERGENCY_MAX_BUFFER_SIZE = 50_000;
const DEFAULT_MAX_AGE_MS = 300_000;

interface Clock {
  now(): number;
}

export interface MicroBurstAggTradeGap {
  previousTradeId: number;
  nextTradeId: number;
  previousEventTimeMs: number | null;
  nextEventTimeMs: number;
  dedupeKey: string;
}

interface AggTradeGapInterval {
  startedAtMs: number;
  endedAtMs: number;
  previousTradeId: number;
  nextTradeId: number;
  dedupeKey: string;
}

export class MicroBurstAggTradeBuffer {
  private readonly buffer: AggTradeEvent[] = [];
  private readonly maxSize: number;
  private readonly maxAgeMs: number;
  private eventWatermarkMs: number | null = null;
  private coverageStartedAtMs: number | null = null;
  private lastCapacityEvictedEventTime: number | null = null;
  private readonly gapIntervals: AggTradeGapInterval[] = [];
  private readonly gapKeys = new Set<string>();
  private lastTradeId: number | null = null;
  private lastTradeEventTimeMs: number | null = null;

  constructor(
    clock: Clock,
    maxSize = DEFAULT_EMERGENCY_MAX_BUFFER_SIZE,
    maxAgeMs = DEFAULT_MAX_AGE_MS,
    private readonly onGap?: (gap: MicroBurstAggTradeGap) => void,
    private readonly hasPersistedGap?: (fromMs: number, toMs: number) => boolean,
  ) {
    // Retain the clock argument for source compatibility. Event time is the sole retention clock.
    void clock;
    this.maxSize = maxSize;
    this.maxAgeMs = maxAgeMs;
  }

  push(event: AggTradeEvent): void {
    if (!Number.isFinite(event.price) || event.price <= 0) return;
    if (!Number.isFinite(event.quantity) || event.quantity < 0) return;
    if (!Number.isFinite(event.eventTime) || event.eventTime <= 0) return;

    this.eventWatermarkMs = Math.max(this.eventWatermarkMs ?? event.eventTime, event.eventTime);
    if (this.coverageStartedAtMs === null) this.coverageStartedAtMs = event.eventTime;
    if (
      this.lastTradeId !== null &&
      event.firstTradeId !== undefined &&
      event.firstTradeId > this.lastTradeId + 1
    ) {
      const previousTradeId = this.lastTradeId;
      const nextTradeId = event.firstTradeId;
      const dedupeKey = `${previousTradeId}:${nextTradeId}`;
      if (!this.gapKeys.has(dedupeKey)) {
        this.gapKeys.add(dedupeKey);
        this.gapIntervals.push({
          startedAtMs: this.lastTradeEventTimeMs ?? event.eventTime,
          endedAtMs: event.eventTime,
          previousTradeId,
          nextTradeId,
          dedupeKey,
        });
        this.onGap?.({
          previousTradeId,
          nextTradeId,
          previousEventTimeMs: this.lastTradeEventTimeMs,
          nextEventTimeMs: event.eventTime,
          dedupeKey,
        });
      }
    }
    if (event.lastTradeId !== undefined)
      this.lastTradeId = Math.max(this.lastTradeId ?? -1, event.lastTradeId);
    this.lastTradeEventTimeMs = Math.max(
      this.lastTradeEventTimeMs ?? event.eventTime,
      event.eventTime,
    );
    this.pruneExpired();
    if (event.eventTime <= this.eventWatermarkMs - this.maxAgeMs) return;

    let insertAt = this.buffer.length;
    while (insertAt > 0 && this.buffer[insertAt - 1].eventTime > event.eventTime) {
      insertAt--;
    }
    this.buffer.splice(insertAt, 0, event);

    while (this.buffer.length > this.maxSize) {
      const evicted = this.buffer.shift();
      if (evicted) this.lastCapacityEvictedEventTime = evicted.eventTime;
    }
  }

  getRecent(maxAgeMs?: number): ReadonlyArray<AggTradeEvent> {
    const requestedWindowMs = maxAgeMs ?? this.maxAgeMs;
    if (this.eventWatermarkMs === null) return [];
    const cutoff = this.eventWatermarkMs - requestedWindowMs;
    const start = this.buffer.findIndex((event) => event.eventTime > cutoff);
    return start === -1 ? [] : this.buffer.slice(start);
  }

  getTakerFlow(maxAgeMs?: number): {
    buyVolume: number;
    sellVolume: number;
    netTakerVolume: number;
    tradeCount: number;
    requestedWindowMs: number;
    observedWindowMs: number;
    observedSampleCount: number;
    eventWatermarkMs: number | null;
    capacityTruncated: boolean;
    coverageStartedAtMs: number | null;
    windowComplete: boolean;
    gapFree: boolean;
  } {
    const requestedWindowMs = maxAgeMs ?? this.maxAgeMs;
    const recent = this.getRecent(requestedWindowMs);
    const gapFree = this.isCurrentWindowGapFree(requestedWindowMs);
    let buyVolume = 0;
    let sellVolume = 0;

    for (const trade of recent) {
      if (trade.isBuyerMaker) {
        sellVolume += trade.quantity;
      } else {
        buyVolume += trade.quantity;
      }
    }

    return {
      buyVolume,
      sellVolume,
      netTakerVolume: buyVolume - sellVolume,
      tradeCount: recent.length,
      requestedWindowMs,
      observedWindowMs:
        recent.length > 1 ? recent[recent.length - 1].eventTime - recent[0].eventTime : 0,
      observedSampleCount: recent.length,
      eventWatermarkMs: this.eventWatermarkMs,
      capacityTruncated:
        this.lastCapacityEvictedEventTime !== null &&
        this.eventWatermarkMs !== null &&
        this.lastCapacityEvictedEventTime > this.eventWatermarkMs - requestedWindowMs,
      coverageStartedAtMs: this.coverageStartedAtMs,
      windowComplete:
        this.coverageStartedAtMs !== null &&
        this.eventWatermarkMs !== null &&
        this.eventWatermarkMs - this.coverageStartedAtMs >= requestedWindowMs &&
        gapFree &&
        !(
          this.lastCapacityEvictedEventTime !== null &&
          this.lastCapacityEvictedEventTime > this.eventWatermarkMs - requestedWindowMs
        ),
      gapFree,
    };
  }

  clear(): void {
    this.buffer.length = 0;
    this.eventWatermarkMs = null;
    this.coverageStartedAtMs = null;
    this.lastCapacityEvictedEventTime = null;
    this.gapIntervals.length = 0;
    this.gapKeys.clear();
    this.lastTradeId = null;
    this.lastTradeEventTimeMs = null;
  }

  size(): number {
    return this.buffer.length;
  }

  private pruneExpired(): void {
    if (this.eventWatermarkMs === null) return;
    const cutoff = this.eventWatermarkMs - this.maxAgeMs;
    while (this.buffer.length > 0 && this.buffer[0].eventTime <= cutoff) {
      this.buffer.shift();
    }
    const retainedGaps = this.gapIntervals.filter((gap) => gap.endedAtMs >= cutoff);
    this.gapIntervals.splice(0, this.gapIntervals.length, ...retainedGaps);
    this.gapKeys.clear();
    for (const gap of this.gapIntervals) this.gapKeys.add(gap.dedupeKey);
  }

  private isCurrentWindowGapFree(requestedWindowMs: number): boolean {
    if (this.eventWatermarkMs === null) return true;
    const fromMs = this.eventWatermarkMs - requestedWindowMs;
    const inMemoryGap = this.gapIntervals.some(
      (gap) => gap.startedAtMs <= this.eventWatermarkMs! && gap.endedAtMs >= fromMs,
    );
    if (inMemoryGap) return false;
    try {
      return !(this.hasPersistedGap?.(fromMs, this.eventWatermarkMs) ?? false);
    } catch {
      return false;
    }
  }
}
