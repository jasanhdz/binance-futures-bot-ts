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
import type { SharedMarketDataRuntime } from '../services/SharedMarketDataRuntime';
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

function runtimeHarness(): RuntimeHarness {
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
      exchange: {} as never,
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
      marketSnapshotSink: { append: vi.fn(async () => undefined) },
    },
    factories,
  );

  return { coordinator, events, momentumRouter, factories };
}

describe('StrategyRuntimeCoordinator', () => {
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
