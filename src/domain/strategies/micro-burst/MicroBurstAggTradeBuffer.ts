import { AggTradeEvent } from './MicroBurstMarketDataTypes';

const DEFAULT_MAX_BUFFER_SIZE = 200;
const DEFAULT_MAX_AGE_MS = 300_000;

interface Clock {
  now(): number;
}

export class MicroBurstAggTradeBuffer {
  private readonly buffer: AggTradeEvent[] = [];
  private readonly maxSize: number;
  private readonly maxAgeMs: number;
  private readonly clock: Clock;

  constructor(clock: Clock, maxSize = DEFAULT_MAX_BUFFER_SIZE, maxAgeMs = DEFAULT_MAX_AGE_MS) {
    this.clock = clock;
    this.maxSize = maxSize;
    this.maxAgeMs = maxAgeMs;
  }

  push(event: AggTradeEvent): void {
    if (!Number.isFinite(event.price) || event.price <= 0) return;
    if (!Number.isFinite(event.quantity) || event.quantity < 0) return;
    if (!Number.isFinite(event.eventTime) || event.eventTime <= 0) return;

    this.buffer.push(event);

    while (this.buffer.length > this.maxSize) {
      this.buffer.shift();
    }
  }

  getRecent(maxAgeMs?: number): ReadonlyArray<AggTradeEvent> {
    const cutoff = this.clock.now() - (maxAgeMs ?? this.maxAgeMs);
    const start = this.buffer.findIndex((e) => e.eventTime > cutoff);
    return start === -1 ? [] : this.buffer.slice(start);
  }

  getTakerFlow(maxAgeMs?: number): {
    buyVolume: number;
    sellVolume: number;
    netTakerVolume: number;
    tradeCount: number;
  } {
    const recent = this.getRecent(maxAgeMs);
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
    };
  }

  clear(): void {
    this.buffer.length = 0;
  }

  size(): number {
    return this.buffer.length;
  }
}
