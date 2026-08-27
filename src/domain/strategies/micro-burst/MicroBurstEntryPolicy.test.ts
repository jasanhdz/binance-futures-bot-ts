import { describe, expect, it } from 'vitest';
import { defaultMicroBurstConfig, MicroBurstConfig, MicroBurstContext } from './MicroBurstTypes';
import { evaluateMicroBurstEntry } from './MicroBurstEntryPolicy';

function makeContext(overrides: Partial<MicroBurstContext> = {}): MicroBurstContext {
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

describe('MicroBurstEntryPolicy', () => {
  const config = defaultMicroBurstConfig();

  it('returns NO_TRADE when context is invalid', () => {
    const ctx = makeContext({
      dataQuality: {
        snapshotAt: Date.now(),
        latestClosed1mAt: 0,
        latestClosed3mAt: 0,
        latestClosed5mAt: 0,
        candleFreshnessMs: 200_000,
        bookAgeMs: null,
        btcAgeMs: null,
        bookStatus: 'HEALTHY',
        closedCandlesOnly: true,
        levelsAvailableAt: null,
        contextValid: false,
        invalidReasons: ['stale_candles'],
      },
    });
    const result = evaluateMicroBurstEntry(ctx, config);
    expect(result.action).toBe('NO_TRADE');
    expect(result.reason).toContain('CONTEXT_INVALID');
  });

  it('returns NO_TRADE when no structural clarity', () => {
    const ctx = makeContext({ structuralClarity: false });
    const result = evaluateMicroBurstEntry(ctx, config);
    expect(result.action).toBe('NO_TRADE');
    expect(result.reason).toBe('NO_STRUCTURAL_CLARITY');
  });

  it('returns NO_TRADE when missing structural level', () => {
    const ctx = makeContext({
      structuralClarity: true,
      levels: {
        levels: [],
        nearest: {
          support: null,
          resistance: null,
          distanceToSupportBps: 200,
          distanceToResistanceBps: 200,
          corridorWidthBps: 400,
          structuralPosition: 'near_support',
        },
      },
      momentum: {
        direction: 'LONG',
        strength: 0.7,
        continuationScore: 0.6,
        slope1m: 0.001,
        slope3m: 0.001,
        slope5m: 0.001,
        bodyStrength: 0.5,
        wickRejectionUpper: 0.1,
        wickRejectionLower: 0.3,
        volumeExpansion: true,
        candleSequenceQuality: 0.7,
      },
    });
    const result = evaluateMicroBurstEntry(ctx, config);
    expect(result.action).toBe('NO_TRADE');
    expect(result.reason).toBe('MISSING_STRUCTURAL_LEVEL');
  });

  it('returns LONG when near support with upward momentum', () => {
    const ctx = makeContext({
      structuralClarity: true,
      currentPrice: 100,
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
    const result = evaluateMicroBurstEntry(ctx, config);
    expect(result.action).toBe('ENTRY_INTENT');
    expect(result.side).toBe('LONG');
    expect(result.stopInvalidationPrice).toBeLessThan(ctx.levels.nearest.support!.price);
    expect(result.targetPrice).toBe(ctx.levels.nearest.resistance!.price);
  });

  it('returns SHORT when near resistance with downward momentum', () => {
    const ctx = makeContext({
      structuralClarity: true,
      currentPrice: 100,
      levels: {
        levels: [],
        nearest: {
          support: {
            price: 98,
            type: 'support',
            strength: 0.8,
            touches: 3,
            lastTouchIndex: 8,
            availableAtCandleIndex: 11,
            volumeAtLevel: 5000,
          },
          resistance: {
            price: 100.3,
            type: 'resistance',
            strength: 0.9,
            touches: 5,
            lastTouchIndex: 2,
            availableAtCandleIndex: 5,
            volumeAtLevel: 10000,
          },
          distanceToSupportBps: 200,
          distanceToResistanceBps: 30,
          corridorWidthBps: 250,
          structuralPosition: 'near_resistance',
        },
      },
      momentum: {
        direction: 'SHORT',
        strength: 0.85,
        continuationScore: 0.8,
        slope1m: -0.002,
        slope3m: -0.002,
        slope5m: -0.001,
        bodyStrength: 0.6,
        wickRejectionUpper: 0.4,
        wickRejectionLower: 0.1,
        volumeExpansion: true,
        candleSequenceQuality: 0.8,
      },
    });
    const result = evaluateMicroBurstEntry(ctx, config);
    expect(result.action).toBe('ENTRY_INTENT');
    expect(result.side).toBe('SHORT');
    expect(result.stopInvalidationPrice).toBeGreaterThan(ctx.levels.nearest.resistance!.price);
    expect(result.targetPrice).toBe(ctx.levels.nearest.support!.price);
  });

  it('returns NO_TRADE on BTC conflict', () => {
    const ctx = makeContext({
      structuralClarity: true,
      levels: {
        levels: [],
        nearest: {
          support: {
            price: 99.5,
            type: 'support',
            strength: 0.8,
            touches: 3,
            lastTouchIndex: 5,
            availableAtCandleIndex: 8,
            volumeAtLevel: 5000,
          },
          resistance: null,
          distanceToSupportBps: 50,
          distanceToResistanceBps: Infinity,
          corridorWidthBps: 100,
          structuralPosition: 'near_support',
        },
      },
      momentum: {
        direction: 'LONG',
        strength: 0.7,
        continuationScore: 0.6,
        slope1m: 0.001,
        slope3m: 0.001,
        slope5m: 0.001,
        bodyStrength: 0.5,
        wickRejectionUpper: 0.1,
        wickRejectionLower: 0.3,
        volumeExpansion: true,
        candleSequenceQuality: 0.7,
      },
      btcContext: {
        ret1m: -0.001,
        ret3m: -0.01,
        ret5m: -0.02,
        acceleration: -0.005,
        conflictFlag: true,
        direction: 'SHORT',
      },
    });
    const result = evaluateMicroBurstEntry(ctx, config);
    expect(result.action).toBe('NO_TRADE');
    expect(result.reason).toBe('BTC_CONFLICT');
  });

  it('returns NO_TRADE on insufficient continuation', () => {
    const ctx = makeContext({
      structuralClarity: true,
      levels: {
        levels: [],
        nearest: {
          support: {
            price: 99.5,
            type: 'support',
            strength: 0.8,
            touches: 3,
            lastTouchIndex: 5,
            availableAtCandleIndex: 8,
            volumeAtLevel: 5000,
          },
          resistance: null,
          distanceToSupportBps: 50,
          distanceToResistanceBps: Infinity,
          corridorWidthBps: 100,
          structuralPosition: 'near_support',
        },
      },
      momentum: {
        direction: 'LONG',
        strength: 0.7,
        continuationScore: 0.1,
        slope1m: 0.001,
        slope3m: 0.001,
        slope5m: 0.001,
        bodyStrength: 0.5,
        wickRejectionUpper: 0.1,
        wickRejectionLower: 0.3,
        volumeExpansion: true,
        candleSequenceQuality: 0.7,
      },
    });
    const result = evaluateMicroBurstEntry(ctx, config);
    expect(result.action).toBe('NO_TRADE');
    expect(result.reason).toBe('INSUFFICIENT_CONTINUATION');
  });

  it('returns NO_TRADE on book anomaly', () => {
    const ctx = makeContext({
      structuralClarity: true,
      levels: {
        levels: [],
        nearest: {
          support: {
            price: 99.5,
            type: 'support',
            strength: 0.8,
            touches: 3,
            lastTouchIndex: 5,
            availableAtCandleIndex: 8,
            volumeAtLevel: 5000,
          },
          resistance: null,
          distanceToSupportBps: 50,
          distanceToResistanceBps: Infinity,
          corridorWidthBps: 100,
          structuralPosition: 'near_support',
        },
      },
      momentum: {
        direction: 'LONG',
        strength: 0.7,
        continuationScore: 0.6,
        slope1m: 0.001,
        slope3m: 0.001,
        slope5m: 0.001,
        bodyStrength: 0.5,
        wickRejectionUpper: 0.1,
        wickRejectionLower: 0.3,
        volumeExpansion: true,
        candleSequenceQuality: 0.7,
      },
      bookPressure: {
        spreadBps: 50,
        topOfBookImbalance: 0,
        imbalanceSlope: null,
        staticBidConcentration: false,
        staticAskConcentration: false,
        anomalyFlag: true,
        status: 'HEALTHY',
      },
    });
    const result = evaluateMicroBurstEntry(ctx, config);
    expect(result.action).toBe('NO_TRADE');
  });
});
