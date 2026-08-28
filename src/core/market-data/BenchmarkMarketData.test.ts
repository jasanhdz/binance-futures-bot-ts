import { describe, expect, it, vi } from 'vitest';
import { ComposedBenchmarkMarketDataPort } from './BenchmarkMarketData';

describe('ComposedBenchmarkMarketDataPort', () => {
  it('normalizes a generic benchmark descriptor without BTC-specific rules', () => {
    const candles = { getSeries: vi.fn() };
    const port = new ComposedBenchmarkMarketDataPort({ candles: () => candles });

    const benchmark = port.getBenchmark({ id: 'SECONDARY_CRYPTO_BENCHMARK', symbol: 'ethusdt' });

    expect(benchmark.descriptor).toEqual({
      id: 'SECONDARY_CRYPTO_BENCHMARK',
      symbol: 'ETHUSDT',
    });
    expect(benchmark.candles).not.toBe(candles);
    benchmark.candles.getSeries('1m', 1);
    expect(candles.getSeries).toHaveBeenCalledWith('ETHUSDT', '1m', 1);
    expect(Object.isFrozen(benchmark)).toBe(true);
    expect(Object.isFrozen(benchmark.descriptor)).toBe(true);
  });

  it('reuses supplied capabilities and owns no polling lifecycle', () => {
    const candles = { getSeries: vi.fn() };
    const quote = { getQuote: vi.fn() };
    const orderBook = {
      start: vi.fn(),
      stop: vi.fn(),
      getState: vi.fn(),
      getHealth: vi.fn(),
      getSnapshot: vi.fn(),
    };
    const candleFactory = vi.fn(() => candles);
    const quoteFactory = vi.fn(() => quote);
    const bookFactory = vi.fn(() => orderBook);
    const port = new ComposedBenchmarkMarketDataPort({
      candles: candleFactory,
      quote: quoteFactory,
      orderBook: bookFactory,
    });

    const benchmark = port.getBenchmark({ id: 'PRIMARY_CRYPTO_BENCHMARK', symbol: 'BTCUSDT' });

    expect(candleFactory).toHaveBeenCalledWith('BTCUSDT');
    expect(quoteFactory).toHaveBeenCalledWith('BTCUSDT');
    expect(bookFactory).toHaveBeenCalledWith('BTCUSDT');
    expect(benchmark.quote).toBe(quote);
    expect(benchmark.orderBook).toBe(orderBook);
    expect(candles.getSeries).not.toHaveBeenCalled();
    expect(orderBook.start).not.toHaveBeenCalled();
    expect(orderBook.stop).not.toHaveBeenCalled();
  });
});
