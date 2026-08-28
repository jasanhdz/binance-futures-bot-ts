import { describe, expect, it, vi } from 'vitest';
import { MarketDataCandleProvider } from './MarketDataCandleProvider';
import type { Candle } from '../../domain/types';

const NOW_MS = 1_700_000_000_000;

function candle(openTime: number, closeTime: number, overrides: Partial<Candle> = {}): Candle {
  return {
    openTime,
    timestamp: openTime,
    open: 100,
    high: 110,
    low: 90,
    close: 105,
    volume: 10,
    buyVolume: 4,
    closeTime,
    ...overrides,
  };
}

function provider(candles: Candle[], exchangeSnapshotTimeMs = NOW_MS) {
  const source = {
    getCandles: vi.fn().mockResolvedValue(candles),
    getServerTime: vi.fn().mockResolvedValue(exchangeSnapshotTimeMs),
  };
  const clock = { now: vi.fn(() => NOW_MS + 123) };
  return { provider: new MarketDataCandleProvider(source, clock), source, clock };
}

describe('MarketDataCandleProvider', () => {
  it('returns healthy closed observations with explicit identity and clocks', async () => {
    const { provider: candleProvider } = provider(
      [candle(0, 59_999), candle(60_000, 119_999)],
      120_000,
    );

    const series = await candleProvider.getSeries('ethusdt', '1m', 2);

    expect(series.symbol).toBe('ETHUSDT');
    expect(series.interval).toBe('1m');
    expect(series.health).toBe('HEALTHY');
    expect(series.gapCheck).toBe('CHECKED');
    expect(series.hasGaps).toBe(false);
    expect(series.candles.map((item) => item.status)).toEqual(['CLOSED', 'CLOSED']);
    expect(series.candles[0]).toMatchObject({
      symbol: 'ETHUSDT',
      interval: '1m',
      openTime: 0,
      closeTime: 59_999,
      buyVolume: 4,
      observedAtMs: NOW_MS + 123,
      source: 'REST',
    });
    expect(series.exchangeSnapshotTimeMs).toBe(120_000);
  });

  it('classifies a current candle as OPEN at the exchange-time boundary', async () => {
    const { provider: candleProvider } = provider([candle(120_000, 179_999)], 150_000);

    const series = await candleProvider.getSeries('ETHUSDT', '1m', 1);

    expect(series.health).toBe('HEALTHY');
    expect(series.candles[0].status).toBe('OPEN');
  });

  it('classifies closeTime equal to exchangeSnapshotTimeMs as CLOSED', async () => {
    const { provider: candleProvider } = provider([candle(0, 60_000)], 60_000);

    const series = await candleProvider.getSeries('ETHUSDT', '1m', 1);

    expect(series.candles[0].status).toBe('CLOSED');
  });

  it('keeps a candle OPEN when it closes after the pre-fetch exchange boundary', async () => {
    const source = {
      getServerTime: vi.fn().mockResolvedValue(1_000),
      getCandles: vi.fn().mockResolvedValue([candle(0, 2_000)]),
    };
    const candleProvider = new MarketDataCandleProvider(source, { now: () => 3_000 });

    const series = await candleProvider.getSeries('ETHUSDT', '1m', 1);

    expect(series.exchangeSnapshotTimeMs).toBe(1_000);
    expect(series.observedAtMs).toBe(3_000);
    expect(series.candles[0].status).toBe('OPEN');
    expect(source.getServerTime.mock.invocationCallOrder[0]).toBeLessThan(
      source.getCandles.mock.invocationCallOrder[0],
    );
  });

  it('marks a candle CLOSED when the pre-fetch exchange boundary already includes its close', async () => {
    const source = {
      getServerTime: vi.fn().mockResolvedValue(2_000),
      getCandles: vi.fn().mockResolvedValue([candle(0, 2_000)]),
    };
    const candleProvider = new MarketDataCandleProvider(source, { now: () => 3_000 });

    const series = await candleProvider.getSeries('ETHUSDT', '1m', 1);

    expect(series.candles[0].status).toBe('CLOSED');
  });

  it.each([
    ['1m', 60_000],
    ['3m', 180_000],
    ['5m', 300_000],
    ['15m', 900_000],
    ['30m', 1_800_000],
    ['1h', 3_600_000],
    ['2h', 7_200_000],
    ['4h', 14_400_000],
    ['6h', 21_600_000],
    ['8h', 28_800_000],
    ['12h', 43_200_000],
    ['1d', 86_400_000],
    ['3d', 259_200_000],
    ['1w', 604_800_000],
  ])('checks continuity for fixed interval %s', async (interval, durationMs) => {
    const { provider: candleProvider } = provider(
      [candle(0, durationMs - 1), candle(durationMs, durationMs * 2 - 1)],
      durationMs * 2,
    );

    const series = await candleProvider.getSeries('ETHUSDT', interval, 2);

    expect(series.gapCheck).toBe('CHECKED');
    expect(series.gapCount).toBe(0);
    expect(series.hasGaps).toBe(false);
  });

  it('checks calendar continuity for monthly candles', async () => {
    const january = Date.UTC(2026, 0, 1);
    const february = Date.UTC(2026, 1, 1);
    const { provider: candleProvider } = provider(
      [candle(january, february - 1), candle(february, Date.UTC(2026, 2, 1) - 1)],
      Date.UTC(2026, 2, 1),
    );

    const series = await candleProvider.getSeries('ETHUSDT', '1M', 2);

    expect(series.gapCheck).toBe('CHECKED');
    expect(series.gapCount).toBe(0);
    expect(series.hasGaps).toBe(false);
  });

  it('reports deterministic gaps without repairing the source', async () => {
    const { provider: candleProvider } = provider(
      [candle(0, 59_999), candle(120_000, 179_999)],
      180_000,
    );

    const series = await candleProvider.getSeries('ETHUSDT', '1m', 2);

    expect(series.health).toBe('GAPPED');
    expect(series.gapCount).toBe(1);
    expect(series.hasGaps).toBe(true);
    expect(series.candles).toHaveLength(2);
  });

  it('reports unsupported interval continuity explicitly', async () => {
    const { provider: candleProvider } = provider(
      [candle(0, 59_999), candle(120_000, 179_999)],
      180_000,
    );

    const series = await candleProvider.getSeries('ETHUSDT', '2w', 2);

    expect(series.health).toBe('HEALTHY');
    expect(series.gapCheck).toBe('UNSUPPORTED');
    expect(series.gapCount).toBe(0);
    expect(series.hasGaps).toBeNull();
  });

  it('marks stale market coverage without changing candle status', async () => {
    const { provider: candleProvider } = provider([candle(0, 299_999)], 600_000);

    const series = await candleProvider.getSeries('ETHUSDT', '5m', 1);

    expect(series.health).toBe('STALE');
    expect(series.candles[0].status).toBe('CLOSED');
  });

  it.each([
    { name: 'out-of-order', candles: [candle(60_000, 119_999), candle(0, 59_999)] },
    { name: 'duplicate open time', candles: [candle(0, 59_999), candle(0, 59_999)] },
    {
      name: 'duplicate close time',
      candles: [candle(0, 119_999), candle(60_000, 119_999)],
    },
    { name: 'future candle', candles: [candle(NOW_MS + 1, NOW_MS + 60_000)] },
    { name: 'invalid OHLC', candles: [candle(0, 59_999, { high: 80 })] },
    { name: 'negative volume', candles: [candle(0, 59_999, { volume: -1 })] },
    { name: 'non-finite volume', candles: [candle(0, 59_999, { volume: Number.NaN })] },
    { name: 'negative buy volume', candles: [candle(0, 59_999, { buyVolume: -1 })] },
    { name: 'non-finite price', candles: [candle(0, 59_999, { close: Number.NaN })] },
  ])('fails closed for %s source data', async ({ candles }) => {
    const { provider: candleProvider } = provider(candles, NOW_MS);

    const series = await candleProvider.getSeries('ETHUSDT', '1m', candles.length);

    expect(series.health).toBe('ANOMALOUS');
    expect(series.candles).toEqual([]);
  });

  it('returns unavailable for an empty series and preserves source failure quality', async () => {
    const { provider: candleProvider } = provider([], NOW_MS);

    const series = await candleProvider.getSeries('ETHUSDT', '1m', 10);

    expect(series.health).toBe('UNAVAILABLE');
    expect(series.candles).toEqual([]);
    expect(series.hasGaps).toBeNull();
  });

  it('detaches and freezes returned candles and series arrays', async () => {
    const sourceCandle = candle(0, 59_999);
    const { provider: candleProvider } = provider([sourceCandle], 60_000);

    const series = await candleProvider.getSeries('ETHUSDT', '1m', 1);
    sourceCandle.close = 999;

    expect(series.candles[0].close).toBe(105);
    expect(Object.isFrozen(series)).toBe(true);
    expect(Object.isFrozen(series.candles)).toBe(true);
    expect(Object.isFrozen(series.candles[0])).toBe(true);
    const mutableCandles = series.candles as unknown as Array<(typeof series.candles)[number]>;
    expect(() => mutableCandles.push(series.candles[0])).toThrow();
  });

  it('does not poll during construction and calls source only on explicit read', async () => {
    const { provider: candleProvider, source, clock } = provider([candle(0, 59_999)], 60_000);

    expect(source.getCandles).not.toHaveBeenCalled();
    expect(source.getServerTime).not.toHaveBeenCalled();
    expect(clock.now).not.toHaveBeenCalled();

    await candleProvider.getSeries('ETHUSDT', '1m', 1);

    expect(source.getCandles).toHaveBeenCalledOnce();
    expect(source.getServerTime).toHaveBeenCalledOnce();
    expect(clock.now).toHaveBeenCalledOnce();
  });

  it('returns unavailable and skips candle fetch when server time fails', async () => {
    const source = {
      getServerTime: vi.fn().mockRejectedValue(new Error('server time down')),
      getCandles: vi.fn(),
    };
    const candleProvider = new MarketDataCandleProvider(source, { now: () => NOW_MS });

    const series = await candleProvider.getSeries('ETHUSDT', '1m', 1);

    expect(series.health).toBe('UNAVAILABLE');
    expect(source.getCandles).not.toHaveBeenCalled();
  });

  it('returns unavailable when candle fetch fails after server time succeeds', async () => {
    const source = {
      getServerTime: vi.fn().mockResolvedValue(NOW_MS),
      getCandles: vi.fn().mockRejectedValue(new Error('REST down')),
    };
    const candleProvider = new MarketDataCandleProvider(source, { now: () => NOW_MS });

    const series = await candleProvider.getSeries('ETHUSDT', '1m', 1);

    expect(series.health).toBe('UNAVAILABLE');
    expect(source.getServerTime).toHaveBeenCalledOnce();
  });
});
