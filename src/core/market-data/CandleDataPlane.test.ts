import { describe, expect, it, vi } from 'vitest';
import type { Candle } from '../types';
import { CandleDataPlane } from './CandleDataPlane';

const candle = (openTime: number, close = 100): Candle => ({
  openTime,
  timestamp: openTime,
  open: close - 1,
  high: close + 1,
  low: close - 2,
  close,
  volume: 10,
  buyVolume: 6,
  closeTime: openTime + 299_999,
});

describe('CandleDataPlane', () => {
  it('shares one live stream across leases and releases it after the final consumer', () => {
    let subscriptions = 0;
    let unsubscriptions = 0;
    const plane = new CandleDataPlane({
      clock: { now: () => 1_000 },
      fetch: async () => [],
      subscribe: () => {
        subscriptions += 1;
        return () => {
          unsubscriptions += 1;
        };
      },
    });

    const a = plane.acquire('btcusdt');
    const b = plane.acquire('BTCUSDT');
    expect(plane.getReferenceCount('BTCUSDT')).toBe(2);
    expect(subscriptions).toBe(1);

    a.release();
    expect(unsubscriptions).toBe(0);
    b.release();
    expect(unsubscriptions).toBe(1);
  });

  it('warms from REST then promotes the same series to websocket freshness', async () => {
    let onCandle: ((value: Candle, at: number) => void) | undefined;
    let now = 10_000;
    const fetch = vi.fn(async () => [candle(0), candle(300_000)]);
    const plane = new CandleDataPlane({
      clock: { now: () => now },
      fetch,
      subscribe: (_symbol, _interval, callback) => {
        onCandle = callback;
        return () => {};
      },
    });

    plane.acquire('BTCUSDT');
    await plane.ensureWarm('BTCUSDT', '5m', 2);
    expect(plane.read('BTCUSDT', '5m', 2)).toMatchObject({
      source: 'REST_WARMUP',
      status: 'FRESH',
      restFallbackCount: 0,
    });

    now = 11_000;
    onCandle?.(candle(300_000, 105), now);
    const live = plane.read('BTCUSDT', '5m', 2);
    expect(live.source).toBe('WEBSOCKET');
    expect(live.status).toBe('FRESH');
    expect(live.candles[live.candles.length - 1]?.close).toBe(105);
  });

  it('records explicit REST recovery when live candles are stale', async () => {
    let now = 0;
    let onCandle: ((value: Candle, at: number) => void) | undefined;
    const plane = new CandleDataPlane({
      clock: { now: () => now },
      freshnessMs: 1_000,
      fetch: async () => [candle(0)],
      subscribe: (_symbol, _interval, callback) => {
        onCandle = callback;
        return () => {};
      },
    });
    plane.acquire('ETHUSDT');
    onCandle?.(candle(0), 1);
    now = 5_000;
    expect(plane.read('ETHUSDT', '5m', 1).status).toBe('STALE');

    await plane.recover('ETHUSDT', '5m', 1);
    expect(plane.read('ETHUSDT', '5m', 1).restFallbackCount).toBe(1);
  });
});
