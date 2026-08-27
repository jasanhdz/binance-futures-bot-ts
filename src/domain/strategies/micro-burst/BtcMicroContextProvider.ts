import { Side } from '../../types';
import { Logger } from '../../../app/ports/Logger';
import { BtcContext } from './MicroBurstTypes';
import { BtcCandleObservation, BtcReturnSet } from './MicroBurstMarketDataTypes';

const MAX_CANDLE_BUFFER = 120;
const STALE_THRESHOLD_MS = 120_000;
const MIN_CANDLES_FOR_RETURNS = 6;
const POLL_INTERVAL_MS = 60_000;

function computeReturn(current: number, past: number): number {
  if (!Number.isFinite(current) || !Number.isFinite(past) || past === 0) return 0;
  return (current - past) / past;
}

function computeDirection(ret3m: number): Side | 'NEUTRAL' {
  if (!Number.isFinite(ret3m)) return 'NEUTRAL';
  if (ret3m > 0.0001) return 'LONG';
  if (ret3m < -0.0001) return 'SHORT';
  return 'NEUTRAL';
}

function computeAcceleration(ret1m: number, ret3m: number): number {
  if (!Number.isFinite(ret1m) || !Number.isFinite(ret3m)) return 0;
  return ret1m - ret3m / 3;
}

export interface BtcMicroContextDeps {
  getCandles(symbol: string, interval: string, limit: number): Promise<BtcCandleObservation[]>;
  logger: Logger;
}

interface Clock {
  now(): number;
}

export class BtcMicroContextProvider {
  private readonly candleBuffer: BtcCandleObservation[] = [];
  private lastObservationMs = 0;
  private lastDirection: Side | 'NEUTRAL' = 'NEUTRAL';
  private lastRet1m = 0;
  private lastRet3m = 0;
  private lastRet5m = 0;
  private lastAcceleration = 0;
  private running = false;
  private pollInFlight = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private lifecycleVersion = 0;

  constructor(
    private readonly btcSymbol: string,
    private readonly deps: BtcMicroContextDeps,
    private readonly clock: Clock,
    private readonly maxBufferSize = MAX_CANDLE_BUFFER,
    private readonly staleThresholdMs = STALE_THRESHOLD_MS,
    private readonly pollIntervalMs = POLL_INTERVAL_MS,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    const lifecycleVersion = ++this.lifecycleVersion;
    void this.pollAndSchedule(lifecycleVersion);
  }

  stop(): void {
    this.running = false;
    this.lifecycleVersion++;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    this.candleBuffer.length = 0;
    this.lastObservationMs = 0;
    this.lastDirection = 'NEUTRAL';
    this.lastRet1m = 0;
    this.lastRet3m = 0;
    this.lastRet5m = 0;
    this.lastAcceleration = 0;
  }

  async pollCandles(): Promise<void> {
    if (this.pollInFlight) return;
    this.pollInFlight = true;
    const lifecycleVersion = this.lifecycleVersion;
    try {
      const candles = await this.deps.getCandles(this.btcSymbol, '1m', 60);
      if (lifecycleVersion !== this.lifecycleVersion) return;
      const now = this.clock.now();

      for (const candle of candles) {
        const obs: BtcCandleObservation = {
          close: candle.close,
          closeTime: candle.closeTime,
          openTime: candle.openTime,
        };
        const existing = this.candleBuffer.find((c) => c.closeTime === obs.closeTime);
        if (!existing) {
          this.candleBuffer.push(obs);
        } else {
          existing.close = obs.close;
        }
      }

      this.candleBuffer.sort((a, b) => a.closeTime - b.closeTime);

      while (this.candleBuffer.length > this.maxBufferSize) {
        this.candleBuffer.shift();
      }

      const returns = this.computeReturns(now);
      if (returns) {
        this.lastObservationMs = returns.observedAtMs;
        this.lastDirection = returns.direction;
        this.lastRet1m = returns.ret1m;
        this.lastRet3m = returns.ret3m;
        this.lastRet5m = returns.ret5m;
        this.lastAcceleration = returns.acceleration;
      }
    } catch (err) {
      this.deps.logger.error('BtcMicroContextProvider poll failed', {
        error: String(err),
      });
    } finally {
      this.pollInFlight = false;
    }
  }

  getBtcContext(): BtcContext | undefined {
    if (this.candleBuffer.length < MIN_CANDLES_FOR_RETURNS) return undefined;
    if (this.lastObservationMs === 0) return undefined;

    const now = this.clock.now();
    if (now - this.lastObservationMs > this.staleThresholdMs) return undefined;

    return {
      ret1m: this.lastRet1m,
      ret3m: this.lastRet3m,
      ret5m: this.lastRet5m,
      acceleration: this.lastAcceleration,
      conflictFlag: false,
      direction: this.lastDirection,
      observedAtMs: this.lastObservationMs,
    };
  }

  getBufferedCandles(): ReadonlyArray<BtcCandleObservation> {
    return this.candleBuffer;
  }

  private async pollAndSchedule(lifecycleVersion: number): Promise<void> {
    await this.pollCandles();
    if (!this.running || lifecycleVersion !== this.lifecycleVersion) return;
    this.pollTimer = setTimeout(() => {
      void this.pollAndSchedule(lifecycleVersion);
    }, this.pollIntervalMs);
  }

  private computeReturns(nowMs: number): BtcReturnSet | null {
    const closed = this.candleBuffer.filter((c) => c.closeTime <= nowMs);
    if (closed.length < MIN_CANDLES_FOR_RETURNS) return null;

    const latest = closed[closed.length - 1];
    if (!latest) return null;

    const currentPrice = latest.close;
    if (!Number.isFinite(currentPrice) || currentPrice <= 0) return null;

    const findCandleBefore = (targetCloseTime: number): BtcCandleObservation | null => {
      for (let i = closed.length - 1; i >= 0; i--) {
        if (closed[i].closeTime <= targetCloseTime) return closed[i];
      }
      return null;
    };

    const ret1m = (() => {
      const candle1mAgo = findCandleBefore(latest.closeTime - 60_000);
      if (!candle1mAgo) return 0;
      return computeReturn(currentPrice, candle1mAgo.close);
    })();

    const ret3m = (() => {
      const candle3mAgo = findCandleBefore(latest.closeTime - 180_000);
      if (!candle3mAgo) return 0;
      return computeReturn(currentPrice, candle3mAgo.close);
    })();

    const ret5m = (() => {
      const candle5mAgo = findCandleBefore(latest.closeTime - 300_000);
      if (!candle5mAgo) return 0;
      return computeReturn(currentPrice, candle5mAgo.close);
    })();

    const acceleration = computeAcceleration(ret1m, ret3m);
    const direction = computeDirection(ret3m);

    return {
      ret1m,
      ret3m,
      ret5m,
      acceleration,
      direction,
      observedAtMs: latest.closeTime,
    };
  }
}
