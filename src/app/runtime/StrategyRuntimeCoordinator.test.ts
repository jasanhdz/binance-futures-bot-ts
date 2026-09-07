import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { StrategyRouter } from '../../core/strategy/StrategyRouter';
import { createUnfrozenStrategyIdentity } from '../../core/strategy/StrategyIdentity';
import type { AegisBlackBoxObservation } from '../../strategies/aegis/application/AegisBlackBoxObservation';
import type { AegisRealtimeMarketState } from '../../strategies/aegis/application/AegisRealtimeMarketState';
import type { MicroBurstStrategyContext } from '../../strategies/micro-burst/domain/MicroBurstStrategy';
import type { MomentumRideBlackBoxObservation } from '../../strategies/momentum/application/MomentumRideBlackBoxObservation';
import type { MomentumCandleState } from '../../strategies/momentum/application/MomentumCandleState';
import type { MomentumRealtimeMarketState } from '../../strategies/momentum/application/MomentumRealtimeMarketState';
import type { MomentumRideStrategyContext } from '../../strategies/momentum/domain/MomentumRideStrategy';
import { SharedMarketDataRuntime } from '../services/SharedMarketDataRuntime';
import { SharedLiquidityState } from '../services/SharedLiquidityState';
import type { Exchange } from '../ports/Exchange';
import {
  StrategyRuntimeCoordinator,
  type StrategyRuntimeCoordinatorFactories,
} from './StrategyRuntimeCoordinator';

interface RuntimeHarness {
  coordinator: StrategyRuntimeCoordinator;
  events: string[];
  momentumRouter: StrategyRouter<MomentumRideStrategyContext>;
  factories: StrategyRuntimeCoordinatorFactories;
}

function runtimeHarness(exchange: Exchange = {} as never): RuntimeHarness {
  const events: string[] = [];
  const sharedMarketData = {
    close: vi.fn(() => events.push('shared-market-data:close')),
  } as unknown as SharedMarketDataRuntime;
  const aegisRealtime = {
    start: vi.fn(() => events.push('aegis-realtime:start')),
    close: vi.fn(() => events.push('aegis-realtime:close')),
    detectorFor: vi.fn(),
    read: vi.fn(),
    getCandles: vi.fn(() => []),
  } as unknown as AegisRealtimeMarketState;
  const momentumRealtime = {
    start: vi.fn(() => events.push('momentum-realtime:start')),
    close: vi.fn(() => events.push('momentum-realtime:close')),
    read: vi.fn(),
  } as unknown as MomentumRealtimeMarketState;
  const momentumCandles = {
    start: vi.fn(() => events.push('momentum-candles:start')),
    close: vi.fn(() => events.push('momentum-candles:close')),
    read: vi.fn(),
  } as unknown as MomentumCandleState;
  const aegisBlackBox = {
    start: vi.fn(() => events.push('aegis-blackbox:start')),
    close: vi.fn(() => events.push('aegis-blackbox:close')),
    capture: vi.fn(),
    observe: vi.fn(),
  } as unknown as AegisBlackBoxObservation;
  const momentumBlackBox = {
    start: vi.fn(() => events.push('momentum-blackbox:start')),
    close: vi.fn(() => events.push('momentum-blackbox:close')),
    beforeEvaluation: vi.fn(),
    afterEvaluation: vi.fn(),
  } as unknown as MomentumRideBlackBoxObservation;

  const factories: StrategyRuntimeCoordinatorFactories = {
    createSharedLiquidityState: vi.fn(
      () => ({ start: vi.fn(), close: vi.fn(), read: vi.fn() }) as never,
    ),
    createSharedMarketDataRuntime: vi.fn(() => sharedMarketData),
    createAegisRealtimeMarketState: vi.fn(() => aegisRealtime),
    createMomentumRealtimeMarketState: vi.fn(() => momentumRealtime),
    createMomentumCandleState: vi.fn(() => momentumCandles),
    createAegisBlackBoxObservation: vi.fn(() => aegisBlackBox),
    createMomentumBlackBoxObservation: vi.fn(() => momentumBlackBox),
  };

  const momentumRouter = new StrategyRouter<MomentumRideStrategyContext>();
  const setObservationHook = momentumRouter.setObservationHook.bind(momentumRouter);
  vi.spyOn(momentumRouter, 'setObservationHook').mockImplementation((hook) => {
    events.push(hook ? 'momentum-hook:attach' : 'momentum-hook:detach');
    setObservationHook(hook);
  });

  const coordinator = new StrategyRuntimeCoordinator(
    {
      exchange,
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      clock: { now: () => 1_700_000_000_000 },
      aegisIdentity: createUnfrozenStrategyIdentity('AEGIS_TURBO', 'test', 'test-sha'),
      momentumStrategyRouter: momentumRouter,
      microBurstStrategyRouter: new StrategyRouter<MicroBurstStrategyContext>(),
      decisionSink: { append: vi.fn(async () => undefined) },
      marketSnapshotSink: {
        append: vi.fn(async (snapshot) => ({
          snapshotId: snapshot.snapshotId,
          stored: true,
          contentHash: `content-hash:${snapshot.snapshotId}`,
        })),
      },
    },
    factories,
  );

  return { coordinator, events, momentumRouter, factories };
}

describe('StrategyRuntimeCoordinator', () => {
  it('feeds shared liquidity from the real synchronized plane with Aegis off and releases one shared stream', async () => {
    const now = 1_700_000_000_000;
    let emit: ((event: any) => void) | undefined;
    const unsubscribe = vi.fn();
    const exchange = {
      getDepthSnapshot: vi.fn(async () => ({
        lastUpdateId: 100,
        bids: Array.from({ length: 20 }, (_, i) => [String(100 - i), '10']),
        asks: Array.from({ length: 20 }, (_, i) => [String(101 + i), '10']),
        receivedAtMs: now,
      })),
      subscribeToDepthDiff: vi.fn((_symbol, _speed, callback) => {
        emit = callback;
        return unsubscribe;
      }),
      getServerTime: vi.fn(async () => now),
      getCandles: vi.fn(),
      subscribeToCandles: vi.fn(),
      subscribeToPartialDepth: vi.fn(),
    };
    const { coordinator, factories } = runtimeHarness(exchange as never);
    vi.mocked(factories.createSharedMarketDataRuntime).mockImplementation(
      (deps) => new SharedMarketDataRuntime(deps),
    );
    vi.mocked(factories.createSharedLiquidityState).mockImplementation(
      (deps) => new SharedLiquidityState(deps),
    );
    try {
      await coordinator.start({
        symbols: ['ETHUSDT'],
        aegisEnabled: false,
        momentumEnabled: true,
        microBurstConfig: { enabled: true, mode: 'LIVE', symbols: { ETHUSDT: { enabled: true } } },
        loadMicroBurstProvenance: () => {
          throw new Error('fixture: no journals');
        },
      });
      emit!({
        U: 100,
        u: 101,
        pu: 99,
        bids: [['100', '10']],
        asks: [],
        E: now,
        T: now,
        receivedAtMs: now,
      });
      await vi.waitFor(() =>
        expect(coordinator.readLiquidityStatus('ETHUSDT', now, 3_000)).toMatchObject({
          status: 'FRESH',
          stress: 0,
        }),
      );
      const shared = vi.mocked(factories.createSharedMarketDataRuntime).mock.results[0].value;
      const consumerLease = shared.orderBookDataPlane.acquire('ETHUSDT');
      expect(exchange.subscribeToDepthDiff).toHaveBeenCalledTimes(1);
      expect(exchange.getDepthSnapshot).toHaveBeenCalledTimes(1);
      consumerLease.release();
      expect(unsubscribe).not.toHaveBeenCalled();
      expect(coordinator.readLiquidityStatus('ETHUSDT', now + 3_001, 3_000)?.status).toBe('STALE');
      expect(factories.createAegisRealtimeMarketState).not.toHaveBeenCalled();
      expect(factories.createAegisBlackBoxObservation).not.toHaveBeenCalled();
      expect(exchange.getCandles).not.toHaveBeenCalled();
      expect(exchange.subscribeToCandles).not.toHaveBeenCalled();
      expect(exchange.subscribeToPartialDepth).not.toHaveBeenCalled();
    } finally {
      await coordinator.stop();
    }
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
  it.each(['micro', 'momentum'])(
    'starts shared liquidity for %s without constructing any Aegis producer',
    async (strategy) => {
      const { coordinator, factories } = runtimeHarness();
      await coordinator.start({
        symbols: ['ETHUSDT'],
        aegisEnabled: false,
        momentumEnabled: strategy === 'momentum',
        microBurstConfig: {
          enabled: strategy === 'micro',
          mode: 'LIVE',
          symbols: { BTCUSDT: { enabled: true }, SOLUSDT: { enabled: false } },
        },
        loadMicroBurstProvenance: () => {
          throw new Error('fixture: do not start Micro journals');
        },
      });
      const liquidity = vi.mocked(factories.createSharedLiquidityState).mock.results[0].value;
      expect(liquidity.start).toHaveBeenCalledWith([strategy === 'micro' ? 'BTCUSDT' : 'ETHUSDT']);
      expect(factories.createAegisRealtimeMarketState).not.toHaveBeenCalled();
      expect(factories.createAegisBlackBoxObservation).not.toHaveBeenCalled();
      await coordinator.stop();
      expect(liquidity.close).toHaveBeenCalledTimes(1);
    },
  );
  it('does not construct disabled strategy producers or caches', async () => {
    const { coordinator, factories, events } = runtimeHarness();
    await coordinator.start({
      symbols: ['ETHUSDT'],
      aegisEnabled: false,
      momentumEnabled: false,
      microBurstConfig: { enabled: false, mode: 'OFF', symbols: {} },
    });
    expect(events).toEqual([]);
    expect(factories.createAegisRealtimeMarketState).not.toHaveBeenCalled();
    expect(factories.createAegisBlackBoxObservation).not.toHaveBeenCalled();
    expect(factories.createMomentumRealtimeMarketState).not.toHaveBeenCalled();
    expect(factories.createMomentumCandleState).not.toHaveBeenCalled();
    expect(factories.createMomentumBlackBoxObservation).not.toHaveBeenCalled();
    expect(factories.createSharedLiquidityState).not.toHaveBeenCalled();
    expect(coordinator.getAegisCandles('ETHUSDT', 100)).toEqual([]);
    await coordinator.stop();
  });
  it('preserves runtime startup and shutdown order', async () => {
    const { coordinator, events, factories } = runtimeHarness();
    const symbols = ['ETHUSDT', 'BTCUSDT'];

    await coordinator.start({
      symbols,
      microBurstConfig: { enabled: false, mode: 'OFF', symbols: {} },
    });

    expect(events).toEqual([
      'aegis-realtime:start',
      'momentum-realtime:start',
      'momentum-candles:start',
      'aegis-blackbox:start',
      'momentum-blackbox:start',
      'momentum-hook:attach',
    ]);
    expect(factories.createAegisRealtimeMarketState).toHaveBeenCalledWith(
      expect.objectContaining({ sharedMarketData: expect.anything() }),
    );
    expect(factories.createMomentumRealtimeMarketState).toHaveBeenCalledWith(
      expect.objectContaining({ sharedMarketData: expect.anything() }),
    );

    events.length = 0;
    await coordinator.stop();

    expect(events).toEqual([
      'aegis-blackbox:close',
      'aegis-realtime:close',
      'momentum-hook:detach',
      'momentum-blackbox:close',
      'momentum-realtime:close',
      'momentum-candles:close',
      'shared-market-data:close',
    ]);
  });

  it('is safe to stop before startup', async () => {
    const { coordinator, events } = runtimeHarness();

    await expect(coordinator.stop()).resolves.toBeUndefined();

    expect(events).toEqual(['momentum-hook:detach']);
  });

  it('keeps Micro Burst startup failures isolated from the bot startup', async () => {
    const { coordinator } = runtimeHarness();

    await expect(
      coordinator.start({
        symbols: ['ETHUSDT'],
        microBurstConfig: {
          enabled: true,
          mode: 'SHADOW',
          symbols: { ETHUSDT: { enabled: true } },
        },
        loadMicroBurstProvenance: () => {
          throw new Error('invalid provenance');
        },
      }),
    ).resolves.toBeUndefined();

    expect(coordinator.getMicroBurstReadiness()).toMatchObject({
      ready: false,
      blockers: ['MICRO_BURST_RUNTIME_STARTUP_FAILED', 'NOT_READY'],
      liveExecution: false,
      liveAuthority: false,
    });
  });

  it('keeps concrete runtime construction out of TradingService', () => {
    const tradingService = readFileSync(
      resolve(__dirname, '../services/TradingService.ts'),
      'utf8',
    );

    expect(tradingService).not.toMatch(/new SharedMarketDataRuntime\(/);
    expect(tradingService).not.toMatch(/new AegisRealtimeMarketState\(/);
    expect(tradingService).not.toMatch(/new MomentumRealtimeMarketState\(/);
    expect(tradingService).not.toMatch(/new MomentumCandleState\(/);
    expect(tradingService).not.toMatch(/new MicroBurstRuntime\(/);
    expect(tradingService.match(/new StrategyRuntimeCoordinator\(/g) ?? []).toHaveLength(1);
  });

  it('keeps execution authority outside the runtime coordinator', () => {
    const coordinatorSource = readFileSync(
      resolve(__dirname, 'StrategyRuntimeCoordinator.ts'),
      'utf8',
    );

    expect(coordinatorSource).not.toContain('StrategyExecutionPort');
    expect(coordinatorSource).not.toContain('SharedStrategyExecutionService');
    expect(coordinatorSource).not.toMatch(/\.marketOpen\(/);
    expect(coordinatorSource).not.toMatch(/\.placeStopClose\(/);
    expect(coordinatorSource).not.toMatch(/\.placeTpClose\(/);
    expect(coordinatorSource).not.toMatch(/\.closeSideMarketSafe\(/);
  });
});
