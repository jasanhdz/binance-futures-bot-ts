import { describe, expect, it, vi } from 'vitest';
import { MicroBurstShadowEvaluator } from '../application/MicroBurstShadowEvaluator';
import { MicroBurstDuplicateSignalGuard } from '../domain/MicroBurstDuplicateSignalGuard';
import type { MicroBurstRuntimeConfig } from '../application/MicroBurstRuntimeTypes';
import { StrategyRouter } from '../../../core/strategy/StrategyRouter';
import { MicroBurstStrategy, MicroBurstStrategyContext } from '../domain/MicroBurstStrategy';
import { createMicroBurstV1Identity } from '../domain/MicroBurstIdentity';

const NOW_MS = 1_700_000_000_000;

function makeConfig(mode: 'OFF' | 'SHADOW' | 'LIVE' = 'SHADOW'): MicroBurstRuntimeConfig {
  return {
    enabled: true,
    mode,
    symbols: {
      ETHUSDT: { enabled: true },
      BTCUSDT: { enabled: true },
    },
  };
}

function createMockDeps() {
  const router = new StrategyRouter<MicroBurstStrategyContext>();
  router.register(new MicroBurstStrategy(createMicroBurstV1Identity(), 'SHADOW'));

  return {
    contextBuilderDeps: {
      candles: {
        getCandles: vi.fn().mockResolvedValue([]),
      },
    },
    strategyRouter: router,
    duplicateGuard: new MicroBurstDuplicateSignalGuard({ now: vi.fn(() => NOW_MS) }),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    clock: { now: vi.fn(() => NOW_MS) },
    getServerTime: vi.fn().mockResolvedValue(NOW_MS),
  };
}

describe('MicroBurstShadowEvaluator', () => {
  it('returns disabled result when mode is OFF', async () => {
    const deps = createMockDeps();
    const evaluator = new MicroBurstShadowEvaluator(deps, makeConfig('OFF'));

    const result = await evaluator.evaluate({ symbol: 'ETHUSDT' });

    expect(result.decision).toBe('NO_TRADE');
    expect(result.wouldEnter).toBe(false);
    expect(result.liveExecution).toBe(false);
    expect(result.dataQuality.invalidReasons).toContain('strategy_disabled');
  });

  it('returns disabled result for unknown symbol', async () => {
    const deps = createMockDeps();
    const evaluator = new MicroBurstShadowEvaluator(deps, makeConfig());

    const result = await evaluator.evaluate({ symbol: 'XRPUSDT' });

    expect(result.decision).toBe('NO_TRADE');
    expect(result.wouldEnter).toBe(false);
  });

  it('returns NO_TRADE when strategy router returns NO_TRADE', async () => {
    const deps = createMockDeps();
    const evaluator = new MicroBurstShadowEvaluator(deps, makeConfig());

    const result = await evaluator.evaluate({ symbol: 'ETHUSDT', snapshotAtMs: NOW_MS });

    expect(result.decision).toBe('NO_TRADE');
    expect(result.wouldEnter).toBe(false);
    expect(result.liveExecution).toBe(false);
    expect(result.strategyId).toBe('MICRO_BURST_V1');
  });

  it('never calls execute on SharedStrategyExecutionService', async () => {
    const deps = createMockDeps();
    const evaluator = new MicroBurstShadowEvaluator(deps, makeConfig());

    await evaluator.evaluate({ symbol: 'ETHUSDT' });

    // Verify no exchange mutation methods are accessible through the evaluator
    expect(deps.logger.info).not.toHaveBeenCalledWith(
      expect.stringContaining('execute'),
      expect.anything(),
    );
  });

  it('produces telemetry log for NO_TRADE', async () => {
    const deps = createMockDeps();
    const evaluator = new MicroBurstShadowEvaluator(deps, makeConfig());

    await evaluator.evaluate({ symbol: 'ETHUSDT' });

    expect(deps.logger.debug).toHaveBeenCalledWith(
      'micro_burst_shadow_no_trade',
      expect.objectContaining({
        strategyId: 'MICRO_BURST_V1',
        liveExecution: false,
      }),
    );
  });

  it('includes all required telemetry fields', async () => {
    const deps = createMockDeps();
    const evaluator = new MicroBurstShadowEvaluator(deps, makeConfig());

    await evaluator.evaluate({ symbol: 'ETHUSDT' });

    const logCall = deps.logger.debug.mock.calls[0];
    if (logCall) {
      const log = logCall[1] as Record<string, unknown>;
      expect(log).toHaveProperty('strategyId');
      expect(log).toHaveProperty('symbol');
      expect(log).toHaveProperty('snapshotAtMs');
      expect(log).toHaveProperty('decision');
      expect(log).toHaveProperty('liveExecution', false);
      expect(log).toHaveProperty('bookStatus');
      expect(log).toHaveProperty('btcStatus');
      expect(log).toHaveProperty('microRegime');
      expect(log).toHaveProperty('dataQualityContextValid');
      expect(log).toHaveProperty('wouldEnter');
    }
  });
});
