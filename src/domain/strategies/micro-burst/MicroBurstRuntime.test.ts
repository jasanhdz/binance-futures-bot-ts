import { describe, expect, it, vi, beforeEach } from 'vitest';
import { MicroBurstRuntime, MicroBurstRuntimeDeps } from './MicroBurstRuntime';
import { MicroBurstRuntimeConfig } from './MicroBurstMarketDataTypes';
import { StrategyRouter } from '../../../app/strategy/StrategyRouter';
import { MicroBurstStrategyContext, MicroBurstStrategy } from './MicroBurstStrategy';
import { createMicroBurstV1Identity } from './MicroBurstIdentity';

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
      getSymbolFilters: async () => ({ tickSize: 0.01, stepSize: 0.001, pricePrecision: 2, qtyPrecision: 3, minNotional: 5 }),
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

  it('rejects LIVE mode at startup', async () => {
    const runtime = new MicroBurstRuntime(deps, makeConfig({ mode: 'LIVE' }));
    await expect(runtime.start()).rejects.toThrow('MICRO_BURST_V1_LIVE_NOT_AUTHORIZED');
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

  it('reports formal readiness only for an official shadow cohort with a healthy archive queue', async () => {
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
    const runtime = new MicroBurstRuntime(deps, makeConfig({
      prospectiveValidation: { enabled: true },
      marketArchive: { enabled: true },
    }));

    await runtime.start();

    expect(runtime.getReadiness()).toMatchObject({ ready: true, blockers: [], liveExecution: false });
    await runtime.stop();
    expect(flush).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('reports archive, live mode, and provenance blockers without enabling execution', async () => {
    const runtime = new MicroBurstRuntime(deps, makeConfig({ mode: 'LIVE' }));

    expect(runtime.getReadiness()).toMatchObject({
      ready: false,
      liveExecution: false,
      blockers: expect.arrayContaining([
        'LIVE_MODE_NOT_DISABLED',
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
    const originalMarketOpen = deps.exchange.marketOpen;
    deps.exchange.marketOpen = async (symbol: string, side: any, quantity: number) => {
      marketOpenCalls.push('called');
      return originalMarketOpen.call(deps.exchange, symbol, side, quantity);
    };
    deps.exchange.placeStopClose = async () => {
      placeStopCalls.push('called');
      return true;
    };
    deps.exchange.placeTpClose = async () => {
      placeTpCalls.push('called');
      return true;
    };
    deps.exchange.closeSideMarketSafe = async () => {
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
