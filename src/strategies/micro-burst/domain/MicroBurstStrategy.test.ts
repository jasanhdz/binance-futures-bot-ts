import { describe, expect, it } from 'vitest';
import { createMicroBurstV1Identity } from './MicroBurstIdentity';
import { MicroBurstStrategy } from './MicroBurstStrategy';
import { makeMicroBurstContext } from './MicroBurst.test-support';

describe('MicroBurstStrategy', () => {
  it('creates only with MICRO_BURST_V1 identity and remains OFF-capable', () => {
    const strategy = new MicroBurstStrategy(createMicroBurstV1Identity(), 'OFF');
    expect(strategy.identity.strategyId).toBe('MICRO_BURST_V1');
    expect(strategy.mode).toBe('OFF');
  });

  it('throws on identity mismatch', () => {
    const identity = {
      strategyId: 'AEGIS_TURBO' as const,
      strategyVersion: '1',
      freezeState: 'DRAFT' as const,
      codeCommitSha: 'abc',
    };
    expect(() => new MicroBurstStrategy(identity, 'OFF')).toThrow(
      'MICRO_BURST_V1_IDENTITY_MISMATCH',
    );
  });

  it('preserves unit-safe risk diagnostics in evaluation result', () => {
    const strategy = new MicroBurstStrategy(createMicroBurstV1Identity(), 'OFF');
    const result = strategy.evaluate(makeMicroBurstContext());
    expect(result.decision).toBe('ENTRY_INTENT');
    expect(result.diagnostics.roomToTargetBps).toBeGreaterThan(100);
    expect(result.diagnostics.riskToInvalidationBps).toBeGreaterThan(1);
    expect(result.diagnostics.rewardRisk).toBeGreaterThan(1);
    expect(result.diagnostics.leverage).toBe(40);
    // Current approved defaults use 90%, not 9%; no sizing change in this test repair.
    expect(result.diagnostics.positionFraction).toBe(0.9);
  });

  it('is deterministic for the same context', () => {
    const strategy = new MicroBurstStrategy(createMicroBurstV1Identity(), 'OFF');
    const context = makeMicroBurstContext();
    expect(strategy.evaluate(context)).toEqual(strategy.evaluate(context));
  });
});
