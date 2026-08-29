import type { MarketDataPort } from '../../../app/ports/MarketData';
import type { SharedMarketDataRuntime } from '../../../app/services/SharedMarketDataRuntime';
import type { StrategyDecisionObservationHook } from '../../../core/blackbox/StrategyDecisionObservation';
import {
  StrategyDecisionBlackBox,
  type DecisionEvidenceSink,
  type MarketSnapshotEvidenceSink,
} from '../../../core/blackbox/StrategyDecisionBlackBox';
import { ComposedBenchmarkMarketDataPort } from '../../../core/market-data/BenchmarkMarketData';
import { MarketDataCandleProvider } from '../../../core/market-data/MarketDataCandleProvider';
import {
  MarketSnapshotProvider,
  type MarketSnapshotV1,
} from '../../../core/market-data/MarketSnapshotProvider';
import { OrderBookQuoteProvider } from '../../../core/market-data/OrderBookQuoteProvider';
import type { OrderBookLease } from '../../../core/market-data/OrderBookDataPlane';
import type { AggTradeLease } from '../../../core/market-data/AggTradeDataPlane';
import type { SynchronizedOrderBook } from '../../../core/market-data/SynchronizedOrderBook';
import type { RollingAggTradeBuffer } from '../../../core/market-data/RollingAggTradeBuffer';
import type { StrategyDecisionEnvelope } from '../../../core/strategy/StrategyDecision';
import type { StrategyId } from '../../../core/strategy/StrategyIdentity';
import type { MomentumRideStrategyContext } from '../domain/MomentumRideStrategy';

const PRIMARY_BENCHMARK_SYMBOL = 'BTCUSDT';
const MAX_PENDING_CONTEXTS = 256;

export interface MomentumRideBlackBoxObservationDeps {
  exchange: MarketDataPort;
  sharedMarketData: SharedMarketDataRuntime;
  clock: { now(): number };
  decisionSink: DecisionEvidenceSink;
  marketSnapshotSink: MarketSnapshotEvidenceSink;
}

type ReplayContext = Readonly<{
  symbol: string;
  timestamp: number;
  side: MomentumRideStrategyContext['side'];
  candles: MomentumRideStrategyContext['candles'];
  policy: MomentumRideStrategyContext['policy'];
  safety: MomentumRideStrategyContext['safety'];
  openPositionsCount?: number;
  openMomentumPositions?: number;
  symbolLastStopLossAt?: number;
  liquidityStressStatus: MomentumRideStrategyContext['liquidityStressStatus'];
  liquidityStressAgeMs?: number;
  liquidityStressInputVersion: MomentumRideStrategyContext['liquidityStressInputVersion'];
}>;

/**
 * Phase T5 observational composition for Momentum Ride.
 *
 * The market snapshot is captured before strategy evaluation through StrategyRouter's
 * observation hook. The exact strategy-owned candle/context input is copied into the
 * decision diagnostics after evaluation so a decision can be reconstructed without
 * pretending cached strategy candles were freshly observed market-data capabilities.
 *
 * This adapter owns only reference-counted read-only market-data leases. It has no
 * exchange mutation or execution authority, and evidence failures remain fail-open.
 */
export class MomentumRideBlackBoxObservation
  implements StrategyDecisionObservationHook<MomentumRideStrategyContext>
{
  private readonly bookLeases = new Map<string, OrderBookLease<SynchronizedOrderBook>>();
  private readonly aggTradeLeases = new Map<string, AggTradeLease<RollingAggTradeBuffer>>();
  private readonly pendingContexts = new Map<string, ReplayContext>();
  private readonly snapshotProvider: MarketSnapshotProvider;
  private readonly blackBox: StrategyDecisionBlackBox;

  constructor(private readonly deps: MomentumRideBlackBoxObservationDeps) {
    const candles = new MarketDataCandleProvider(deps.exchange, deps.clock);
    const quoteFor = (symbol: string) => {
      const normalized = symbol.toUpperCase();
      const book = deps.sharedMarketData.orderBookDataPlane.get(normalized);
      return book ? new OrderBookQuoteProvider(normalized, book) : undefined;
    };
    const benchmark = new ComposedBenchmarkMarketDataPort({
      candles: () => candles,
      quote: quoteFor,
      orderBook: (symbol) => deps.sharedMarketData.orderBookDataPlane.get(symbol.toUpperCase()),
    });

    this.snapshotProvider = new MarketSnapshotProvider(
      {
        quoteFor,
        orderBookFor: (symbol) =>
          deps.sharedMarketData.orderBookDataPlane.get(symbol.toUpperCase()),
        aggTradeFor: (symbol) => deps.sharedMarketData.aggTradeDataPlane.get(symbol.toUpperCase()),
        candles,
        benchmark,
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
    const requiredSymbols = new Set([
      ...symbols.map((symbol) => symbol.toUpperCase()),
      PRIMARY_BENCHMARK_SYMBOL,
    ]);
    for (const symbol of requiredSymbols) {
      if (!this.bookLeases.has(symbol)) {
        this.bookLeases.set(symbol, this.deps.sharedMarketData.orderBookDataPlane.acquire(symbol));
      }
      if (!this.aggTradeLeases.has(symbol)) {
        this.aggTradeLeases.set(
          symbol,
          this.deps.sharedMarketData.aggTradeDataPlane.acquire(symbol),
        );
      }
    }
  }

  async beforeEvaluation(
    strategyId: StrategyId,
    context: MomentumRideStrategyContext,
  ): Promise<MarketSnapshotV1 | null> {
    if (strategyId !== 'MOMENTUM_RIDE') return null;
    try {
      const snapshot = await this.snapshotProvider.capture({
        symbol: context.symbol,
        quote: true,
        orderBookFeatures: true,
        aggTrade: true,
        benchmark: {
          descriptor: { id: 'PRIMARY_CRYPTO_BENCHMARK', symbol: PRIMARY_BENCHMARK_SYMBOL },
          quote: true,
          orderBookFeatures: true,
        },
      });
      this.rememberContext(snapshot.snapshotId, context);
      return snapshot;
    } catch {
      return null;
    }
  }

  async afterEvaluation(
    snapshot: MarketSnapshotV1,
    decision: StrategyDecisionEnvelope,
  ): Promise<void> {
    const context = this.pendingContexts.get(snapshot.snapshotId);
    this.pendingContexts.delete(snapshot.snapshotId);
    const augmentedDecision: StrategyDecisionEnvelope = context
      ? {
          ...decision,
          diagnostics: {
            ...decision.diagnostics,
            strategyInputReplay: context,
            strategyInputReplaySchema: 'MOMENTUM_RIDE_CONTEXT_V1',
            observationalOnly: true,
          },
        }
      : decision;
    await this.blackBox.observe(snapshot, augmentedDecision);
  }

  close(): void {
    for (const lease of this.bookLeases.values()) lease.release();
    for (const lease of this.aggTradeLeases.values()) lease.release();
    this.bookLeases.clear();
    this.aggTradeLeases.clear();
    this.pendingContexts.clear();
  }

  private rememberContext(snapshotId: string, context: MomentumRideStrategyContext): void {
    const replayContext: ReplayContext = structuredClone({
      symbol: context.symbol,
      timestamp: context.timestamp,
      side: context.side,
      candles: context.candles,
      policy: context.policy,
      safety: context.safety,
      openPositionsCount: context.openPositionsCount,
      openMomentumPositions: context.openMomentumPositions,
      symbolLastStopLossAt: context.symbolLastStopLossAt,
      liquidityStressStatus: context.liquidityStressStatus,
      liquidityStressAgeMs: context.liquidityStressAgeMs,
      liquidityStressInputVersion: context.liquidityStressInputVersion,
    });
    this.pendingContexts.set(snapshotId, replayContext);
    while (this.pendingContexts.size > MAX_PENDING_CONTEXTS) {
      const oldest = this.pendingContexts.keys().next().value;
      if (typeof oldest !== 'string') break;
      this.pendingContexts.delete(oldest);
    }
  }
}
