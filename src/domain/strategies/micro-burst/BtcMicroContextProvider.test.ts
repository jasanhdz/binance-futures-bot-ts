import { describe, expect, it, vi } from 'vitest';
import { BtcMicroContextProvider } from './BtcMicroContextProvider';
import { BtcCandleObservation } from './MicroBurstMarketDataTypes';

const NOW_MS = 1_700_000_000_000;

function makeCandle(close: number, closeTime: number, openTime?: number): BtcCandleObservation {
  return { close, closeTime, openTime: openTime ?? closeTime - 60_000 };
}

function makeCandles(count: number, startMs: number, basePrice = 60000): BtcCandleObservation[] {
  const candles: BtcCandleObservation[] = [];
  for (let i = 0; i < count; i++) {
    const closeTime = startMs + i * 60_000;
    candles.push(makeCandle(basePrice + i * 10, closeTime));
  }
  return candles;
}

function createDeps(candles: BtcCandleObservation[]) {
  return {
    getCandles: vi.fn().mockResolvedValue(candles),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
}

describe('BtcMicroContextProvider', () => {
  it('returns undefined when insufficient candles', async () => {
    const deps = createDeps(makeCandles(3, NOW_MS - 300_000));
    const clock = { now: vi.fn(() => NOW_MS) };
    const provider = new BtcMicroContextProvider('BTCUSDT', deps, clock);

    await provider.pollCandles();

    expect(provider.getBtcContext()).toBeUndefined();
  });

  it('computes correct 1m/3m/5m returns', async () => {
    const candles = [
      makeCandle(60000, NOW_MS - 300_000),
      makeCandle(60000, NOW_MS - 240_000),
      makeCandle(60000, NOW_MS - 180_000),
      makeCandle(60000, NOW_MS - 120_000),
      makeCandle(60000, NOW_MS - 60_000),
      makeCandle(60300, NOW_MS),
    ];
    const deps = createDeps(candles);
    const clock = { now: vi.fn(() => NOW_MS) };
    const provider = new BtcMicroContextProvider('BTCUSDT', deps, clock);

    await provider.pollCandles();

    const ctx = provider.getBtcContext();
    expect(ctx).toBeDefined();
    expect(ctx!.ret1m).toBeCloseTo(300 / 60000, 6);
    expect(ctx!.ret3m).toBeCloseTo(300 / 60000, 6);
    expect(ctx!.ret5m).toBeCloseTo(300 / 60000, 6);
    expect(ctx!.direction).toBe('LONG');
  });

  it('computes bearish direction for negative returns', async () => {
    const candles = [
      makeCandle(60300, NOW_MS - 300_000),
      makeCandle(60300, NOW_MS - 240_000),
      makeCandle(60300, NOW_MS - 180_000),
      makeCandle(60300, NOW_MS - 120_000),
      makeCandle(60300, NOW_MS - 60_000),
      makeCandle(60000, NOW_MS),
    ];
    const deps = createDeps(candles);
    const clock = { now: vi.fn(() => NOW_MS) };
    const provider = new BtcMicroContextProvider('BTCUSDT', deps, clock);

    await provider.pollCandles();

    const ctx = provider.getBtcContext();
    expect(ctx).toBeDefined();
    expect(ctx!.direction).toBe('SHORT');
    expect(ctx!.ret3m).toBeLessThan(0);
  });

  it('returns NEUTRAL for negligible returns', async () => {
    const basePrice = 60000;
    const candles = Array.from({ length: 6 }, (_, i) =>
      makeCandle(basePrice, NOW_MS - 300_000 + i * 60_000),
    );
    const deps = createDeps(candles);
    const clock = { now: vi.fn(() => NOW_MS) };
    const provider = new BtcMicroContextProvider('BTCUSDT', deps, clock);

    await provider.pollCandles();

    const ctx = provider.getBtcContext();
    expect(ctx).toBeDefined();
    expect(ctx!.direction).toBe('NEUTRAL');
  });

  it('returns undefined when stale', async () => {
    const candles = makeCandles(6, NOW_MS - 600_000);
    const deps = createDeps(candles);
    const clock = { now: vi.fn(() => NOW_MS) };
    const provider = new BtcMicroContextProvider('BTCUSDT', deps, clock, 120, 10_000);

    await provider.pollCandles();

    expect(provider.getBtcContext()).toBeUndefined();
  });

  it('computes acceleration', async () => {
    const candles = [
      makeCandle(60000, NOW_MS - 300_000),
      makeCandle(60000, NOW_MS - 240_000),
      makeCandle(60000, NOW_MS - 180_000),
      makeCandle(60000, NOW_MS - 120_000),
      makeCandle(60000, NOW_MS - 60_000),
      makeCandle(60600, NOW_MS),
    ];
    const deps = createDeps(candles);
    const clock = { now: vi.fn(() => NOW_MS) };
    const provider = new BtcMicroContextProvider('BTCUSDT', deps, clock);

    await provider.pollCandles();

    const ctx = provider.getBtcContext();
    expect(ctx).toBeDefined();
    const ret1m = 600 / 60000;
    const ret3m = 600 / 60000;
    expect(ctx!.acceleration).toBeCloseTo(ret1m - ret3m / 3, 6);
  });

  it('stop clears buffer', async () => {
    const candles = makeCandles(10, NOW_MS - 600_000);
    const deps = createDeps(candles);
    const clock = { now: vi.fn(() => NOW_MS) };
    const provider = new BtcMicroContextProvider('BTCUSDT', deps, clock);

    await provider.pollCandles();
    expect(provider.getBufferedCandles().length).toBeGreaterThan(0);

    provider.stop();
    expect(provider.getBufferedCandles().length).toBe(0);
    expect(provider.getBtcContext()).toBeUndefined();
  });

  it('deduplicates candles by closeTime', async () => {
    const candle1 = makeCandle(60000, NOW_MS - 60_000);
    const candle2 = makeCandle(60010, NOW_MS - 60_000);
    const deps = createDeps([candle1, candle2]);
    const clock = { now: vi.fn(() => NOW_MS) };
    const provider = new BtcMicroContextProvider('BTCUSDT', deps, clock);

    await provider.pollCandles();

    const buffered = provider.getBufferedCandles();
    const atSameTime = buffered.filter((c) => c.closeTime === NOW_MS - 60_000);
    expect(atSameTime).toHaveLength(1);
    expect(atSameTime[0].close).toBe(60010);
  });
});
