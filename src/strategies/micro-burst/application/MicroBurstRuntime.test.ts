import { describe, expect, it, vi, beforeEach } from 'vitest';
import { MicroBurstRuntime, MicroBurstRuntimeDeps } from './MicroBurstRuntime';
import type { MicroBurstRuntimeConfig } from './MicroBurstRuntimeTypes';
import { StrategyRouter } from '../../../core/strategy/StrategyRouter';
import { MicroBurstStrategyContext, MicroBurstStrategy } from '../domain/MicroBurstStrategy';
import { createMicroBurstV1Identity } from '../domain/MicroBurstIdentity';
import { Exchange } from '../../../app/ports/Exchange';
import { ShadowJournal } from '../../../core/shadow/ShadowTradeJournal';
import { ShadowPosition, ShadowTradeEvent } from '../../../core/shadow/ShadowTradingTypes';
import { CandleDataPlane } from '../../../core/market-data/CandleDataPlane';
import type { Candle } from '../../../core/types';

function makeConfig(overrides: Partial<MicroBurstRuntimeConfig> = {}): MicroBurstRuntimeConfig {
  return {
    enabled: true,
    mode: 'SHADOW',
    symbols: {
      ETHUSDT: { enabled: true },
      SOLUSDT: { enabled: true },
    },
    ...overrides,
  };
}

function makeDeps(): MicroBurstRuntimeDeps {
  const router = new StrategyRouter<MicroBurstStrategyContext>();
  router.register(new MicroBurstStrategy(createMicroBurstV1Identity(), 'SHADOW'));
  return {
    exchange: {
      getServerTime: async () => Date.now(),
      getCandles: async () => [],
      getLastCandle: async () => null,
      subscribeToCandles: () => () => {},
      getMarkPrice: async () => 0,
      getFundingRate: async () => ({ rate: 0 }),
      getBasisSnapshot: async () => ({ markPrice: 0, indexPrice: 0, basisPct: 0 }),
      readLiquidationPrice: async () => null,
      getUSDTBalance: async () => 100,
      setLeverage: async () => {},
      ensureMarginType: async () => {},
      getSymbolFilters: async () => ({
        tickSize: 0.01,
        stepSize: 0.001,
        pricePrecision: 2,
        qtyPrecision: 3,
        minNotional: 5,
      }),
      hasOpenPosition: async () => false,
      readActivePosition: async () => null,
      marketOpen: async () => ({ avgPrice: 0, orderId: '' }),
      placeStopClose: async () => true,
      placeTpClose: async () => true,
      closeSideMarketSafe: async () => {},
      openStopForSide: async () => null,
      listCloseOrdersForSide: async () => [],
      cancelOrderById: async () => {},
      getDepthSnapshot: async () => ({ lastUpdateId: 0, bids: [], asks: [] }),
      subscribeToAggTrades: () => () => {},
    } as any,
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    clock: { now: () => Date.now() },
    strategyRouter: router,
  };
}

class MemoryShadowJournal implements ShadowJournal {
  positions: ShadowPosition[] = [];
  events: ShadowTradeEvent[] = [];
  appendPosition(position: ShadowPosition): void {
    this.positions = [
      ...this.positions.filter((item) => item.tradeId !== position.tradeId),
      position,
    ];
  }
  appendEvent(event: ShadowTradeEvent): void {
    this.events.push(event);
  }
  loadOpenPositions(): ShadowPosition[] {
    return this.positions.filter((position) => position.state !== 'CLOSED');
  }
  loadAllPositions(): ShadowPosition[] {
    return this.positions;
  }
  loadAllEvents(): ShadowTradeEvent[] {
    return this.events;
  }
  getHealth(): { healthy: boolean; malformedCount: number } {
    return { healthy: true, malformedCount: 0 };
  }
  flush(): void {}
}

describe('MicroBurstRuntime', () => {
  let deps: MicroBurstRuntimeDeps;

  beforeEach(() => {
    deps = makeDeps();
  });

  it('starts and stops cleanly', async () => {
    const runtime = new MicroBurstRuntime(deps, makeConfig());
    await runtime.start();
    expect(runtime.getHealth().running).toBe(true);
    await runtime.stop();
    expect(runtime.getHealth().running).toBe(false);
  });

  it('uses shared candle snapshots without REST calls during evaluation', async () => {
    const exchangeGetCandles = vi.fn(async () => [] as Candle[]);
    (deps.exchange as any).getCandles = exchangeGetCandles;
    const now = Date.now();
    const fetch = vi.fn(async (_symbol: string, interval: string, limit: number) => {
      const duration = interval === '1m' ? 60_000 : interval === '3m' ? 180_000 : 300_000;
      return Array.from({ length: limit }, (_, index) => {
        const openTime = now - (limit - index) * duration;
        return {
          openTime,
          timestamp: openTime,
          open: 99,
          high: 101,
          low: 98,
          close: 100,
          volume: 10,
          buyVolume: 6,
          closeTime: openTime + duration - 1,
        };
      });
    });
    deps.candleDataPlane = new CandleDataPlane({
      clock: { now: () => now },
      fetch,
      subscribe: () => () => {},
    });
    const runtime = new MicroBurstRuntime(deps, makeConfig());

    await runtime.start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    exchangeGetCandles.mockClear();
    await runtime.evaluateSymbol('ETHUSDT', now);

    expect(exchangeGetCandles).not.toHaveBeenCalled();
    expect(runtime.getHealth().symbolMetrics.ETHUSDT).toMatchObject({
      candleCacheHit: 3,
      candleUnavailable: 0,
      candleStale: 0,
      latestSlowStatePublished: 1,
    });
    await runtime.stop();
  });

  it('double start is idempotent', async () => {
    const runtime = new MicroBurstRuntime(deps, makeConfig());
    await runtime.start();
    await runtime.start();
    expect(runtime.getHealth().running).toBe(true);
    await runtime.stop();
  });

  it('double stop is idempotent', async () => {
    const runtime = new MicroBurstRuntime(deps, makeConfig());
    await runtime.start();
    await runtime.stop();
    await runtime.stop();
    expect(runtime.getHealth().running).toBe(false);
  });

  it('attempts market storage drain when an earlier durable sink fails', async () => {
    const flush = vi.fn(async () => true);
    const close = vi.fn(async () => {});
    deps.outcomeTracker = {
      trackSignal: () => {},
      observeTradeEvent: () => {},
      flushPending: () => {
        throw new Error('outcome flush failed');
      },
      getHealth: () => ({
        signalsObserved: 0,
        pendingOutcomes: 0,
        completedOutcomes: 0,
        outcomeErrors: 0,
      }),
    };
    deps.marketStorage = {
      appendDepth: () => true,
      persistCheckpoint: () => true,
      flush,
      close,
      getHealth: () => ({ healthy: true, errorCount: 0 }),
    };
    const runtime = new MicroBurstRuntime(deps, makeConfig({ marketArchive: { enabled: true } }));

    await runtime.start();
    await expect(runtime.stop()).rejects.toThrow('MICRO_BURST_RUNTIME_SHUTDOWN_FAILED');
    expect(flush).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes agg-trades on stop before a restart subscribes again', async () => {
    const unsubscribe = vi.fn();
    deps.exchange.subscribeToAggTrades = vi.fn(() => unsubscribe);
    const runtime = new MicroBurstRuntime(deps, makeConfig());

    await runtime.start();
    await runtime.stop();
    await runtime.start();

    expect(unsubscribe).toHaveBeenCalledTimes(2);
    expect(deps.exchange.subscribeToAggTrades).toHaveBeenCalledTimes(4);
    await runtime.stop();
    expect(unsubscribe).toHaveBeenCalledTimes(4);
  });

  it('keeps AggTrade qualification uncertain through reconnect warmup', async () => {
    const start = 1_700_000_000_000;
    const callbacks: Record<string, (trade: any) => void> = {};
    const statuses: Record<string, (value: 'connecting' | 'open' | 'reconnecting') => void> = {};
    deps.exchange.subscribeToAggTrades = vi.fn((symbol, next, onStatus) => {
      callbacks[symbol] = next;
      statuses[symbol] = onStatus!;
      return () => {};
    });
    const runtime = new MicroBurstRuntime(deps, makeConfig());
    await runtime.start();
    callbacks.ETHUSDT({
      eventTime: start,
      price: '100',
      quantity: '1',
      isBuyerMaker: false,
      aggregateTradeId: 10,
    });
    callbacks.ETHUSDT({
      eventTime: start + 300_000,
      price: '100',
      quantity: '1',
      isBuyerMaker: false,
      aggregateTradeId: 11,
    });
    expect(
      runtime.getSymbolStates().get('ETHUSDT')!.aggTradeBuffer.getTakerFlow().windowComplete,
    ).toBe(true);

    statuses.ETHUSDT('reconnecting');
    expect(
      runtime.getSymbolStates().get('ETHUSDT')!.aggTradeBuffer.getTakerFlow().windowComplete,
    ).toBe(false);
    statuses.ETHUSDT('open');
    callbacks.ETHUSDT({
      eventTime: start + 301_000,
      price: '100',
      quantity: '1',
      isBuyerMaker: false,
      aggregateTradeId: 12,
    });
    expect(
      runtime.getSymbolStates().get('ETHUSDT')!.aggTradeBuffer.getTakerFlow().windowComplete,
    ).toBe(false);
    callbacks.ETHUSDT({
      eventTime: start + 601_001,
      price: '100',
      quantity: '1',
      isBuyerMaker: false,
      aggregateTradeId: 13,
    });
    expect(runtime.getSymbolStates().get('ETHUSDT')!.aggTradeBuffer.getTakerFlow()).toMatchObject({
      windowComplete: true,
      gapFree: true,
    });
    await runtime.stop();
  });

  it('persists typed AggTrade sequence gaps from the production callback', async () => {
    let callback: ((trade: any) => void) | undefined;
    const recordGap = vi.fn(() => true);
    deps.exchange.subscribeToAggTrades = vi.fn((_symbol, next) => {
      callback = next;
      return () => {};
    });
    deps.marketStorage = {
      appendDepth: () => true,
      appendTrade: () => true,
      recordGap,
      hasAggTradeGap: () => false,
      persistCheckpoint: () => true,
      getHealth: () => ({ healthy: true, errorCount: 0, queueDepth: 0, queueCapacity: 10 }),
    };
    const runtime = new MicroBurstRuntime(deps, makeConfig({ marketArchive: { enabled: true } }));
    await runtime.start();
    callback!({
      eventTime: 1_000,
      receivedAtMs: 1_001,
      price: '100',
      quantity: '1',
      isBuyerMaker: false,
      aggregateTradeId: 10,
      firstTradeId: 10,
      lastTradeId: 10,
    });
    callback!({
      eventTime: 2_000,
      receivedAtMs: 2_001,
      price: '100',
      quantity: '1',
      isBuyerMaker: false,
      aggregateTradeId: 12,
      firstTradeId: 12,
      lastTradeId: 12,
    });
    callback!({
      eventTime: 2_001,
      receivedAtMs: 2_002,
      price: '100',
      quantity: '1',
      isBuyerMaker: false,
      aggregateTradeId: 14,
      firstTradeId: 14,
      lastTradeId: 14,
    });
    expect(recordGap).toHaveBeenCalledWith(
      expect.objectContaining({
        feed: 'AGG_TRADE',
        kind: 'AGG_TRADE_SEQUENCE',
        previousAggregateTradeId: 10,
        nextAggregateTradeId: 12,
        startedAtMs: 1_000,
        endedAtMs: 2_000,
      }),
    );
    await runtime.stop();
  });

  it('archives each runtime trade once and observes it without tracker archival', async () => {
    let callback: ((trade: any) => void) | undefined;
    const appendTrade = vi.fn(() => true);
    const observeTradeEvent = vi.fn();
    deps.exchange.subscribeToAggTrades = vi.fn((_symbol, next) => {
      callback = next;
      return () => {};
    });
    deps.marketStorage = {
      appendDepth: () => true,
      appendTrade,
      persistCheckpoint: () => true,
      getHealth: () => ({ healthy: true, errorCount: 0 }),
    };
    deps.outcomeTracker = {
      trackSignal: () => {},
      observeTradeEvent,
      flushPending: () => {},
      getHealth: () => ({
        signalsObserved: 0,
        pendingOutcomes: 0,
        completedOutcomes: 0,
        outcomeErrors: 0,
      }),
    };
    const runtime = new MicroBurstRuntime(deps, makeConfig({ marketArchive: { enabled: true } }));
    await runtime.start();
    callback!({ eventTime: 1_000, price: '100', quantity: '1', isBuyerMaker: false });

    expect(appendTrade).toHaveBeenCalledTimes(1);
    expect(observeTradeEvent).toHaveBeenCalledTimes(1);
    await runtime.stop();
  });

  it('does not start when mode is OFF', async () => {
    const runtime = new MicroBurstRuntime(deps, makeConfig({ mode: 'OFF' }));
    await runtime.start();
    expect(runtime.getHealth().running).toBe(false);
    expect(runtime.getHealth().symbolCount).toBe(0);
  });

  it('does not start when enabled is false', async () => {
    const runtime = new MicroBurstRuntime(deps, makeConfig({ enabled: false }));
    await runtime.start();
    expect(runtime.getHealth().running).toBe(false);
  });

  it('does not become running when no symbols are enabled', async () => {
    const runtime = new MicroBurstRuntime(deps, makeConfig({ symbols: {} }));
    await runtime.start();
    expect(runtime.getHealth().running).toBe(false);
    expect(runtime.getHealth().symbolCount).toBe(0);
  });

  it('rejects LIVE mode without an execution port', async () => {
    const runtime = new MicroBurstRuntime(deps, makeConfig({ mode: 'LIVE' }));
    await expect(runtime.start()).rejects.toThrow('MICRO_BURST_V1_LIVE_EXECUTION_PORT_REQUIRED');
    expect(runtime.getReadiness()).toMatchObject({
      ready: false,
      blockers: expect.arrayContaining(['RUNTIME_NOT_RUNNING']),
    });
  });

  it('routes a LIVE entry through the explicit execution port without opening paper state', async () => {
    const open = vi.fn(async () => true);
    deps.liveTrading = { open };
    const shadowJournal = new MemoryShadowJournal();
    deps.shadowTradeJournal = shadowJournal;
    const runtime = new MicroBurstRuntime(
      deps,
      makeConfig({ mode: 'LIVE', symbols: { ETHUSDT: { enabled: true } } }),
    );
    await runtime.start();
    (runtime as any).shadowEvaluator = {
      evaluate: async () => ({
        strategyId: 'MICRO_BURST_V1',
        strategyVersion: '0.8.0-expected-continuation-shadow',
        symbol: 'ETHUSDT',
        snapshotAtMs: 1_000,
        decision: 'ENTRY_INTENT',
        side: 'LONG',
        confidence: 0.9,
        referencePrice: 100,
        supportPrice: 99,
        resistancePrice: 110,
        structuralInvalidation: 99,
        destinationPrice: 102,
        roomToTargetBps: 200,
        riskToInvalidationBps: 100,
        rewardRisk: 2,
        momentum: { direction: 'LONG', strength: 0.9, continuationScore: 0.9 },
        book: { status: 'HEALTHY', ageMs: 1, imbalance: 0.3, imbalanceSlope: null },
        btc: { status: 'HEALTHY', ageMs: 1, ret1m: 0, ret3m: 0, ret5m: 0, conflict: false },
        microRegime: 'RANGING',
        dataQuality: { contextValid: true, invalidReasons: [] },
        wouldEnter: true,
        liveExecution: true,
        shadowSignalId: 'live-signal',
        duplicateSuppressed: false,
        firstObservedAt: 1_000,
        lastObservedAt: 1_000,
        diagnostics: { leverage: 20, positionFraction: 0.05 },
      }),
    };

    await runtime.evaluateSymbol('ETHUSDT');

    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: 'ETHUSDT',
        side: 'LONG',
        signalId: 'live-signal',
        leverage: 20,
        positionFraction: 0.05,
        structuralStopPrice: 99,
        destinationPrice: 102,
      }),
    );
    expect(shadowJournal.positions).toHaveLength(0);
    expect(runtime.getHealth().liveExecution).toBe(true);
    await runtime.stop();
  });

  it('reports health with correct symbol count', async () => {
    const runtime = new MicroBurstRuntime(deps, makeConfig());
    await runtime.start();
    const health = runtime.getHealth();
    expect(health.symbolCount).toBe(2);
    expect(health.running).toBe(true);
    expect(health.liveExecution).toBe(false);
    await runtime.stop();
  });

  it('uses fresh aggregate-trade event time for LIVE exit observations', async () => {
    let now = 10_000;
    deps.clock = { now: () => now };
    const runtime = new MicroBurstRuntime(deps, makeConfig());
    await runtime.start();
    const buffer = (runtime as any).symbolStates.get('ETHUSDT').aggTradeBuffer;
    buffer.push({
      eventTime: 8_500,
      receivedAtMs: 8_600,
      price: 99,
      quantity: 10,
      isBuyerMaker: true,
      aggregateTradeId: 1,
    });
    buffer.push({
      eventTime: 9_000,
      receivedAtMs: 9_100,
      price: 101,
      quantity: 1,
      isBuyerMaker: false,
      aggregateTradeId: 2,
    });

    expect(runtime.readExitMarketSnapshot('ETHUSDT', 8_750)).toMatchObject({
      currentPrice: 101,
      observedAtMs: 9_000,
      marketEvidence: {
        priceSampleCount: 1,
        buyTakerVolume: 1,
        sellTakerVolume: 0,
        takerTradeCount: 1,
        takerFlowWindowComplete: false,
      },
    });
    now = 14_001;
    expect(runtime.readExitMarketSnapshot('ETHUSDT')).toBeNull();
    await runtime.stop();
  });

  it('uses the generic engine for one managed lifecycle without legacy paper writes', async () => {
    const shadowJournal = new MemoryShadowJournal();
    const callbacks: Record<string, (trade: any) => void> = {};
    deps.shadowTradeJournal = shadowJournal;
    deps.exchange.subscribeToAggTrades = vi.fn((symbol: string, callback: (trade: any) => void) => {
      callbacks[symbol] = callback;
      return () => {};
    });
    const runtime = new MicroBurstRuntime(
      deps,
      makeConfig({ symbols: { ETHUSDT: { enabled: true }, SOLUSDT: { enabled: false } } }),
    );
    await runtime.start();
    (runtime as any).symbolStates.get('ETHUSDT').book.getSnapshot = () => ({
      bidDepth: [{ price: 99, qty: 1 }],
      askDepth: [{ price: 101, qty: 1 }],
      observedAtMs: 1_000,
      status: 'HEALTHY',
      temporalHistory: [],
    });
    const result = {
      strategyId: 'MICRO_BURST_V1',
      strategyVersion: 'golden',
      symbol: 'ETHUSDT',
      snapshotAtMs: 1_000,
      decision: 'ENTRY_INTENT',
      side: 'LONG',
      confidence: 0.9,
      referencePrice: 100,
      supportPrice: 99,
      resistancePrice: 110,
      structuralInvalidation: 90,
      destinationPrice: 102,
      roomToTargetBps: 200,
      riskToInvalidationBps: 1_000,
      rewardRisk: 2,
      momentum: { direction: 'LONG', strength: 0.9, continuationScore: 0.9 },
      book: { status: 'HEALTHY', ageMs: 1, imbalance: 0.3, imbalanceSlope: null },
      btc: { status: 'HEALTHY', ageMs: 1, ret1m: 0, ret3m: 0, ret5m: 0, conflict: false },
      microRegime: 'RANGING',
      dataQuality: { contextValid: true, invalidReasons: [] },
      wouldEnter: true,
      liveExecution: false,
      shadowSignalId: 'runtime-golden',
      duplicateSuppressed: false,
      firstObservedAt: 1_000,
      lastObservedAt: 1_000,
      diagnostics: { leverage: 20, positionFraction: 0.05 },
    };
    (runtime as any).shadowEvaluator = { evaluate: async () => result };
    const evaluated = await runtime.evaluateSymbol('ETHUSDT');
    expect(evaluated?.wouldEnter).toBe(true);
    expect(shadowJournal.positions).toHaveLength(1);
    expect(shadowJournal.positions[0].schemaVersion).toBe(2);
    expect(shadowJournal.positions[0].strategyId).toBe('MICRO_BURST_V1');
    expect(shadowJournal.events.some((event) => event.event === 'OPENED')).toBe(true);
    expect(runtime.getHealth().paperEngine).toBe('GENERIC');
    callbacks.ETHUSDT({
      eventTime: 2_000,
      receivedAtMs: 2_000,
      price: 102,
      quantity: 1,
      isBuyerMaker: false,
    });
    expect(shadowJournal.positions[shadowJournal.positions.length - 1]?.state).toBe('CLOSED');
    await runtime.stop();
  });

  it('does not report a future BTC receive timestamp as healthy', async () => {
    let now = 1_000;
    deps.clock = { now: () => now };
    const runtime = new MicroBurstRuntime(deps, makeConfig());
    await runtime.start();
    (runtime as any).btcProvider = {
      getBtcContext: () => ({ receivedAtMs: 2_000 }),
      stop: vi.fn(),
    };

    expect(runtime.getHealth().btcHealthy).toBe(false);
    now = 2_001;
    expect(runtime.getHealth().btcHealthy).toBe(true);
    await runtime.stop();
  });

  it('emits final archive queue evidence after graceful shutdown', async () => {
    const info = vi.fn();
    deps.logger.info = info;
    deps.marketStorage = {
      appendDepth: () => true,
      persistCheckpoint: () => true,
      flush: async () => true,
      close: async () => {},
      getHealth: () => ({
        healthy: true,
        errorCount: 0,
        queueDepth: 0,
        queueCapacity: 10,
        queuedRecords: 4,
        writtenRecords: 4,
        overflowRecords: 0,
      }),
    };
    const runtime = new MicroBurstRuntime(deps, makeConfig({ marketArchive: { enabled: true } }));

    await runtime.start();
    await runtime.stop();

    expect(info).toHaveBeenCalledWith(
      'MICRO_BURST_SHADOW_HEALTH',
      expect.objectContaining({
        phase: 'graceful_shutdown',
        archiveQueueDepth: 0,
        archiveQueuedRecords: 4,
        archiveWrittenRecords: 4,
        archiveOverflowRecords: 0,
        archiveBytes: null,
        archiveFileCount: null,
        archiveRetentionAgeMs: null,
        archiveRetentionWarning: null,
      }),
    );
  });

  it('fails closed until every official readiness evidence source is present', async () => {
    const flush = vi.fn(async () => true);
    const close = vi.fn(async () => {});
    deps.marketStorage = {
      appendDepth: () => true,
      persistCheckpoint: () => true,
      flush,
      close,
      getHealth: () => ({ healthy: true, errorCount: 0, queueDepth: 0, queueCapacity: 10 }),
    };
    deps.provenance = {
      codeCommitSha: 'abc123',
      configHash: 'def456',
      cohortId: 'MBV1-M3_2-abc123-def456',
      officialCohortReady: true,
    };
    const runtime = new MicroBurstRuntime(
      deps,
      makeConfig({
        prospectiveValidation: { enabled: true },
        marketArchive: { enabled: true },
      }),
    );

    await runtime.start();

    expect(runtime.getReadiness()).toMatchObject({
      ready: false,
      blockers: expect.arrayContaining(['MANIFEST_NOT_READY', 'BOOKS_NOT_READY', 'COST_NOT_READY']),
      official: false,
      liveAuthority: false,
      liveExecution: false,
    });
    await runtime.stop();
    expect(flush).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('reports archive and provenance blockers before LIVE runtime startup', async () => {
    const runtime = new MicroBurstRuntime(deps, makeConfig({ mode: 'LIVE' }));

    expect(runtime.getReadiness()).toMatchObject({
      ready: false,
      liveExecution: false,
      blockers: expect.arrayContaining([
        'PROSPECTIVE_VALIDATION_DISABLED',
        'MARKET_ARCHIVE_DISABLED',
        'MARKET_ARCHIVE_UNAVAILABLE',
        'CODE_COMMIT_SHA_UNKNOWN',
        'COHORT_NAMESPACE_INVALID',
      ]),
    });
  });

  it('evaluateSymbol returns null when runtime is not running', async () => {
    const runtime = new MicroBurstRuntime(deps, makeConfig());
    const result = await runtime.evaluateSymbol('ETHUSDT');
    expect(result).toBeNull();
  });

  it('evaluateSymbol returns null for unknown symbol', async () => {
    const runtime = new MicroBurstRuntime(deps, makeConfig());
    await runtime.start();
    const result = await runtime.evaluateSymbol('UNKNOWN');
    expect(result).toBeNull();
    await runtime.stop();
  });

  it('getSymbolHealth returns null for unknown symbol', async () => {
    const runtime = new MicroBurstRuntime(deps, makeConfig());
    await runtime.start();
    const health = runtime.getSymbolHealth('UNKNOWN');
    expect(health).toBeNull();
    await runtime.stop();
  });

  it('getSymbolHealth returns valid data for known symbol', async () => {
    const runtime = new MicroBurstRuntime(deps, makeConfig());
    await runtime.start();
    const health = runtime.getSymbolHealth('ETHUSDT');
    expect(health).not.toBeNull();
    expect(health!.bookStatus).toBeDefined();
    expect(health!.evaluationCount).toBe(0);
    await runtime.stop();
  });

  it('does not create subscriptions for disabled symbols', async () => {
    const config = makeConfig({
      symbols: {
        ETHUSDT: { enabled: true },
        SOLUSDT: { enabled: false },
      },
    });
    const runtime = new MicroBurstRuntime(deps, config);
    await runtime.start();
    const health = runtime.getHealth();
    expect(health.symbolCount).toBe(1);
    await runtime.stop();
  });

  it('stops cleanup clears all resources', async () => {
    const runtime = new MicroBurstRuntime(deps, makeConfig());
    await runtime.start();
    await runtime.stop();
    expect(runtime.getHealth().symbolCount).toBe(0);
  });
});

describe('MicroBurstRuntime exchange mutation firewall', () => {
  it('100 evaluations produce zero exchange mutations', async () => {
    const marketOpenCalls: string[] = [];
    const placeStopCalls: string[] = [];
    const placeTpCalls: string[] = [];
    const closeCalls: string[] = [];
    const executeCalls: string[] = [];

    const deps = makeDeps();
    const mutationCapableExchange = deps.exchange as Exchange;
    const originalMarketOpen = mutationCapableExchange.marketOpen;
    mutationCapableExchange.marketOpen = async (symbol: string, side: any, quantity: number) => {
      marketOpenCalls.push('called');
      return originalMarketOpen.call(mutationCapableExchange, symbol, side, quantity);
    };
    mutationCapableExchange.placeStopClose = async () => {
      placeStopCalls.push('called');
      return true;
    };
    mutationCapableExchange.placeTpClose = async () => {
      placeTpCalls.push('called');
      return true;
    };
    mutationCapableExchange.closeSideMarketSafe = async () => {
      closeCalls.push('called');
    };

    const router = new StrategyRouter<MicroBurstStrategyContext>();
    router.register(new MicroBurstStrategy(createMicroBurstV1Identity(), 'SHADOW'));
    deps.strategyRouter = router;

    const runtime = new MicroBurstRuntime(deps, makeConfig());
    await runtime.start();

    for (let i = 0; i < 100; i++) {
      await runtime.evaluateSymbol('ETHUSDT');
    }

    expect(marketOpenCalls).toHaveLength(0);
    expect(placeStopCalls).toHaveLength(0);
    expect(placeTpCalls).toHaveLength(0);
    expect(closeCalls).toHaveLength(0);
    expect(executeCalls).toHaveLength(0);

    await runtime.stop();
  });
});
