import { describe, expect, it, vi } from 'vitest';
import {
  LegacyEntryStrategyAdapter,
  LegacyPositionManagerAdapter,
} from './LegacyStrategyCompatibility';
import { createUnfrozenStrategyIdentity } from '../../domain/strategy/StrategyIdentity';

const aegisIdentity = createUnfrozenStrategyIdentity('AEGIS_TURBO', 'legacy-aegis', 'aegis-sha');
const momentumIdentity = createUnfrozenStrategyIdentity(
  'MOMENTUM_RIDE',
  'main-stacking-legacy',
  '3a6dbc330760aa8bf179be76c413623d7d50a420',
);

describe('LegacyStrategyCompatibility', () => {
  it('lets Aegis and Momentum use separate entry ownership over legacy evaluators', async () => {
    const evaluator = vi.fn(({ symbol }: { symbol: string }) => ({
      symbol,
      timestamp: 1,
      decision: 'NO_TRADE' as const,
      reason: 'legacy',
      diagnostics: {},
    }));

    const aegis = new LegacyEntryStrategyAdapter(aegisIdentity, 'SHADOW', evaluator);
    const momentum = new LegacyEntryStrategyAdapter(momentumIdentity, 'SHADOW', evaluator);

    expect(aegis.identity.strategyId).toBe('AEGIS_TURBO');
    expect(momentum.identity.strategyId).toBe('MOMENTUM_RIDE');
    await aegis.evaluate({ symbol: 'BTCUSDT' });
    await momentum.evaluate({ symbol: 'SUIUSDT' });
    expect(evaluator).toHaveBeenCalledTimes(2);
  });

  it('prevents a legacy position manager from taking another strategy ownership', () => {
    const evaluator = vi.fn(() => ({
      tradeId: 'trade-1',
      decision: 'HOLD' as const,
      reason: 'legacy_manage_position',
      diagnostics: {},
    }));
    const momentumManager = new LegacyPositionManagerAdapter('MOMENTUM_RIDE', evaluator);

    expect(() => momentumManager.manage(aegisIdentity, {})).toThrow(
      'LEGACY_POSITION_MANAGER_OWNERSHIP_MISMATCH:MOMENTUM_RIDE:AEGIS_TURBO',
    );
    expect(evaluator).not.toHaveBeenCalled();
  });

  it('permits the correct owner to delegate to legacy position management', async () => {
    const evaluator = vi.fn(() => ({
      tradeId: 'trade-1',
      decision: 'HOLD' as const,
      reason: 'legacy_manage_position',
      diagnostics: {},
    }));
    const momentumManager = new LegacyPositionManagerAdapter('MOMENTUM_RIDE', evaluator);

    const decision = await momentumManager.manage(momentumIdentity, {});

    expect(decision.reason).toBe('legacy_manage_position');
    expect(evaluator).toHaveBeenCalledOnce();
  });
});
