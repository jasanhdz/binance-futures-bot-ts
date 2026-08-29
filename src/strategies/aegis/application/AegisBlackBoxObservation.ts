import type { MarketDataPort } from '../../../app/ports/MarketData';
import type { StrategyIdentity } from '../../../core/strategy/StrategyIdentity';
import type { StrategyDecisionEnvelope } from '../../../core/strategy/StrategyDecision';
import { MarketDataCandleProvider } from '../../../core/market-data/MarketDataCandleProvider';
import { MarketSnapshotProvider, type MarketSnapshotV1 } from '../../../core/market-data/MarketSnapshotProvider';
import { OrderBookQuoteProvider } from '../../../core/market-data/OrderBookQuoteProvider';
import { ComposedBenchmarkMarketDataPort } from '../../../core/market-data/BenchmarkMarketData';
import { StrategyDecisionBlackBox, type DecisionEvidenceSink, type MarketSnapshotEvidenceSink } from '../../../core/blackbox/StrategyDecisionBlackBox';
import type { SharedMarketDataRuntime } from '../../../app/services/SharedMarketDataRuntime';
import type { OrderBookLease } from '../../../core/market-data/OrderBookDataPlane';
import type { AggTradeLease } from '../../../core/market-data/AggTradeDataPlane';
import type { SynchronizedOrderBook } from '../../../core/market-data/SynchronizedOrderBook';
import type { RollingAggTradeBuffer } from '../../../core/market-data/RollingAggTradeBuffer';

export interface AegisBlackBoxObservationDeps {
  exchange: MarketDataPort;
  sharedMarketData: SharedMarketDataRuntime;
  identity: StrategyIdentity;
  clock: { now(): number };
  decisionSink: DecisionEvidenceSink;
  marketSnapshotSink: MarketSnapshotEvidenceSink;
}

/** Observational Aegis evidence adapter. It owns leases, never feeds or execution authority. */
export class AegisBlackBoxObservation {
  private readonly bookLeases = new Map<string, OrderBookLease<SynchronizedOrderBook>>();
  private readonly aggTradeLeases = new Map<string, AggTradeLease<RollingAggTradeBuffer>>();
  private readonly snapshotProvider: MarketSnapshotProvider;
  private readonly blackBox: StrategyDecisionBlackBox;

  constructor(private readonly deps: AegisBlackBoxObservationDeps) {
    const candles = new MarketDataCandleProvider(deps.exchange, deps.clock);
    const quoteFor = (symbol: string) => {
      const book = deps.sharedMarketData.orderBookDataPlane.get(symbol);
      return book ? new OrderBookQuoteProvider(symbol, book) : undefined;
    };
    this.snapshotProvider = new MarketSnapshotProvider(
      {
        quoteFor,
        orderBookFor: (symbol) => deps.sharedMarketData.orderBookDataPlane.get(symbol),
        aggTradeFor: (symbol) => deps.sharedMarketData.aggTradeDataPlane.get(symbol),
        candles,
        benchmark: new ComposedBenchmarkMarketDataPort({
          candles: () => candles,
          quote: quoteFor,
          orderBook: (symbol) => deps.sharedMarketData.orderBookDataPlane.get(symbol),
        }),
      },
      deps.clock,
    );
    this.blackBox = new StrategyDecisionBlackBox(
      deps.decisionSink,
      () => deps.clock.now(),
      deps.marketSnapshotSink,
    );
  }

  start(symbols: readonly string[]): void {
    for (const rawSymbol of symbols) {
      const symbol = rawSymbol.toUpperCase();
      if (!this.bookLeases.has(symbol)) {
        this.bookLeases.set(symbol, this.deps.sharedMarketData.orderBookDataPlane.acquire(symbol));
      }
      if (!this.aggTradeLeases.has(symbol)) {
        this.aggTradeLeases.set(symbol, this.deps.sharedMarketData.aggTradeDataPlane.acquire(symbol));
      }
    }
  }

  async capture(symbol: string): Promise<MarketSnapshotV1 | null> {
    try {
      return await this.snapshotProvider.capture({
        symbol,
        quote: true,
        orderBookFeatures: true,
        aggTrade: true,
        candles: { interval: '5m', limit: 120 },
        benchmark: {
          descriptor: { id: 'PRIMARY_CRYPTO_BENCHMARK', symbol: 'BTCUSDT' },
          candles: { interval: '5m', limit: 120 },
        },
      });
    } catch {
      return null;
    }
  }

  async observe(
    snapshot: MarketSnapshotV1 | null,
    input: {
      symbol: string;
      timestamp: number;
      side: 'LONG' | 'SHORT';
      allowed: boolean;
      reason: string;
      confidence?: number;
      requestedRisk?: number;
      diagnostics: Record<string, unknown>;
    },
  ): Promise<void> {
    if (!snapshot) return;
    const decision: StrategyDecisionEnvelope = {
      identity: this.deps.identity,
      mode: 'LIVE',
      symbol: input.symbol,
      timestamp: input.timestamp,
      decision: input.allowed ? 'ENTRY_INTENT' : 'NO_TRADE',
      side: input.allowed ? input.side : undefined,
      reason: input.reason,
      confidence: input.confidence,
      requestedRisk: input.requestedRisk,
      diagnostics: input.diagnostics,
    };
    await this.blackBox.observe(snapshot, decision);
  }

  close(): void {
    for (const lease of this.bookLeases.values()) lease.release();
    for (const lease of this.aggTradeLeases.values()) lease.release();
    this.bookLeases.clear();
    this.aggTradeLeases.clear();
  }
}
