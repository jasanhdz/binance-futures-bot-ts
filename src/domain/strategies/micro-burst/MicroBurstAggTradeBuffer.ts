import { AggTradeEvent } from './MicroBurstMarketDataTypes';

// Time retention is authoritative; this only prevents unbounded memory use during a feed failure.
const DEFAULT_EMERGENCY_MAX_BUFFER_SIZE = 50_000;
const DEFAULT_MAX_AGE_MS = 300_000;

interface Clock {
  now(): number;
}

export class MicroBurstAggTradeBuffer {
  private readonly buffer: AggTradeEvent[] = [];
  private readonly maxSize: number;
  private readonly maxAgeMs: number;
  private eventWatermarkMs: number | null = null;
  private lastCapacityEvictedEventTime: number | null = null;

  constructor(clock: Clock, maxSize = DEFAULT_EMERGENCY_MAX_BUFFER_SIZE, maxAgeMs = DEFAULT_MAX_AGE_MS) {
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
  } {
    const requestedWindowMs = maxAgeMs ?? this.maxAgeMs;
    const recent = this.getRecent(requestedWindowMs);
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
    };
  }

  clear(): void {
    this.buffer.length = 0;
    this.eventWatermarkMs = null;
    this.lastCapacityEvictedEventTime = null;
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
  }
}
