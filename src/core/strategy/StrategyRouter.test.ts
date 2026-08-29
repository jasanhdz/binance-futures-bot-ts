import { describe, expect, it, vi } from 'vitest';
import type { StrategyDecisionObservationHook } from '../blackbox/StrategyDecisionObservation';
import type { MarketSnapshotV1 } from '../market-data/MarketSnapshotProvider';
import { StrategyRouter } from './StrategyRouter';
import { createUnfrozenStrategyIdentity } from './StrategyIdentity';

const identity = createUnfrozenStrategyIdentity('MOMENTUM_RIDE', 'legacy-unfrozen', 'test-sha');

function observationSnapshot(): MarketSnapshotV1 {
  return {
    schemaVersion: 1,
    snapshotId: 'snapshot-before-decision',
    symbol: 'SUIUSDT',
    captureStartedAtMs: 100,
    capturedAtMs: 110,
    primary: {} as MarketSnapshotV1['primary'],
    health: 'COMPLETE',
    provenance: {} as MarketSnapshotV1['provenance'],
  };
}

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

  it('captures before evaluation and persists the exact returned envelope', async () => {
    const events: string[] = [];
    const afterEvaluation = vi.fn(async (_snapshot, envelope) => {
      events.push('persist');
      expect(envelope.decision).toBe('ENTRY_INTENT');
      expect(envelope.side).toBe('SHORT');
    });
    const hook: StrategyDecisionObservationHook<{ symbol: string }> = {
      beforeEvaluation: async () => {
        events.push('capture');
        return observationSnapshot();
      },
      afterEvaluation,
    };
    const router = new StrategyRouter(hook);
    router.register({
      identity,
      mode: 'SHADOW',
      evaluate: ({ symbol }) => {
        events.push('evaluate');
        return {
          symbol,
          timestamp: 123,
          decision: 'ENTRY_INTENT',
          side: 'SHORT',
          reason: 'same-decision',
          confidence: 0.91,
          diagnostics: { source: 'parity' },
        };
      },
    });

    const result = await router.evaluate('MOMENTUM_RIDE', { symbol: 'SUIUSDT' });

    expect(events).toEqual(['capture', 'evaluate', 'persist']);
    expect(afterEvaluation).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      decision: 'ENTRY_INTENT',
      side: 'SHORT',
      reason: 'same-decision',
      confidence: 0.91,
      diagnostics: { source: 'parity' },
    });
  });

  it('returns the same strategy decision with observation OFF or ON', async () => {
    const strategy = {
      identity,
      mode: 'SHADOW' as const,
      evaluate: ({ symbol }: { symbol: string }) => ({
        symbol,
        timestamp: 123,
        decision: 'ENTRY_INTENT' as const,
        side: 'SHORT' as const,
        reason: 'parity',
        confidence: 0.77,
        diagnostics: { deterministic: true },
      }),
    };
    const withoutObservation = new StrategyRouter<{ symbol: string }>();
    withoutObservation.register(strategy);

    const hook: StrategyDecisionObservationHook<{ symbol: string }> = {
      beforeEvaluation: async () => observationSnapshot(),
      afterEvaluation: async () => undefined,
    };
    const withObservation = new StrategyRouter<{ symbol: string }>(hook);
    withObservation.register(strategy);

    const baseline = await withoutObservation.evaluate('MOMENTUM_RIDE', { symbol: 'SUIUSDT' });
    const observed = await withObservation.evaluate('MOMENTUM_RIDE', { symbol: 'SUIUSDT' });

    expect(observed).toEqual(baseline);
  });

  it('fails open when capture or persistence fails', async () => {
    const captureFailure: StrategyDecisionObservationHook<{ symbol: string }> = {
      beforeEvaluation: async () => {
        throw new Error('snapshot unavailable');
      },
      afterEvaluation: async () => {
        throw new Error('must not be called');
      },
    };
    const router = new StrategyRouter(captureFailure);
    router.register({
      identity,
      mode: 'SHADOW',
      evaluate: ({ symbol }) => ({
        symbol,
        timestamp: 123,
        decision: 'NO_TRADE',
        reason: 'safe',
        diagnostics: {},
      }),
    });
    await expect(router.evaluate('MOMENTUM_RIDE', { symbol: 'SUIUSDT' })).resolves.toMatchObject({
      decision: 'NO_TRADE',
      reason: 'safe',
    });

    const persistenceFailure: StrategyDecisionObservationHook<{ symbol: string }> = {
      beforeEvaluation: async () => observationSnapshot(),
      afterEvaluation: async () => {
        throw new Error('disk unavailable');
      },
    };
    const secondRouter = new StrategyRouter(persistenceFailure);
    secondRouter.register({
      identity,
      mode: 'SHADOW',
      evaluate: ({ symbol }) => ({
        symbol,
        timestamp: 123,
        decision: 'NO_TRADE',
        reason: 'safe',
        diagnostics: {},
      }),
    });
    await expect(
      secondRouter.evaluate('MOMENTUM_RIDE', { symbol: 'SUIUSDT' }),
    ).resolves.toMatchObject({ decision: 'NO_TRADE', reason: 'safe' });
  });
});
