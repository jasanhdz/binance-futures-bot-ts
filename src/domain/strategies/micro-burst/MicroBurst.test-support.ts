import { BtcContext, MicroBurstContext, SupportResistanceLevel } from './MicroBurstTypes';

export const TEST_SNAPSHOT_AT_MS = 1_700_000_000_000;

export function makeBtcContext(overrides: Partial<BtcContext> = {}): BtcContext {
  return {
    ret1m: 0,
    ret3m: 0,
    ret5m: 0,
    acceleration: 0,
    conflictFlag: false,
    direction: 'NEUTRAL',
    observedAtMs: TEST_SNAPSHOT_AT_MS - 1_000,
    ...overrides,
  };
}

export function makeLevel(type: 'support' | 'resistance', price: number): SupportResistanceLevel {
  return {
    price,
    type,
    strength: 0.9,
    touches: 4,
    lastTouchIndex: 10,
    pivotCandleIndex: 8,
    availableAtCandleIndex: 10,
    pivotAtMs: TEST_SNAPSHOT_AT_MS - 900_000,
    availableAtMs: TEST_SNAPSHOT_AT_MS - 300_000,
    volumeAtLevel: 10_000,
  };
}

export function makeMicroBurstContext(
  overrides: Partial<MicroBurstContext> = {},
): MicroBurstContext {
  return {
    symbol: 'ETHUSDT',
    timestamp: TEST_SNAPSHOT_AT_MS,
    currentPrice: 100,
    decisionPrice: Object.freeze({
      price: 100,
      source: 'CANDLE' as const,
      observedAtMs: TEST_SNAPSHOT_AT_MS,
    }),
    candles: { candles1m: [], candles3m: [], candles5m: [] },
    levels: {
      levels: [makeLevel('support', 99.7), makeLevel('resistance', 102)],
      nearest: {
        support: makeLevel('support', 99.7),
        resistance: makeLevel('resistance', 102),
        distanceToSupportBps: 30,
        distanceToResistanceBps: 200,
        corridorWidthBps: 230,
        structuralPosition: 'near_support',
      },
    },
    momentum: {
      direction: 'LONG',
      strength: 0.85,
      continuationScore: 0.8,
      slope1m: 0.002,
      slope3m: 0.001,
      slope5m: 0.0005,
      bodyStrength: 0.6,
      wickRejectionUpper: 0.1,
      wickRejectionLower: 0.4,
      volumeExpansion: true,
      candleSequenceQuality: 0.8,
    },
    bookPressure: {
      spreadBps: 5,
      signedTopOfBookImbalance: 0.1,
      topOfBookImbalance: 0.1,
      imbalanceSlope: null,
      temporalAbsorptionDetected: false,
      temporalSweepDetected: false,
      staticBidConcentration: false,
      staticAskConcentration: false,
      anomalyFlag: false,
      status: 'HEALTHY',
    },
    btcContext: makeBtcContext(),
    structuralClarity: true,
    microRegime: 'RANGING',
    dataQuality: {
      snapshotAtMs: TEST_SNAPSHOT_AT_MS,
      latestClosed1mAt: TEST_SNAPSHOT_AT_MS,
      latestClosed3mAt: TEST_SNAPSHOT_AT_MS,
      latestClosed5mAt: TEST_SNAPSHOT_AT_MS,
      freshness1mMs: 0,
      freshness3mMs: 0,
      freshness5mMs: 0,
      bookAgeMs: 1_000,
      btcAgeMs: 1_000,
      bookStatus: 'HEALTHY',
      btcStatus: 'HEALTHY',
      closedCandlesOnly: true,
      levelsAvailableAt: TEST_SNAPSHOT_AT_MS - 300_000,
      contextValid: true,
      invalidReasons: [],
    },
    ...overrides,
  };
}
