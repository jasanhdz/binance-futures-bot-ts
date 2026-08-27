import { describe, expect, it } from 'vitest';
import { createMicroBurstV1Identity } from './MicroBurstIdentity';
import { MicroBurstStrategy, MicroBurstStrategyContext } from './MicroBurstStrategy';

function makeContext(overrides: Partial<MicroBurstStrategyContext> = {}): MicroBurstStrategyContext {
  return {
    symbol: 'ETHUSDT',
    timestamp: Date.now(),
    currentPrice: 100,
    candles: { candles1m: [], candles3m: [], candles5m: [] },
    levels: {
      levels: [],
      nearest: {
        support: null,
        resistance: null,
        distanceToSupportBps: Infinity,
        distanceToResistanceBps: Infinity,
        corridorWidthBps: Infinity,
        structuralPosition: 'mid_range',
      },
    },
    momentum: {
      direction: 'NEUTRAL',
      strength: 0,
      continuationScore: 0,
      slope1m: 0,
      slope3m: 0,
      slope5m: 0,
      bodyStrength: 0,
      wickRejectionUpper: 0,
      wickRejectionLower: 0,
      volumeExpansion: false,
      candleSequenceQuality: 0,
    },
    bookPressure: {
      spreadBps: 5,
      topOfBookImbalance: 0,
      imbalanceSlope: 0,
      absorptionDetected: false,
      sweepDetected: false,
      anomalyFlag: false,
      degradedMode: false,
    },
    btcContext: null,
    structuralClarity: false,
    microRegime: 'RANGING',
    ...overrides,
  };
}

describe('MicroBurstStrategy', () => {
  it('creates with valid identity', () => {
    const identity = createMicroBurstV1Identity();
    const strategy = new MicroBurstStrategy(identity, 'OFF');
    expect(strategy.identity.strategyId).toBe('MICRO_BURST_V1');
    expect(strategy.mode).toBe('OFF');
  });

  it('throws on identity mismatch', () => {
    const identity = { strategyId: 'AEGIS_TURBO' as const, strategyVersion: '1', freezeState: 'DRAFT' as const, codeCommitSha: 'abc' };
    expect(() => new MicroBurstStrategy(identity, 'OFF')).toThrow('MICRO_BURST_V1_IDENTITY_MISMATCH');
  });

  it('returns NO_TRADE for context without clarity', () => {
    const identity = createMicroBurstV1Identity();
    const strategy = new MicroBurstStrategy(identity, 'SHADOW');
    const ctx = makeContext();
    const result = strategy.evaluate(ctx);
    expect(result.decision).toBe('NO_TRADE');
    expect(result.symbol).toBe('ETHUSDT');
  });

  it('returns StrategyEvaluationResult format', () => {
    const identity = createMicroBurstV1Identity();
    const strategy = new MicroBurstStrategy(identity, 'SHADOW');
    const ctx = makeContext();
    const result = strategy.evaluate(ctx);
    expect(result).toHaveProperty('symbol');
    expect(result).toHaveProperty('timestamp');
    expect(result).toHaveProperty('decision');
    expect(result).toHaveProperty('reason');
    expect(result).toHaveProperty('diagnostics');
  });
});
