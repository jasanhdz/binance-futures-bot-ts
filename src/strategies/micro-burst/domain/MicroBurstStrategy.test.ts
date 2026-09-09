import { describe, expect, it } from 'vitest';
import { createMicroBurstIdentity } from './MicroBurstIdentity';
import { MicroBurstStrategy } from './MicroBurstStrategy';
import { makeMicroBurstContext } from './MicroBurst.test-support';

describe('MicroBurstStrategy', () => {
  it('creates only with MICRO_BURST identity and remains OFF-capable', () => {
    const strategy = new MicroBurstStrategy(createMicroBurstIdentity(), 'OFF');
    expect(strategy.identity.strategyId).toBe('MICRO_BURST');
    expect(strategy.mode).toBe('OFF');
  });

  it('throws on identity mismatch', () => {
    const identity = {
      strategyId: 'AEGIS_TURBO' as const,
      strategyVersion: '1',
      freezeState: 'DRAFT' as const,
      codeCommitSha: 'abc',
    };
    expect(() => new MicroBurstStrategy(identity, 'OFF')).toThrow('MICRO_BURST_IDENTITY_MISMATCH');
  });

  it('preserves unit-safe risk diagnostics in evaluation result', () => {
    const strategy = new MicroBurstStrategy(createMicroBurstIdentity(), 'OFF');
    const context = makeMicroBurstContext();
    const now = context.timestamp;
    context.candles.candles1m = [
      {
        timestamp: now,
        openTime: now - 60_000,
        closeTime: now,
        open: 99.8,
        high: 100.05,
        low: 99.65,
        close: 100,
        volume: 100,
        buyVolume: 50,
      },
    ];
    context.aggTradeFlow = {
      buyTakerVolume: 60,
      sellTakerVolume: 40,
      netTakerFlow: 20,
      tradeCount: 20,
      requestedWindowMs: 5000,
      observedWindowMs: 5000,
      observedSampleCount: 20,
      eventWatermarkMs: now,
      capacityTruncated: false,
      coverageStartedAtMs: now - 5000,
      windowComplete: true,
      gapFree: true,
    };
    const result = strategy.evaluate({
      ...context,
      observedAtMs: now,
      executionBook: {
        status: 'HEALTHY',
        observedAtMs: now,
        bidDepth: [{ price: 99.99, qty: 100 }],
        askDepth: [{ price: 100.01, qty: 100 }],
      },
    });
    expect(result.decision).toBe('ENTRY_INTENT');
    expect(result.diagnostics.roomToTargetBps).toBeGreaterThan(100);
    expect(result.diagnostics.riskToInvalidationBps).toBeGreaterThan(1);
    expect(result.diagnostics.rewardRisk).toBeGreaterThan(1);
    expect([20, 30]).toContain(result.diagnostics.leverage);
    expect(result.diagnostics.positionFraction).toBe(0.9);
  });

  it('is deterministic for the same context', () => {
    const strategy = new MicroBurstStrategy(createMicroBurstIdentity(), 'OFF');
    const context = makeMicroBurstContext();
    expect(strategy.evaluate(context)).toEqual(strategy.evaluate(context));
  });
});
