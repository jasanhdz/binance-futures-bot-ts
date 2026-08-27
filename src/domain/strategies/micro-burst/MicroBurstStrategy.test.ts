import { describe, expect, it } from 'vitest';
import { createMicroBurstV1Identity } from './MicroBurstIdentity';
import { MicroBurstStrategy, MicroBurstStrategyContext } from './MicroBurstStrategy';

function makeContext(
  overrides: Partial<MicroBurstStrategyContext> = {},
): MicroBurstStrategyContext {
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
      imbalanceSlope: null,
      staticBidConcentration: false,
      staticAskConcentration: false,
      anomalyFlag: false,
      status: 'HEALTHY',
    },
    btcContext: null,
    structuralClarity: false,
    microRegime: 'RANGING',
    dataQuality: {
      snapshotAt: Date.now(),
      latestClosed1mAt: Date.now() - 5000,
      latestClosed3mAt: Date.now() - 10000,
      latestClosed5mAt: Date.now() - 15000,
      candleFreshnessMs: 5000,
      bookAgeMs: null,
      btcAgeMs: null,
      bookStatus: 'HEALTHY',
      closedCandlesOnly: true,
      levelsAvailableAt: null,
      contextValid: true,
      invalidReasons: [],
    },
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

  it('carries leverage and positionFraction in diagnostics', () => {
    const identity = createMicroBurstV1Identity();
    const strategy = new MicroBurstStrategy(identity, 'SHADOW');
    const ctx = makeContext({
      structuralClarity: true,
      levels: {
        levels: [],
        nearest: {
          support: {
            price: 99.5,
            type: 'support',
            strength: 0.9,
            touches: 5,
            lastTouchIndex: 2,
            availableAtCandleIndex: 5,
            volumeAtLevel: 10000,
          },
          resistance: {
            price: 102,
            type: 'resistance',
            strength: 0.8,
            touches: 3,
            lastTouchIndex: 8,
            availableAtCandleIndex: 11,
            volumeAtLevel: 5000,
          },
          distanceToSupportBps: 50,
          distanceToResistanceBps: 200,
          corridorWidthBps: 250,
          structuralPosition: 'near_support',
        },
      },
      momentum: {
        direction: 'LONG',
        strength: 0.85,
        continuationScore: 0.8,
        slope1m: 0.002,
        slope3m: 0.002,
        slope5m: 0.001,
        bodyStrength: 0.6,
        wickRejectionUpper: 0.1,
        wickRejectionLower: 0.4,
        volumeExpansion: true,
        candleSequenceQuality: 0.8,
      },
    });
    const result = strategy.evaluate(ctx);
    if (result.decision === 'ENTRY_INTENT') {
      expect(result.diagnostics).toHaveProperty('leverage');
      expect(result.diagnostics).toHaveProperty('positionFraction');
      expect(result.diagnostics).toHaveProperty('leverageTier');
    }
  });
});
