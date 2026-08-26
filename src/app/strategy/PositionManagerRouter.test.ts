import { describe, expect, it } from 'vitest';
import { PositionManagerRouter } from './PositionManagerRouter';
import { createUnfrozenStrategyIdentity } from '../../domain/strategy/StrategyIdentity';

const momentumIdentity = createUnfrozenStrategyIdentity(
  'MOMENTUM_RIDE',
  'legacy-unfrozen',
  'test-sha',
);

describe('PositionManagerRouter', () => {
  it('routes only to the manager that owns the strategy id', async () => {
    const router = new PositionManagerRouter<{ tradeId: string }>();
    router.register({
      strategyId: 'MOMENTUM_RIDE',
      manage: (_identity, context) => ({
        tradeId: context.tradeId,
        decision: 'HOLD',
        reason: 'legacy_compatibility_hold',
        diagnostics: {},
      }),
    });

    const result = await router.route(momentumIdentity, { tradeId: 'trade-1' });

    expect(result.status).toBe('ROUTED');
    if (result.status === 'ROUTED') {
      expect(result.decision.identity.strategyId).toBe('MOMENTUM_RIDE');
      expect(result.decision.tradeId).toBe('trade-1');
    }
  });

  it('requires explicit recovery when ownership has no registered manager', async () => {
    const router = new PositionManagerRouter();

    const result = await router.route(momentumIdentity, {});

    expect(result).toEqual({
      status: 'RECOVERY_REQUIRED',
      strategyId: 'MOMENTUM_RIDE',
      reason: 'POSITION_MANAGER_NOT_REGISTERED',
    });
  });

  it('rejects duplicate manager ownership', () => {
    const router = new PositionManagerRouter();
    const manager = {
      strategyId: 'MOMENTUM_RIDE' as const,
      manage: () => ({
        tradeId: 'trade-1',
        decision: 'NO_ACTION' as const,
        reason: 'test',
        diagnostics: {},
      }),
    };

    router.register(manager);
    expect(() => router.register(manager)).toThrow(
      'POSITION_MANAGER_ALREADY_REGISTERED:MOMENTUM_RIDE',
    );
  });
});
