import { describe, expect, it, vi } from 'vitest';
import { StrategyRouter } from './StrategyRouter';
import { createUnfrozenStrategyIdentity } from './StrategyIdentity';

const identity = createUnfrozenStrategyIdentity('MOMENTUM_RIDE', 'legacy-unfrozen', 'test-sha');

describe('StrategyRouter', () => {
  it('does not evaluate an OFF strategy', async () => {
    const evaluate = vi.fn();
    const router = new StrategyRouter<{ symbol: string }>();
    router.register({ identity, mode: 'OFF', evaluate });

    const result = await router.evaluate('MOMENTUM_RIDE', { symbol: 'SUIUSDT' });

    expect(evaluate).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      mode: 'OFF',
      symbol: 'SUIUSDT',
      decision: 'NO_TRADE',
      reason: 'strategy_off',
    });
  });

  it('preserves SHADOW mode while evaluating diagnostics', async () => {
    const router = new StrategyRouter<{ symbol: string }>();
    router.register({
      identity,
      mode: 'SHADOW',
      evaluate: ({ symbol }) => ({
        symbol,
        timestamp: 123,
        decision: 'ENTRY_INTENT',
        side: 'SHORT',
        reason: 'confirmed',
        diagnostics: { source: 'test' },
      }),
    });

    const result = await router.evaluate('MOMENTUM_RIDE', { symbol: 'SUIUSDT' });

    expect(result.mode).toBe('SHADOW');
    expect(result.identity.strategyId).toBe('MOMENTUM_RIDE');
    expect(result.decision).toBe('ENTRY_INTENT');
  });

  it('rejects duplicate strategy ownership', () => {
    const router = new StrategyRouter();
    const strategy = {
      identity,
      mode: 'OFF' as const,
      evaluate: () => ({
        symbol: 'SUIUSDT',
        timestamp: 1,
        decision: 'NO_TRADE' as const,
        reason: 'off',
        diagnostics: {},
      }),
    };

    router.register(strategy);
    expect(() => router.register(strategy)).toThrow('STRATEGY_ALREADY_REGISTERED:MOMENTUM_RIDE');
  });

  it('rejects an entry intent without a side', async () => {
    const router = new StrategyRouter();
    router.register({
      identity,
      mode: 'LIVE',
      evaluate: () => ({
        symbol: 'SUIUSDT',
        timestamp: 1,
        decision: 'ENTRY_INTENT',
        reason: 'invalid',
        diagnostics: {},
      }),
    });

    await expect(router.evaluate('MOMENTUM_RIDE', {})).rejects.toThrow(
      'STRATEGY_ENTRY_INTENT_MISSING_SIDE',
    );
  });
});
