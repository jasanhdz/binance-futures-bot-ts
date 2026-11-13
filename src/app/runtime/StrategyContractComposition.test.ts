import { describe, expect, it, vi } from 'vitest';
import type { MarketDataPort } from '../ports/MarketData';
import type { Candle } from '../../core/types';
import type { Logger as AppLogger } from '../ports/Logger';
import { SharedMarketDataRuntime } from '../services/SharedMarketDataRuntime';
import {
  StrategyContractMarketDataProvisioner,
  type SharedStrategyMarketDataSnapshot,
} from '../services/StrategyContractMarketDataProvisioner';
import { StrategyRouter } from '../../core/strategy/StrategyRouter';
import { createUnfrozenStrategyIdentity } from '../../core/strategy/StrategyIdentity';
import type { StrategyDataRequirement } from '../../core/strategy/EntryStrategy';
import {
  LocalCausalSequence,
  processLocalCausalSequence,
} from '../../core/market-data/LocalCausalWatermark';
import {
  DeterministicProbeStrategy,
  type DeterministicProbeContext,
} from '../../testing/strategies/DeterministicProbeStrategy';

const BASE = 1_800_000_000_000;

interface HarnessOptions {
  readonly candleCount?: (interval: string, requested: number) => number;
  readonly candleGap?: (interval: string) => boolean;
  readonly failAggTradeSubscribe?: boolean;
  readonly stampDepth?: boolean;
  readonly failDepthSubscribe?: boolean;
}

function intervalMs(interval: string): number {
  const match = /^(\d+)([smhd])$/.exec(interval);
  if (!match) throw new Error(`TEST_INTERVAL_INVALID:${interval}`);
  const units = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  return Number(match[1]) * units[match[2] as keyof typeof units];
}

function candleFixture(interval: string, count: number, gap = false): Candle[] {
  const duration = intervalMs(interval);
  return Array.from({ length: count }, (_, index) => {
    const stride = gap ? 2 : 1;
    const closeTime = BASE - (count - 1 - index) * duration * stride;
    const openTime = closeTime - duration + 1;
    return {
      timestamp: openTime,
      openTime,
      closeTime,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
      volume: 10,
      buyVolume: 5,
    };
  });
}

function createHarness(options: HarnessOptions = {}) {
  let nowMs = BASE;
  const depthListeners = new Map<string, (event: any) => void>();
  const aggTradeListeners = new Map<string, (event: any) => void>();
  const aggTradeStatusListeners = new Map<
    string,
    (status: 'connecting' | 'open' | 'reconnecting') => void
  >();
  const candleListeners = new Map<string, (update: any) => void>();
  const subscriptions = { depth: 0, aggTrade: 0, candle: new Map<string, number>() };
  const unsubscriptions = { depth: 0, aggTrade: 0, candle: new Map<string, number>() };
  const exchange = {
    getServerTime: async () => nowMs,
    getCandles: async (_symbol: string, interval: string, requested: number) =>
      candleFixture(
        interval,
        options.candleCount?.(interval, requested) ?? requested,
        options.candleGap?.(interval) ?? false,
      ),
    getLastCandle: async () => null,
    getDepthSnapshot: async () => ({
      lastUpdateId: 100,
      bids: [['99.99', '100']] as [string, string][],
      asks: [['100.01', '100']] as [string, string][],
      receivedAtMs: nowMs,
    }),
    subscribeToDepthDiff: vi.fn(
      (symbol: string, _speed: '100ms' | '250ms' | '500ms', listener: (event: any) => void) => {
        subscriptions.depth++;
        if (options.failDepthSubscribe) throw new Error('SYNTHETIC_DEPTH_SUBSCRIBE_FAILURE');
        depthListeners.set(symbol, listener);
        return () => {
          unsubscriptions.depth++;
          depthListeners.delete(symbol);
        };
      },
    ),
    subscribeToAggTrades: vi.fn(
      (
        symbol: string,
        listener: (event: any) => void,
        onStatus?: (status: 'connecting' | 'open' | 'reconnecting') => void,
      ) => {
        subscriptions.aggTrade++;
        if (options.failAggTradeSubscribe) throw new Error('SYNTHETIC_AGG_TRADE_SUBSCRIBE_FAILURE');
        aggTradeListeners.set(symbol, listener);
        if (onStatus) aggTradeStatusListeners.set(symbol, onStatus);
        return () => {
          unsubscriptions.aggTrade++;
          aggTradeListeners.delete(symbol);
          aggTradeStatusListeners.delete(symbol);
        };
      },
    ),
    subscribeToKlineCandles: vi.fn(
      (symbol: string, interval: string, listener: (update: any) => void) => {
        const key = `${symbol}|${interval}`;
        subscriptions.candle.set(key, (subscriptions.candle.get(key) ?? 0) + 1);
        candleListeners.set(key, listener);
        return () => {
          unsubscriptions.candle.set(key, (unsubscriptions.candle.get(key) ?? 0) + 1);
          candleListeners.delete(key);
        };
      },
    ),
  } as unknown as MarketDataPort;
  const logger: AppLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const runtime = new SharedMarketDataRuntime({ exchange, logger, clock: { now: () => nowMs } });
  const provisioner = new StrategyContractMarketDataProvisioner(runtime, exchange, {
    now: () => nowMs,
  });
  const causal = processLocalCausalSequence();

  return {
    runtime,
    provisioner,
    exchange,
    subscriptions,
    unsubscriptions,
    setNow: (value: number) => {
      nowMs = value;
    },
    emitDepth: (symbol: string, connectionGeneration = 1) => {
      depthListeners.get(symbol)?.({
        U: 100,
        u: 101,
        pu: 99,
        bids: [['99.99', '100']],
        asks: [],
        E: nowMs,
        T: nowMs,
        receivedAtMs: nowMs,
        ...(options.stampDepth === false
          ? {}
          : { localCausality: causal.receive(connectionGeneration) }),
      });
    },
    emitTrades: (
      symbol: string,
      events: readonly { id: number; eventTime: number }[],
      connectionGeneration = 1,
      sequence = causal,
    ) => {
      const listener = aggTradeListeners.get(symbol);
      if (!listener) throw new Error(`TEST_AGG_TRADE_LISTENER_MISSING:${symbol}`);
      for (const { id, eventTime } of events)
        listener({
          eventTime,
          receivedAtMs: nowMs,
          price: 100,
          quantity: 1,
          isBuyerMaker: false,
          aggregateTradeId: id,
          firstTradeId: id,
          lastTradeId: id,
          localCausality: sequence.receive(connectionGeneration),
        });
    },
    reconnectAggTrades: (symbol: string) => {
      const status = aggTradeStatusListeners.get(symbol);
      if (!status) throw new Error(`TEST_AGG_TRADE_STATUS_MISSING:${symbol}`);
      status('connecting');
    },
    subscriptionsSnapshot: () => ({
      depth: subscriptions.depth,
      aggTrade: subscriptions.aggTrade,
      candles: Object.fromEntries(subscriptions.candle),
    }),
    unsubscriptionsSnapshot: () => ({
      depth: unsubscriptions.depth,
      aggTrade: unsubscriptions.aggTrade,
      candles: Object.fromEntries(unsubscriptions.candle),
    }),
  };
}

function requirements(
  overrides: {
    readonly candleInterval?: string;
    readonly candleLimit?: number;
    readonly minimumClosed?: number;
    readonly candleMaximumAgeMs?: number | null;
    readonly flowWindows?: readonly number[];
    readonly flowMaximumAgeMs?: number;
    readonly minimumDepthLevels?: number;
    readonly sequencePolicy?: 'REQUIRE_LINKED_UPDATES' | 'REQUIRE_HEALTHY_POINT';
  } = {},
): readonly StrategyDataRequirement[] {
  const candleInterval = overrides.candleInterval ?? '5m';
  const candleLimit = overrides.candleLimit ?? 1;
  const minimumClosed = overrides.minimumClosed ?? 1;
  const flowWindows = overrides.flowWindows ?? [5_000];
  return [
    {
      kind: 'ORDER_BOOK',
      minimumDepthLevels: overrides.minimumDepthLevels ?? 1,
      maximumAgeMs: 3_000,
      sequencePolicy: overrides.sequencePolicy ?? 'REQUIRE_HEALTHY_POINT',
    },
    ...flowWindows.map(
      (windowMs): StrategyDataRequirement => ({
        kind: 'AGG_TRADE_FLOW',
        windowMs,
        minimumObservedSamples: 1,
        maximumAgeMs: overrides.flowMaximumAgeMs ?? 3_000,
        continuityPolicy: 'REQUIRE_GAP_FREE',
      }),
    ),
    {
      kind: 'CLOSED_CANDLES',
      interval: candleInterval,
      limit: candleLimit,
      minimumClosed,
      maximumAgeMs: overrides.candleMaximumAgeMs ?? 300_000,
      gapPolicy: 'REJECT',
    },
  ];
}

function probeRouter(inputs = requirements()) {
  const identity = createUnfrozenStrategyIdentity(
    'TEST_PROBE',
    'contract-composition-only',
    'c'.repeat(40),
  );
  const strategy = new DeterministicProbeStrategy(identity, 'SHADOW', inputs);
  const router = new StrategyRouter<DeterministicProbeContext>();
  router.register(strategy);
  return { router, strategy };
}

function contextFromSnapshot(
  snapshot: SharedStrategyMarketDataSnapshot,
  outcome: DeterministicProbeContext['outcome'] = 'INTENT',
): DeterministicProbeContext & { readonly marketDataSnapshot: SharedStrategyMarketDataSnapshot } {
  const firstFlow = snapshot.aggTradeFlows[0]?.value;
  const candles = Object.values(snapshot.candles).flatMap((series) => series.candles);
  return {
    symbol: snapshot.symbol,
    timestamp: snapshot.capturedAtMs,
    bookHealth: snapshot.orderBook?.health ?? 'UNAVAILABLE',
    flowGapFree: snapshot.aggTradeFlows.every(
      ({ value }) => value.gapFree && value.windowComplete && value.confirmedGapCount === 0,
    ),
    candleCount: candles.filter((candle) => candle.closeTime <= snapshot.capturedAtMs).length,
    localCausalState: {
      depth: snapshot.orderBook?.localCausality ?? null,
      aggTrade: firstFlow?.localCausality ?? null,
    },
    marketDataSnapshot: snapshot,
    outcome,
    side: 'LONG',
  };
}

async function makeBookAndFlowReady(
  harness: ReturnType<typeof createHarness>,
  symbol: string,
  startId = 1,
) {
  await new Promise<void>((resolve) => setImmediate(resolve));
  harness.emitDepth(symbol);
  harness.emitTrades(symbol, [
    { id: startId, eventTime: BASE - 11_000 },
    { id: startId + 1, eventTime: BASE - 5_000 },
    { id: startId + 2, eventTime: BASE - 1 },
  ]);
}

describe('StrategyRuntimeContract shared-data composition (test-only consumer)', () => {
  it('does not subscribe at registration, then shares book/flow and interval-keyed candle leases across consumers', async () => {
    const harness = createHarness();
    const first = probeRouter(requirements());
    const secondInputs: StrategyDataRequirement[] = [
      ...requirements({ flowWindows: [10_000], candleInterval: '5m' }),
      {
        kind: 'CLOSED_CANDLES',
        interval: '1m',
        limit: 2,
        minimumClosed: 2,
        maximumAgeMs: 60_000,
        gapPolicy: 'REJECT',
      },
    ];
    const second = probeRouter(secondInputs);
    expect(harness.subscriptionsSnapshot()).toEqual({ depth: 0, aggTrade: 0, candles: {} });

    const firstLease = harness.provisioner.acquire(first.router.contract('TEST_PROBE')!, 'ethusdt');
    const secondLease = harness.provisioner.acquire(
      second.router.contract('TEST_PROBE')!,
      'ETHUSDT',
    );
    expect(harness.subscriptionsSnapshot()).toEqual({
      depth: 1,
      aggTrade: 1,
      candles: { 'ETHUSDT|5m': 1, 'ETHUSDT|1m': 1 },
    });
    expect(harness.runtime.orderBookDataPlane.getReferenceCount('ETHUSDT')).toBe(2);
    expect(harness.runtime.aggTradeDataPlane.getReferenceCount('ETHUSDT')).toBe(2);
    expect(harness.runtime.candleDataPlane.getReferenceCount('ETHUSDT', '5m')).toBe(2);

    await Promise.all([firstLease.warmup(), secondLease.warmup()]);
    await makeBookAndFlowReady(harness, 'ETHUSDT');
    const firstSnapshot = firstLease.read();
    const secondSnapshot = secondLease.read();
    expect(firstSnapshot.aggTradeFlows.map(({ windowMs }) => windowMs)).toEqual([5_000]);
    expect(secondSnapshot.aggTradeFlows.map(({ windowMs }) => windowMs)).toEqual([10_000]);
    expect(Object.keys(firstSnapshot.candles)).toEqual(['5m']);
    expect(Object.keys(secondSnapshot.candles).sort()).toEqual(['1m', '5m']);

    const firstEvaluation = vi.spyOn(first.strategy, 'evaluate');
    const secondEvaluation = vi.spyOn(second.strategy, 'evaluate');
    const firstReadiness = firstLease.assess(firstSnapshot);
    const secondReadiness = secondLease.assess(secondSnapshot);
    expect(firstReadiness.status).toBe('READY');
    expect(secondReadiness.status).toBe('READY');
    await first.router.evaluateWithReadiness('TEST_PROBE', firstReadiness, contextFromSnapshot);
    await second.router.evaluateWithReadiness('TEST_PROBE', secondReadiness, contextFromSnapshot);
    expect(firstEvaluation).toHaveBeenCalledOnce();
    expect(secondEvaluation).toHaveBeenCalledOnce();
    expect(firstEvaluation.mock.calls[0][0].marketDataSnapshot).toBe(firstSnapshot);
    expect(secondEvaluation.mock.calls[0][0].marketDataSnapshot).toBe(secondSnapshot);

    firstLease.release();
    firstLease.release();
    expect(harness.unsubscriptionsSnapshot()).toEqual({ depth: 0, aggTrade: 0, candles: {} });
    expect(harness.runtime.orderBookDataPlane.getReferenceCount('ETHUSDT')).toBe(1);
    expect(harness.runtime.aggTradeDataPlane.getReferenceCount('ETHUSDT')).toBe(1);
    expect(harness.runtime.candleDataPlane.getReferenceCount('ETHUSDT', '5m')).toBe(1);
    secondLease.release();
    secondLease.release();
    expect(harness.unsubscriptionsSnapshot()).toEqual({
      depth: 1,
      aggTrade: 1,
      candles: { 'ETHUSDT|5m': 1, 'ETHUSDT|1m': 1 },
    });
    harness.runtime.close();
  });

  it('returns WAIT during warmup without evaluating, then evaluates the exact verified snapshot', async () => {
    const harness = createHarness();
    const { router, strategy } = probeRouter();
    const evaluate = vi.spyOn(strategy, 'evaluate');
    const lease = harness.provisioner.acquire(router.contract('TEST_PROBE')!, 'ETHUSDT');
    const coldSnapshot = lease.read();
    const coldReadiness = lease.assess(coldSnapshot);
    expect(coldReadiness.status).toBe('WAIT');
    expect(coldReadiness.reasons).toContain('CANDLES_WARMUP_PENDING:5m');
    const waiting = await router.evaluateWithReadiness(
      'TEST_PROBE',
      coldReadiness,
      contextFromSnapshot,
    );
    expect(waiting).toMatchObject({ decision: 'NO_TRADE', evaluationStatus: 'WAIT' });
    expect(evaluate).not.toHaveBeenCalled();

    await lease.warmup();
    await makeBookAndFlowReady(harness, 'ETHUSDT');
    const readySnapshot = lease.read();
    const readyReadiness = lease.assess(readySnapshot);
    expect(readyReadiness.status).toBe('READY');
    const decision = await router.evaluateWithReadiness(
      'TEST_PROBE',
      readyReadiness,
      contextFromSnapshot,
    );
    expect(decision).toMatchObject({ decision: 'ENTRY_INTENT', evaluationStatus: 'INTENT' });
    expect(evaluate).toHaveBeenCalledOnce();
    expect(evaluate.mock.calls[0][0].marketDataSnapshot).toBe(readySnapshot);
    lease.release();
    harness.runtime.close();
  });

  it('changes provisioning and readiness when TEST_PROBE declares another interval and warmup depth', async () => {
    const harness = createHarness({
      candleCount: (interval, requested) => (interval === '1m' ? requested - 1 : requested),
    });
    const warmed1m = probeRouter(
      requirements({ candleInterval: '1m', candleLimit: 2, minimumClosed: 2 }),
    );
    const ordinary5m = probeRouter(requirements());
    const oneMinuteLease = harness.provisioner.acquire(
      warmed1m.router.contract('TEST_PROBE')!,
      'ETHUSDT',
    );
    const fiveMinuteLease = harness.provisioner.acquire(
      ordinary5m.router.contract('TEST_PROBE')!,
      'ETHUSDT',
    );
    await Promise.all([oneMinuteLease.warmup(), fiveMinuteLease.warmup()]);
    await makeBookAndFlowReady(harness, 'ETHUSDT');
    const oneMinuteSnapshot = oneMinuteLease.read();
    const fiveMinuteSnapshot = fiveMinuteLease.read();
    expect(Object.keys(oneMinuteSnapshot.candles)).toEqual(['1m']);
    expect(Object.keys(fiveMinuteSnapshot.candles)).toEqual(['5m']);
    expect(oneMinuteLease.assess(oneMinuteSnapshot)).toMatchObject({
      status: 'WAIT',
      reasons: expect.arrayContaining(['CANDLES_CLOSED_WARMUP_PENDING:1m']),
    });
    expect(fiveMinuteLease.assess(fiveMinuteSnapshot).status).toBe('READY');
    expect(harness.subscriptionsSnapshot()).toEqual({
      depth: 1,
      aggTrade: 1,
      candles: { 'ETHUSDT|1m': 1, 'ETHUSDT|5m': 1 },
    });
    oneMinuteLease.release();
    fiveMinuteLease.release();
    harness.runtime.close();
  });

  it('classifies old book, discontinuous flow, and gapped candles as NOT_EVALUABLE without evaluator calls', async () => {
    const staleHarness = createHarness();
    const staleProbe = probeRouter();
    const staleEvaluate = vi.spyOn(staleProbe.strategy, 'evaluate');
    const staleLease = staleHarness.provisioner.acquire(
      staleProbe.router.contract('TEST_PROBE')!,
      'ETHUSDT',
    );
    await staleLease.warmup();
    await makeBookAndFlowReady(staleHarness, 'ETHUSDT');
    staleHarness.setNow(BASE + 4_000);
    const staleReadiness = staleLease.assess(staleLease.read());
    expect(staleReadiness).toMatchObject({
      status: 'NOT_EVALUABLE',
      reasons: expect.arrayContaining(['ORDER_BOOK_STALE']),
    });
    await staleProbe.router.evaluateWithReadiness(
      'TEST_PROBE',
      staleReadiness,
      contextFromSnapshot,
    );
    expect(staleEvaluate).not.toHaveBeenCalled();
    staleLease.release();
    staleHarness.runtime.close();

    const gapHarness = createHarness();
    const gapProbe = probeRouter();
    const gapEvaluate = vi.spyOn(gapProbe.strategy, 'evaluate');
    const gapLease = gapHarness.provisioner.acquire(
      gapProbe.router.contract('TEST_PROBE')!,
      'ETHUSDT',
    );
    await gapLease.warmup();
    await new Promise<void>((resolve) => setImmediate(resolve));
    gapHarness.emitDepth('ETHUSDT');
    gapHarness.emitTrades('ETHUSDT', [
      { id: 1, eventTime: BASE - 5_000 },
      { id: 3, eventTime: BASE - 1 },
    ]);
    const gapReadiness = gapLease.assess(gapLease.read());
    expect(gapReadiness).toMatchObject({
      status: 'NOT_EVALUABLE',
      reasons: expect.arrayContaining(['AGG_TRADE_GAP:5000']),
    });
    await gapProbe.router.evaluateWithReadiness('TEST_PROBE', gapReadiness, contextFromSnapshot);
    expect(gapEvaluate).not.toHaveBeenCalled();
    gapLease.release();
    gapHarness.runtime.close();

    const candleHarness = createHarness({
      candleCount: (_interval, requested) => requested,
      candleGap: () => true,
    });
    const candleProbe = probeRouter(requirements({ candleLimit: 2, minimumClosed: 2 }));
    const candleEvaluate = vi.spyOn(candleProbe.strategy, 'evaluate');
    const candleLease = candleHarness.provisioner.acquire(
      candleProbe.router.contract('TEST_PROBE')!,
      'ETHUSDT',
    );
    await candleLease.warmup();
    await makeBookAndFlowReady(candleHarness, 'ETHUSDT');
    const candleReadiness = candleLease.assess(candleLease.read());
    expect(candleReadiness).toMatchObject({
      status: 'NOT_EVALUABLE',
      reasons: expect.arrayContaining(['CANDLES_GAP:5m']),
    });
    await candleProbe.router.evaluateWithReadiness(
      'TEST_PROBE',
      candleReadiness,
      contextFromSnapshot,
    );
    expect(candleEvaluate).not.toHaveBeenCalled();
    candleLease.release();
    candleHarness.runtime.close();
  });

  it('rejects unsupported and duplicate inputs before acquisition, and rolls back partial leases on source failure', () => {
    const unsupportedHarness = createHarness();
    const unsupportedProbe = probeRouter([
      ...requirements(),
      {
        kind: 'BENCHMARK_CONTEXT',
        benchmarkId: 'BTC',
        intervals: ['1m'],
        maximumAgeMs: 3_000,
      },
    ]);
    expect(() =>
      unsupportedHarness.provisioner.acquire(
        unsupportedProbe.router.contract('TEST_PROBE')!,
        'ETHUSDT',
      ),
    ).toThrow('STRATEGY_MARKET_DATA_CAPABILITY_UNSUPPORTED:BENCHMARK_CONTEXT');
    const duplicateProbe = probeRouter([...requirements(), requirements()[0]]);
    expect(() =>
      unsupportedHarness.provisioner.acquire(
        duplicateProbe.router.contract('TEST_PROBE')!,
        'ETHUSDT',
      ),
    ).toThrow('STRATEGY_MARKET_DATA_REQUIREMENT_DUPLICATE:ORDER_BOOK');
    const configuredProbe = probeRouter();
    const configuredContract = {
      ...configuredProbe.router.contract('TEST_PROBE')!,
      symbols: { source: 'CONFIGURATION' as const, values: ['BTCUSDT'] },
    };
    expect(() => unsupportedHarness.provisioner.acquire(configuredContract, 'ETHUSDT')).toThrow(
      'STRATEGY_MARKET_DATA_SYMBOL_NOT_AUTHORIZED:ETHUSDT',
    );
    expect(unsupportedHarness.subscriptionsSnapshot()).toEqual({
      depth: 0,
      aggTrade: 0,
      candles: {},
    });
    unsupportedHarness.runtime.close();

    const failingHarness = createHarness({ failAggTradeSubscribe: true });
    const failingProbe = probeRouter();
    expect(() =>
      failingHarness.provisioner.acquire(failingProbe.router.contract('TEST_PROBE')!, 'ETHUSDT'),
    ).toThrow('SYNTHETIC_AGG_TRADE_SUBSCRIBE_FAILURE');
    expect(failingHarness.runtime.orderBookDataPlane.getReferenceCount('ETHUSDT')).toBe(0);
    expect(failingHarness.runtime.aggTradeDataPlane.getReferenceCount('ETHUSDT')).toBe(0);
    expect(failingHarness.runtime.candleDataPlane.getReferenceCount('ETHUSDT', '5m')).toBe(0);
    expect(failingHarness.unsubscriptionsSnapshot().depth).toBe(1);
    failingHarness.runtime.close();

    const failedBookStartHarness = createHarness({ failDepthSubscribe: true });
    const failedBookProbe = probeRouter();
    expect(() =>
      failedBookStartHarness.provisioner.acquire(
        failedBookProbe.router.contract('TEST_PROBE')!,
        'ETHUSDT',
      ),
    ).toThrow('SYNTHETIC_DEPTH_SUBSCRIBE_FAILURE');
    expect(failedBookStartHarness.runtime.orderBookDataPlane.getReferenceCount('ETHUSDT')).toBe(0);
    failedBookStartHarness.runtime.close();
  });

  it('requires known depth and sequence evidence when those stronger contract requirements are declared', async () => {
    const depthHarness = createHarness();
    const depthProbe = probeRouter(requirements({ minimumDepthLevels: 2 }));
    const depthLease = depthHarness.provisioner.acquire(
      depthProbe.router.contract('TEST_PROBE')!,
      'ETHUSDT',
    );
    await depthLease.warmup();
    await makeBookAndFlowReady(depthHarness, 'ETHUSDT');
    const depthReadiness = depthLease.assess(depthLease.read());
    expect(depthReadiness).toMatchObject({
      status: 'NOT_EVALUABLE',
      reasons: expect.arrayContaining(['ORDER_BOOK_DEPTH_INSUFFICIENT']),
    });
    depthLease.release();
    depthHarness.runtime.close();

    const sequenceHarness = createHarness({ stampDepth: false });
    const sequenceProbe = probeRouter(requirements({ sequencePolicy: 'REQUIRE_LINKED_UPDATES' }));
    const sequenceLease = sequenceHarness.provisioner.acquire(
      sequenceProbe.router.contract('TEST_PROBE')!,
      'ETHUSDT',
    );
    await sequenceLease.warmup();
    await makeBookAndFlowReady(sequenceHarness, 'ETHUSDT');
    const sequenceReadiness = sequenceLease.assess(sequenceLease.read());
    expect(sequenceReadiness).toMatchObject({
      status: 'NOT_EVALUABLE',
      reasons: expect.arrayContaining(['ORDER_BOOK_LINKED_SEQUENCE_UNVERIFIED']),
    });
    sequenceLease.release();
    sequenceHarness.runtime.close();
  });

  it('requires a new full-window proof after reconnect and rejects another process generation', async () => {
    const harness = createHarness();
    const { router, strategy } = probeRouter();
    const evaluate = vi.spyOn(strategy, 'evaluate');
    const lease = harness.provisioner.acquire(router.contract('TEST_PROBE')!, 'ETHUSDT');
    await lease.warmup();
    await makeBookAndFlowReady(harness, 'ETHUSDT');
    expect(lease.assess(lease.read()).status).toBe('READY');

    harness.reconnectAggTrades('ETHUSDT');
    harness.emitTrades('ETHUSDT', [{ id: 1, eventTime: BASE - 10_000 }], 2);
    const reconnectReadiness = lease.assess(lease.read());
    expect(reconnectReadiness.status).toBe('WAIT');
    await router.evaluateWithReadiness('TEST_PROBE', reconnectReadiness, contextFromSnapshot);
    expect(evaluate).not.toHaveBeenCalled();

    harness.emitTrades(
      'ETHUSDT',
      [
        { id: 2, eventTime: BASE - 5_000 },
        { id: 3, eventTime: BASE - 1 },
      ],
      2,
    );
    const reconnectedReadiness = lease.assess(lease.read());
    expect(reconnectedReadiness.status).toBe('READY');

    lease.release();
    harness.runtime.close();

    // A stream watermark from another process cannot prove this process's local-monotonic age.
    const foreignHarness = createHarness();
    const foreignProbe = probeRouter();
    const foreignLease = foreignHarness.provisioner.acquire(
      foreignProbe.router.contract('TEST_PROBE')!,
      'ETHUSDT',
    );
    await foreignLease.warmup();
    await new Promise<void>((resolve) => setImmediate(resolve));
    foreignHarness.emitDepth('ETHUSDT');
    const foreign = new LocalCausalSequence('unrelated-process-generation');
    foreignHarness.emitTrades(
      'ETHUSDT',
      [
        { id: 1, eventTime: BASE - 11_000 },
        { id: 2, eventTime: BASE - 5_000 },
        { id: 3, eventTime: BASE - 1 },
      ],
      1,
      foreign,
    );
    const foreignReadiness = foreignLease.assess(foreignLease.read());
    expect(foreignReadiness).toMatchObject({
      status: 'NOT_EVALUABLE',
      reasons: expect.arrayContaining(['AGG_TRADE_LOCAL_AGE_UNVERIFIED:5000']),
    });
    foreignLease.release();
    foreignHarness.runtime.close();
  });
});
