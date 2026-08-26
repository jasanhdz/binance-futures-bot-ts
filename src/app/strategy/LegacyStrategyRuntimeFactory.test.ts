import { describe, expect, it } from 'vitest';
import { createUnfrozenStrategyIdentity } from '../../domain/strategy/StrategyIdentity';
import { createMomentumRideLegacyIdentity } from '../../domain/strategies/momentum-ride/MomentumRideIdentity';
import { createLegacyStrategyRuntime } from './LegacyStrategyRuntimeFactory';

const aegisIdentity = createUnfrozenStrategyIdentity('AEGIS_TURBO', 'legacy', 'aegis-sha');
const momentumIdentity = createMomentumRideLegacyIdentity();

describe('createLegacyStrategyRuntime', () => {
  it('registers Aegis and Momentum independently in both routers', () => {
    const runtime = createLegacyStrategyRuntime({
      aegis: {
        identity: aegisIdentity,
        mode: 'LIVE',
        evaluateEntry: () => ({
          symbol: 'BTCUSDT',
          timestamp: 1,
          decision: 'NO_TRADE',
          reason: 'test',
          diagnostics: {},
        }),
        managePosition: () => ({
          tradeId: 'aegis-1',
          decision: 'HOLD',
          reason: 'test',
          diagnostics: {},
        }),
      },
      momentum: {
        identity: momentumIdentity,
        mode: 'SHADOW',
        evaluateEntry: () => ({
          symbol: 'SUIUSDT',
          timestamp: 1,
          decision: 'NO_TRADE',
          reason: 'test',
          diagnostics: {},
        }),
        managePosition: () => ({
          tradeId: 'momentum-1',
          decision: 'HOLD',
          reason: 'test',
          diagnostics: {},
        }),
      },
    });

    expect(runtime.strategyRouter.has('AEGIS_TURBO')).toBe(true);
    expect(runtime.strategyRouter.has('MOMENTUM_RIDE')).toBe(true);
    expect(runtime.positionManagerRouter.has('AEGIS_TURBO')).toBe(true);
    expect(runtime.positionManagerRouter.has('MOMENTUM_RIDE')).toBe(true);
  });

  it('fails fast if bindings lie about ownership', () => {
    expect(() =>
      createLegacyStrategyRuntime({
        aegis: {
          identity: momentumIdentity,
          mode: 'OFF',
          evaluateEntry: () => ({
            symbol: 'SUIUSDT',
            timestamp: 1,
            decision: 'NO_TRADE',
            reason: 'test',
            diagnostics: {},
          }),
          managePosition: () => ({
            tradeId: 'x',
            decision: 'HOLD',
            reason: 'test',
            diagnostics: {},
          }),
        },
        momentum: {
          identity: momentumIdentity,
          mode: 'OFF',
          evaluateEntry: () => ({
            symbol: 'SUIUSDT',
            timestamp: 1,
            decision: 'NO_TRADE',
            reason: 'test',
            diagnostics: {},
          }),
          managePosition: () => ({
            tradeId: 'y',
            decision: 'HOLD',
            reason: 'test',
            diagnostics: {},
          }),
        },
      }),
    ).toThrow('AEGIS_BINDING_REQUIRES_AEGIS_TURBO_IDENTITY');
  });
});
