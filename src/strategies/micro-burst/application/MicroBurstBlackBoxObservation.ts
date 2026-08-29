import type { CandlePort, OrderBookPort } from '../../../app/ports/MarketData';
import {
  MarketSnapshotProvider,
  type AggTradeFeatureReader,
} from '../../../core/market-data/MarketSnapshotProvider';
import { OrderBookQuoteProvider } from '../../../core/market-data/OrderBookQuoteProvider';
import {
  ComposedBenchmarkMarketDataPort,
  type BenchmarkMarketDataPort,
} from '../../../core/market-data/BenchmarkMarketData';
import {
  BlackBoxStrategyDecisionObservation,
  type StrategyDecisionObservationHook,
} from '../../../core/blackbox/StrategyDecisionObservation';
import {
  StrategyDecisionBlackBox,
  type DecisionEvidenceSink,
  type MarketSnapshotEvidenceSink,
} from '../../../core/blackbox/StrategyDecisionBlackBox';
import type { MicroBurstStrategyContext } from '../domain/MicroBurstStrategy';

export interface MicroBurstBlackBoxObservationDeps {
  readonly clock: { now(): number };
  readonly candles: CandlePort;
  readonly orderBookFor: (symbol: string) => OrderBookPort | undefined;
  readonly aggTradeFor: (symbol: string) => AggTradeFeatureReader | undefined;
  readonly decisionSink: DecisionEvidenceSink;
  readonly marketSnapshotSink: MarketSnapshotEvidenceSink;
  readonly benchmark?: BenchmarkMarketDataPort;
}

/**
 * Phase T observational composition for Micro Burst.
 * It reuses runtime-owned shared market state and has no exchange/execution authority.
 */
export function createMicroBurstBlackBoxObservation(
  deps: MicroBurstBlackBoxObservationDeps,
): StrategyDecisionObservationHook<MicroBurstStrategyContext> {
  const quoteFor = (symbol: string) => {
    const book = deps.orderBookFor(symbol.toUpperCase());
    return book ? new OrderBookQuoteProvider(symbol.toUpperCase(), book) : undefined;
  };
  const benchmark =
    deps.benchmark ??
    new ComposedBenchmarkMarketDataPort({
      candles: () => deps.candles,
      quote: quoteFor,
      orderBook: (symbol) => deps.orderBookFor(symbol.toUpperCase()),
    });
  const snapshotProvider = new MarketSnapshotProvider(
    {
      quoteFor,
      orderBookFor: (symbol) => deps.orderBookFor(symbol.toUpperCase()),
      aggTradeFor: (symbol) => deps.aggTradeFor(symbol.toUpperCase()),
      candles: deps.candles,
      benchmark,
    },
    deps.clock,
  );
  const blackBox = new StrategyDecisionBlackBox(
    deps.decisionSink,
    () => deps.clock.now(),
    deps.marketSnapshotSink,
  );

  return new BlackBoxStrategyDecisionObservation(
    snapshotProvider,
    blackBox,
    (strategyId, context) => {
      if (strategyId !== 'MICRO_BURST_V1') return null;
      return {
        symbol: context.symbol,
        quote: true,
        orderBookFeatures: true,
        aggTrade: true,
        candles: { interval: '1m', limit: 30 },
        // The Micro Burst runtime always owns benchmark candles, but it only owns a BTC
        // order-book lease when BTCUSDT itself is enabled. Do not create a hidden feed merely
        // for evidence collection; optional benchmark depth can be added by shared composition later.
        benchmark: {
          descriptor: { id: 'PRIMARY_CRYPTO_BENCHMARK', symbol: 'BTCUSDT' },
          candles: { interval: '1m', limit: 30 },
        },
      };
    },
  );
}
