import type { CandlePort, OrderBookPort, QuotePort } from '../../app/ports/MarketData';

export interface BenchmarkDescriptor {
  readonly id: string;
  readonly symbol: string;
}

export interface BenchmarkCandlePort {
  getSeries(interval: string, limit: number): ReturnType<CandlePort['getSeries']>;
}

export interface BenchmarkMarketData {
  readonly descriptor: BenchmarkDescriptor;
  readonly candles: BenchmarkCandlePort;
  readonly quote?: QuotePort;
  readonly orderBook?: OrderBookPort;
}

export interface BenchmarkMarketDataSources {
  readonly candles: (symbol: string) => CandlePort;
  readonly quote?: (symbol: string) => QuotePort | undefined;
  readonly orderBook?: (symbol: string) => OrderBookPort | undefined;
}

export interface BenchmarkMarketDataPort {
  getBenchmark(descriptor: BenchmarkDescriptor): BenchmarkMarketData;
}

/** Composes existing symbol capabilities without owning feeds or their lifecycle. */
export class ComposedBenchmarkMarketDataPort implements BenchmarkMarketDataPort {
  constructor(private readonly sources: BenchmarkMarketDataSources) {}

  getBenchmark(descriptor: BenchmarkDescriptor): BenchmarkMarketData {
    const normalized = Object.freeze({
      id: descriptor.id,
      symbol: descriptor.symbol.toUpperCase(),
    });
    const candles = this.sources.candles(normalized.symbol);
    const quote = this.sources.quote?.(normalized.symbol);
    const orderBook = this.sources.orderBook?.(normalized.symbol);
    return Object.freeze({
      descriptor: normalized,
      candles: Object.freeze({
        getSeries: (interval: string, limit: number) =>
          candles.getSeries(normalized.symbol, interval, limit),
      }),
      quote,
      orderBook,
    });
  }
}
