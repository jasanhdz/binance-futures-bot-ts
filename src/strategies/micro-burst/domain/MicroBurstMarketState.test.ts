import { describe, expect, it } from 'vitest';
import type { MicroBurstContext } from './MicroBurstTypes';
import { projectMicroBurstSlowMarketState } from './MicroBurstMarketState';

function context(): MicroBurstContext {
  return {
    symbol: 'SOLUSDT',
    timestamp: 1_700_000_000_000,
    currentPrice: 100,
    decisionPrice: Object.freeze({
      price: 99.5,
      source: 'CANDLE',
      observedAtMs: 1_699_999_999_000,
    }),
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
      direction: 'LONG',
      strength: 0.7,
      continuationScore: 0.8,
      slope1m: 0.001,
      slope3m: 0.0005,
      slope5m: 0.0003,
      bodyStrength: 0.6,
      wickRejectionUpper: 0.1,
      wickRejectionLower: 0.2,
      volumeExpansion: true,
      candleSequenceQuality: 0.75,
    },
    bookPressure: {
      spreadBps: 1,
      signedTopOfBookImbalance: 0.4,
      topOfBookImbalance: 0.4,
      imbalanceSlope: 0.1,
      temporalAbsorptionDetected: false,
      temporalSweepDetected: false,
      staticBidConcentration: false,
      staticAskConcentration: false,
      anomalyFlag: false,
      status: 'HEALTHY',
    },
    btcContext: {
      ret1m: 0.001,
      ret3m: 0.002,
      ret5m: 0.003,
      acceleration: 0.0001,
      conflictFlag: false,
      direction: 'LONG',
      observedAtMs: 1_699_999_999_500,
      receivedAtMs: 1_699_999_999_500,
    },
    structuralClarity: true,
    microRegime: 'TRENDING_UP',
    dataQuality: {
      snapshotAtMs: 1_700_000_000_000,
      latestClosed1mAt: 1_699_999_999_000,
      latestClosed3mAt: 1_699_999_998_000,
      latestClosed5mAt: 1_699_999_995_000,
      freshness1mMs: 1_000,
      freshness3mMs: 2_000,
      freshness5mMs: 5_000,
      bookAgeMs: 25,
      btcAgeMs: 500,
      bookStatus: 'HEALTHY',
      btcStatus: 'HEALTHY',
      closedCandlesOnly: true,
      levelsAvailableAt: 1_699_999_990_000,
      contextValid: true,
      invalidReasons: [],
    },
    aggTradeFlow: {
      buyTakerVolume: 10,
      sellTakerVolume: 3,
      netTakerFlow: 7,
      tradeCount: 13,
      requestedWindowMs: 5_000,
      observedWindowMs: 5_000,
      observedSampleCount: 13,
      eventWatermarkMs: 1_700_000_000_000,
      capacityTruncated: false,
      coverageStartedAtMs: 1_699_999_995_000,
      windowComplete: true,
      gapFree: true,
    },
  };
}

describe('MicroBurst slow/fast state boundary', () => {
  it('projects only slow causal context and preserves the stable decision price provenance', () => {
    const source = context();
    const slow = projectMicroBurstSlowMarketState(source);

    expect(slow.schemaVersion).toBe(1);
    expect(slow.referencePrice).toBe(99.5);
    expect(slow.referencePriceObservedAtMs).toBe(1_699_999_999_000);
    expect(slow.structuralPosition).toBe('mid_range');
    expect(slow.microRegime).toBe('TRENDING_UP');
    expect(slow.dataQuality.contextValid).toBe(true);
    expect(Object.isFrozen(slow)).toBe(true);

    expect('bookPressure' in slow).toBe(false);
    expect('aggTradeFlow' in slow).toBe(false);
    expect('currentPrice' in slow).toBe(false);
  });

  it('copies invalid reason metadata instead of sharing the mutable source array', () => {
    const source = context();
    source.dataQuality.invalidReasons.push('before_projection');
    const slow = projectMicroBurstSlowMarketState(source);
    source.dataQuality.invalidReasons.push('after_projection');

    expect(slow.dataQuality.invalidReasons).toEqual(['before_projection']);
  });
});
