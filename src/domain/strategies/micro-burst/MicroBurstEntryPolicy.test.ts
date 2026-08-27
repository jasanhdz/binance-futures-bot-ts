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

describe('MicroBurstEntryPolicy', () => {
  const config = defaultMicroBurstConfig();

  it('returns NO_TRADE when no structural clarity', () => {
    const ctx = makeContext({ structuralClarity: false });
    const result = evaluateMicroBurstEntry(ctx, config);
    expect(result.action).toBe('NO_TRADE');
    expect(result.reason).toBe('NO_STRUCTURAL_CLARITY');
  });

  it('returns NO_TRADE in mid-range', () => {
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
          structuralPosition: 'mid_range',
        },
      },
    });
    const result = evaluateMicroBurstEntry(ctx, config);
    expect(result.action).toBe('NO_TRADE');
    expect(result.reason).toBe('MID_RANGE_NO_EDGE');
  });

  it('returns NO_TRADE when momentum direction mismatches', () => {
    const ctx = makeContext({
      structuralClarity: true,
      levels: {
        levels: [],
        nearest: {
          support: { price: 99, type: 'support', strength: 0.8, touches: 3, lastTouchIndex: 5, volumeAtLevel: 5000 },
          resistance: null,
          distanceToSupportBps: 20,
          distanceToResistanceBps: Infinity,
          corridorWidthBps: 100,
          structuralPosition: 'near_support',
        },
      },
      momentum: {
        direction: 'SHORT',
        strength: 0.7,
        continuationScore: 0.6,
        slope1m: -0.001,
        slope3m: -0.001,
        slope5m: -0.001,
        bodyStrength: 0.5,
        wickRejectionUpper: 0.3,
        wickRejectionLower: 0.1,
        volumeExpansion: true,
        candleSequenceQuality: 0.7,
      },
    });
    const result = evaluateMicroBurstEntry(ctx, config);
    expect(result.action).toBe('NO_TRADE');
    expect(result.reason).toBe('MOMENTUM_DIRECTION_MISMATCH');
  });

  it('returns LONG when near support with upward momentum', () => {
    const ctx = makeContext({
      structuralClarity: true,
      currentPrice: 100,
      levels: {
        levels: [],
        nearest: {
          support: { price: 99.5, type: 'support', strength: 0.9, touches: 5, lastTouchIndex: 2, volumeAtLevel: 10000 },
          resistance: { price: 102, type: 'resistance', strength: 0.8, touches: 3, lastTouchIndex: 8, volumeAtLevel: 5000 },
          distanceToSupportBps: 30,
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
      bookPressure: {
        spreadBps: 3,
        topOfBookImbalance: 0.3,
        imbalanceSlope: 0.1,
        absorptionDetected: true,
        sweepDetected: false,
        anomalyFlag: false,
        degradedMode: false,
      },
    });
    const result = evaluateMicroBurstEntry(ctx, config);
    expect(result.action).toBe('ENTRY_INTENT');
    expect(result.side).toBe('LONG');
    expect(result.stopInvalidationPrice).toBeLessThan(ctx.currentPrice);
    expect(result.targetPrice).toBeGreaterThan(ctx.currentPrice);
  });

  it('returns SHORT when near resistance with downward momentum', () => {
    const ctx = makeContext({
      structuralClarity: true,
      currentPrice: 100,
      levels: {
        levels: [],
        nearest: {
          support: { price: 98, type: 'support', strength: 0.8, touches: 3, lastTouchIndex: 8, volumeAtLevel: 5000 },
          resistance: { price: 100.3, type: 'resistance', strength: 0.9, touches: 5, lastTouchIndex: 2, volumeAtLevel: 10000 },
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
      bookPressure: {
        spreadBps: 3,
        topOfBookImbalance: -0.3,
        imbalanceSlope: -0.1,
        absorptionDetected: true,
        sweepDetected: false,
        anomalyFlag: false,
        degradedMode: false,
      },
    });
    const result = evaluateMicroBurstEntry(ctx, config);
    expect(result.action).toBe('ENTRY_INTENT');
    expect(result.side).toBe('SHORT');
    expect(result.stopInvalidationPrice).toBeGreaterThan(ctx.currentPrice);
    expect(result.targetPrice).toBeLessThan(ctx.currentPrice);
  });

  it('returns NO_TRADE on BTC conflict', () => {
    const ctx = makeContext({
      structuralClarity: true,
      levels: {
        levels: [],
        nearest: {
          support: { price: 99.5, type: 'support', strength: 0.8, touches: 3, lastTouchIndex: 5, volumeAtLevel: 5000 },
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
        ret3m: -0.5,
        ret5m: -0.8,
        acceleration: -0.3,
        conflictFlag: true,
        direction: 'SHORT',
      },
    });
    const result = evaluateMicroBurstEntry(ctx, config);
    expect(result.action).toBe('NO_TRADE');
    expect(result.reason).toBe('BTC_CONFLICT');
  });

  it('returns NO_TRADE on book anomaly', () => {
    const ctx = makeContext({
      structuralClarity: true,
      levels: {
        levels: [],
        nearest: {
          support: { price: 99.5, type: 'support', strength: 0.8, touches: 3, lastTouchIndex: 5, volumeAtLevel: 5000 },
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
        imbalanceSlope: 0,
        absorptionDetected: false,
        sweepDetected: false,
        anomalyFlag: true,
        degradedMode: false,
      },
    });
    const result = evaluateMicroBurstEntry(ctx, config);
    expect(result.action).toBe('NO_TRADE');
    expect(result.reason).toBe('BOOK_ANOMALY');
  });
});
