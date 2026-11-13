import type { SharedCandleSnapshot } from '../../core/market-data/CandleDataPlane';
import type { MarketDataPort, OrderBookState } from '../ports/MarketData';
import { ORDER_BOOK_FEATURE_DEPTH } from '../ports/MarketData';
import type { Candle } from '../../core/types';
import type {
  StrategyDataReadiness,
  StrategyDataRequirement,
  StrategyRuntimeContract,
} from '../../core/strategy/EntryStrategy';
import { processLocalCausalSequence } from '../../core/market-data/LocalCausalWatermark';
import { ROLLING_AGG_TRADE_MAX_AGE_MS } from '../../core/market-data/RollingAggTradeBuffer';
import type { SharedMarketDataRuntime } from './SharedMarketDataRuntime';

const CANDLE_DATA_PLANE_MAX_CANDLES = 1_000;
type SharedFlowSnapshot = ReturnType<
  ReturnType<SharedMarketDataRuntime['aggTradeDataPlane']['acquire']>['state']['getTakerFlow']
>;

/** Detached, immutable values read synchronously from the existing shared data planes. */
export interface SharedStrategyMarketDataSnapshot {
  readonly symbol: string;
  readonly capturedAtMs: number;
  readonly capturedAtMonotonicMs: number;
  readonly orderBook: OrderBookState | null;
  readonly candles: Readonly<Record<string, SharedCandleSnapshot>>;
  readonly aggTradeFlows: readonly {
    readonly windowMs: number;
    readonly value: SharedFlowSnapshot;
  }[];
}

export interface SharedStrategyMarketDataLease {
  readonly symbol: string;
  /** Explicit history seed; acquiring a lease never performs REST warmup implicitly. */
  warmup(): Promise<void>;
  read(): SharedStrategyMarketDataSnapshot;
  assess(
    snapshot: SharedStrategyMarketDataSnapshot,
  ): StrategyDataReadiness<SharedStrategyMarketDataSnapshot>;
  release(): void;
}

/**
 * Small explicit adapter from a strategy's declaration to the existing reference-counted planes.
 * It owns no feed, registry, or state; leases remain owned by SharedMarketDataRuntime's planes.
 */
export class StrategyContractMarketDataProvisioner {
  /**
   * Pass the same market-data port and clock used to construct `shared`. The port is used only
   * for capability-presence checks; all reads/subscriptions still go through shared planes.
   */
  constructor(
    private readonly shared: SharedMarketDataRuntime,
    private readonly available: Pick<
      MarketDataPort,
      | 'getDepthSnapshot'
      | 'subscribeToDepthDiff'
      | 'subscribeToAggTrades'
      | 'subscribeToKlineCandles'
    >,
    private readonly clock: { now(): number },
  ) {}

  acquire(contract: StrategyRuntimeContract, rawSymbol: string): SharedStrategyMarketDataLease {
    const symbol = rawSymbol.trim().toUpperCase();
    if (!symbol) throw new Error('STRATEGY_MARKET_DATA_SYMBOL_REQUIRED');
    if (
      contract.symbols.source === 'CONFIGURATION' &&
      !contract.symbols.values.some((value) => value.trim().toUpperCase() === symbol)
    )
      throw new Error(`STRATEGY_MARKET_DATA_SYMBOL_NOT_AUTHORIZED:${symbol}`);

    const requirementKeys = new Set<string>();
    const candleLimits = new Map<string, number>();
    const flowWindows = new Set<number>();
    let needsBook = false;
    for (const requirement of contract.inputs) {
      const key = JSON.stringify(requirement);
      if (requirementKeys.has(key))
        throw new Error(`STRATEGY_MARKET_DATA_REQUIREMENT_DUPLICATE:${requirement.kind}`);
      requirementKeys.add(key);
      if (requirement.kind === 'CLOSED_CANDLES') {
        if (
          !Number.isSafeInteger(requirement.limit) ||
          !Number.isSafeInteger(requirement.minimumClosed) ||
          requirement.minimumClosed <= 0 ||
          requirement.limit < requirement.minimumClosed ||
          requirement.limit > CANDLE_DATA_PLANE_MAX_CANDLES ||
          (requirement.maximumAgeMs !== null &&
            (!Number.isFinite(requirement.maximumAgeMs) || requirement.maximumAgeMs < 0))
        )
          throw new Error(
            `STRATEGY_MARKET_DATA_CANDLE_REQUIREMENT_INVALID:${requirement.interval}`,
          );
        if (!intervalDurationMs(requirement.interval))
          throw new Error(`STRATEGY_MARKET_DATA_INTERVAL_UNSUPPORTED:${requirement.interval}`);
        candleLimits.set(
          requirement.interval,
          Math.max(candleLimits.get(requirement.interval) ?? 0, requirement.limit),
        );
      } else if (requirement.kind === 'ORDER_BOOK') {
        if (
          !Number.isSafeInteger(requirement.minimumDepthLevels) ||
          requirement.minimumDepthLevels <= 0 ||
          !Number.isFinite(requirement.maximumAgeMs) ||
          requirement.maximumAgeMs < 0
        )
          throw new Error('STRATEGY_MARKET_DATA_ORDER_BOOK_REQUIREMENT_INVALID');
        if (requirement.minimumDepthLevels > ORDER_BOOK_FEATURE_DEPTH)
          throw new Error(
            `STRATEGY_MARKET_DATA_ORDER_BOOK_DEPTH_UNSUPPORTED:${requirement.minimumDepthLevels}`,
          );
        needsBook = true;
      } else if (requirement.kind === 'AGG_TRADE_FLOW') {
        if (
          !Number.isFinite(requirement.windowMs) ||
          requirement.windowMs <= 0 ||
          !Number.isSafeInteger(requirement.minimumObservedSamples) ||
          requirement.minimumObservedSamples < 0 ||
          (requirement.maximumAgeMs !== undefined &&
            (!Number.isFinite(requirement.maximumAgeMs) || requirement.maximumAgeMs < 0))
        )
          throw new Error('STRATEGY_MARKET_DATA_FLOW_REQUIREMENT_INVALID');
        if (requirement.windowMs > ROLLING_AGG_TRADE_MAX_AGE_MS)
          throw new Error(`STRATEGY_MARKET_DATA_FLOW_WINDOW_UNSUPPORTED:${requirement.windowMs}`);
        flowWindows.add(requirement.windowMs);
      } else {
        throw new Error(`STRATEGY_MARKET_DATA_CAPABILITY_UNSUPPORTED:${requirement.kind}`);
      }
    }

    if (needsBook && (!this.available.getDepthSnapshot || !this.available.subscribeToDepthDiff))
      throw new Error('STRATEGY_MARKET_DATA_CAPABILITY_UNSUPPORTED:ORDER_BOOK');
    if (flowWindows.size > 0 && !this.available.subscribeToAggTrades)
      throw new Error('STRATEGY_MARKET_DATA_CAPABILITY_UNSUPPORTED:AGG_TRADE_FLOW');
    if (candleLimits.size > 0 && !this.available.subscribeToKlineCandles)
      throw new Error('STRATEGY_MARKET_DATA_CAPABILITY_UNSUPPORTED:CLOSED_CANDLES');

    let bookLease: ReturnType<typeof this.shared.orderBookDataPlane.acquire> | undefined;
    let flowLease: ReturnType<typeof this.shared.aggTradeDataPlane.acquire> | undefined;
    const candleLeases: Array<ReturnType<typeof this.shared.candleDataPlane.acquire>> = [];
    const releaseResources = (): void => {
      for (const lease of candleLeases.splice(0).reverse()) lease.release();
      flowLease?.release();
      flowLease = undefined;
      bookLease?.release();
      bookLease = undefined;
    };

    try {
      if (needsBook) bookLease = this.shared.orderBookDataPlane.acquire(symbol);
      if (flowWindows.size > 0) flowLease = this.shared.aggTradeDataPlane.acquire(symbol);
      for (const interval of candleLimits.keys())
        candleLeases.push(this.shared.candleDataPlane.acquire(symbol, interval));
    } catch (error) {
      releaseResources();
      throw error;
    }

    let released = false;
    const issuedSnapshots = new WeakSet<object>();
    const requirements = contract.inputs;
    return {
      symbol,
      warmup: async () => {
        if (released) throw new Error('STRATEGY_MARKET_DATA_LEASE_RELEASED');
        try {
          await Promise.all(
            [...candleLimits].map(([interval, limit]) =>
              this.shared.candleDataPlane.ensureWarm(symbol, interval, limit),
            ),
          );
        } catch (error) {
          releaseResources();
          released = true;
          throw error;
        }
      },
      read: () => {
        if (released) throw new Error('STRATEGY_MARKET_DATA_LEASE_RELEASED');
        const orderBookHealth = bookLease?.book.getHealth();
        const orderBookState = bookLease?.book.getState();
        const aggTradeFlows = flowLease
          ? [...flowWindows]
              .sort((a, b) => a - b)
              .map((windowMs) => ({ windowMs, value: flowLease!.state.getTakerFlow(windowMs) }))
          : [];
        const candleSnapshots: Record<string, SharedCandleSnapshot> = {};
        for (const [interval, limit] of candleLimits)
          candleSnapshots[interval] = this.shared.candleDataPlane.read(symbol, interval, limit);
        const capturedAtMs = this.clock.now();
        const capturedAtMonotonicMs = performance.now();
        if (
          !Number.isFinite(capturedAtMs) ||
          capturedAtMs < 0 ||
          !Number.isFinite(capturedAtMonotonicMs) ||
          capturedAtMonotonicMs < 0
        )
          throw new Error('STRATEGY_MARKET_DATA_CLOCK_INVALID');
        const orderBook = orderBookState
          ? deepFreeze({ ...orderBookState, health: orderBookHealth ?? orderBookState.health })
          : null;
        const snapshot = deepFreeze({
          symbol,
          capturedAtMs,
          capturedAtMonotonicMs,
          orderBook,
          candles: candleSnapshots,
          aggTradeFlows,
        });
        issuedSnapshots.add(snapshot);
        return snapshot;
      },
      assess: (snapshot) => {
        if (!issuedSnapshots.has(snapshot))
          return {
            status: 'NOT_EVALUABLE',
            reasons: ['STRATEGY_MARKET_DATA_SNAPSHOT_NOT_ISSUED_BY_LEASE'],
            snapshot,
            diagnostics: { symbol, capturedAtMs: snapshot.capturedAtMs },
          };
        const checks = requirements.map((requirement) => ({
          requirement: requirement.kind,
          ...assessRequirement(requirement, snapshot),
        }));
        const reasons = checks
          .filter((check) => check.status !== 'READY')
          .map((check) => check.reason);
        const status = checks.some((check) => check.status === 'NOT_EVALUABLE')
          ? 'NOT_EVALUABLE'
          : checks.some((check) => check.status === 'WAIT')
            ? 'WAIT'
            : 'READY';
        return {
          status,
          reasons,
          snapshot,
          diagnostics: { symbol, capturedAtMs: snapshot.capturedAtMs, checks },
        };
      },
      release: () => {
        if (released) return;
        released = true;
        releaseResources();
      },
    };
  }
}

function assessRequirement(
  requirement: StrategyDataRequirement,
  snapshot: SharedStrategyMarketDataSnapshot,
): { status: 'READY' | 'WAIT' | 'NOT_EVALUABLE'; reason: string } {
  if (requirement.kind === 'CLOSED_CANDLES') {
    const source = snapshot.candles[requirement.interval];
    if (!source || source.status === 'NO_DATA')
      return { status: 'WAIT', reason: `CANDLES_WARMUP_PENDING:${requirement.interval}` };
    if (source.status === 'STALE')
      return { status: 'NOT_EVALUABLE', reason: `CANDLES_SOURCE_STALE:${requirement.interval}` };
    if (source.observedAtMs === undefined)
      return {
        status: 'NOT_EVALUABLE',
        reason: `CANDLES_RECEIVE_TIME_UNKNOWN:${requirement.interval}`,
      };
    const receiveAgeMs = snapshot.capturedAtMs - source.observedAtMs;
    if (receiveAgeMs < 0)
      return {
        status: 'NOT_EVALUABLE',
        reason: `CANDLES_CLOCK_REGRESSION:${requirement.interval}`,
      };
    if (requirement.maximumAgeMs !== null && receiveAgeMs > requirement.maximumAgeMs)
      return {
        status: 'NOT_EVALUABLE',
        reason: `CANDLES_RECEIVE_AGE_EXCEEDED:${requirement.interval}`,
      };
    const duration = intervalDurationMs(requirement.interval);
    if (!duration)
      return {
        status: 'NOT_EVALUABLE',
        reason: `CANDLES_INTERVAL_UNKNOWN:${requirement.interval}`,
      };
    if (source.candles.some((candle) => !validCandle(candle, duration)))
      return { status: 'NOT_EVALUABLE', reason: `CANDLES_QUALITY_INVALID:${requirement.interval}` };
    const closed = source.candles
      .filter((candle) => candle.closeTime <= snapshot.capturedAtMs)
      .slice(-requirement.minimumClosed);
    if (closed.length < requirement.minimumClosed)
      return { status: 'WAIT', reason: `CANDLES_CLOSED_WARMUP_PENDING:${requirement.interval}` };
    if (requirement.maximumAgeMs !== null) {
      const closeAgeMs = snapshot.capturedAtMs - closed[closed.length - 1].closeTime;
      if (closeAgeMs < 0)
        return {
          status: 'NOT_EVALUABLE',
          reason: `CANDLES_CLOSE_CLOCK_REGRESSION:${requirement.interval}`,
        };
      if (closeAgeMs > requirement.maximumAgeMs)
        return {
          status: 'NOT_EVALUABLE',
          reason: `CANDLES_CLOSE_AGE_EXCEEDED:${requirement.interval}`,
        };
    }
    if (requirement.gapPolicy === 'REJECT') {
      for (let index = 1; index < closed.length; index++)
        if (closed[index].openTime !== closed[index - 1].openTime + duration)
          return { status: 'NOT_EVALUABLE', reason: `CANDLES_GAP:${requirement.interval}` };
    }
    return { status: 'READY', reason: `CANDLES_READY:${requirement.interval}` };
  }

  if (requirement.kind === 'ORDER_BOOK') {
    const book = snapshot.orderBook;
    if (!book || book.health === 'UNAVAILABLE' || book.health === 'UNSYNCED')
      return { status: 'WAIT', reason: 'ORDER_BOOK_WARMUP_PENDING' };
    if (book.health !== 'HEALTHY')
      return { status: 'NOT_EVALUABLE', reason: `ORDER_BOOK_${book.health}` };
    const ageMs = snapshot.capturedAtMs - book.observedAtMs;
    if (ageMs < 0) return { status: 'NOT_EVALUABLE', reason: 'ORDER_BOOK_CLOCK_REGRESSION' };
    if (ageMs > requirement.maximumAgeMs)
      return { status: 'NOT_EVALUABLE', reason: 'ORDER_BOOK_STALE' };
    const depthKnown = Math.min(book.bids.length, book.asks.length);
    if (depthKnown < requirement.minimumDepthLevels)
      return { status: 'NOT_EVALUABLE', reason: 'ORDER_BOOK_DEPTH_INSUFFICIENT' };
    if (requirement.sequencePolicy === 'REQUIRE_LINKED_UPDATES') {
      const causal = book.localCausality;
      if (
        book.gapCount > 0 ||
        !causal ||
        causal.processGenerationId !== processLocalCausalSequence().processGenerationId ||
        causal.lastAppliedConnectionGeneration !== causal.connectionGeneration ||
        causal.lastAppliedReceiveSequence === null ||
        causal.lastAppliedReceiveSequence !== causal.receivedSequence
      )
        return { status: 'NOT_EVALUABLE', reason: 'ORDER_BOOK_LINKED_SEQUENCE_UNVERIFIED' };
    }
    return { status: 'READY', reason: 'ORDER_BOOK_READY' };
  }

  if (requirement.kind === 'AGG_TRADE_FLOW') {
    const flow = snapshot.aggTradeFlows.find(
      (candidate) => candidate.windowMs === requirement.windowMs,
    )?.value;
    if (!flow || flow.coverageStartedAtMs === null || flow.eventWatermarkMs === null)
      return { status: 'WAIT', reason: `AGG_TRADE_COVERAGE_PENDING:${requirement.windowMs}` };
    if (flow.capacityTruncated)
      return {
        status: 'NOT_EVALUABLE',
        reason: `AGG_TRADE_CAPACITY_TRUNCATED:${requirement.windowMs}`,
      };
    if (requirement.continuityPolicy === 'REQUIRE_GAP_FREE') {
      if (flow.confirmedGapCount > 0 || flow.pendingGapCount > 0)
        return { status: 'NOT_EVALUABLE', reason: `AGG_TRADE_GAP:${requirement.windowMs}` };
      if (!flow.windowComplete || !flow.gapFree) {
        if (flow.eventWatermarkMs - flow.coverageStartedAtMs < requirement.windowMs)
          return { status: 'WAIT', reason: `AGG_TRADE_CONTINUITY_WARMUP:${requirement.windowMs}` };
        return {
          status: 'NOT_EVALUABLE',
          reason: `AGG_TRADE_WINDOW_INCOMPLETE:${requirement.windowMs}`,
        };
      }
    } else if (!flow.windowComplete) {
      return { status: 'WAIT', reason: `AGG_TRADE_WINDOW_WARMUP:${requirement.windowMs}` };
    }
    if (flow.observedSampleCount < requirement.minimumObservedSamples)
      return {
        status: 'NOT_EVALUABLE',
        reason: `AGG_TRADE_SAMPLES_INSUFFICIENT:${requirement.windowMs}`,
      };
    if (requirement.maximumAgeMs !== undefined) {
      const causal = flow.localCausality;
      if (
        !causal ||
        causal.processGenerationId !== processLocalCausalSequence().processGenerationId ||
        causal.lastAppliedConnectionGeneration !== causal.connectionGeneration ||
        causal.lastAppliedReceiveSequence === null ||
        causal.lastAppliedReceiveSequence !== causal.receivedSequence ||
        causal.appliedMonotonicAtMs === null
      )
        return {
          status: 'NOT_EVALUABLE',
          reason: `AGG_TRADE_LOCAL_AGE_UNVERIFIED:${requirement.windowMs}`,
        };
      const ageMs = snapshot.capturedAtMonotonicMs - causal.appliedMonotonicAtMs;
      if (ageMs < 0 || ageMs > requirement.maximumAgeMs)
        return {
          status: 'NOT_EVALUABLE',
          reason: `AGG_TRADE_LOCAL_AGE_EXCEEDED:${requirement.windowMs}`,
        };
    }
    return { status: 'READY', reason: `AGG_TRADE_READY:${requirement.windowMs}` };
  }

  return {
    status: 'NOT_EVALUABLE',
    reason: `STRATEGY_MARKET_DATA_CAPABILITY_UNSUPPORTED:${requirement.kind}`,
  };
}

function intervalDurationMs(interval: string): number | undefined {
  const match = /^(\d+)([smhd])$/.exec(interval);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[
    match[2] as 's' | 'm' | 'h' | 'd'
  ];
  return Number.isSafeInteger(amount) && amount > 0 ? amount * unit : undefined;
}

function validCandle(candle: Candle, intervalMs: number): boolean {
  return (
    [
      candle.openTime,
      candle.closeTime,
      candle.open,
      candle.high,
      candle.low,
      candle.close,
      candle.volume,
    ].every(Number.isFinite) &&
    candle.openTime >= 0 &&
    candle.closeTime === candle.openTime + intervalMs - 1 &&
    candle.open > 0 &&
    candle.high >= Math.max(candle.open, candle.close, candle.low) &&
    candle.low <= Math.min(candle.open, candle.close, candle.high) &&
    candle.volume >= 0
  );
}

function copyOrderBookState(state: OrderBookState): OrderBookState {
  return {
    ...state,
    bids: state.bids.map((level) => ({ ...level })),
    asks: state.asks.map((level) => ({ ...level })),
    ...(state.localCausality ? { localCausality: { ...state.localCausality } } : {}),
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
