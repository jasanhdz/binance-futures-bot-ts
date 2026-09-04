import { describe, expect, it } from 'vitest';
import type { AggTradeEvent } from '../../../app/ports/MarketData';
import type { MicroBurstFastMarketSnapshot } from '../application/MicroBurstFastMarketState';
import type { MicroBurstSlowMarketState } from '../domain/MicroBurstMarketState';
import { MICRO_OPPORTUNITY_FEATURE_SCHEMA_HASH } from './MicroOpportunityFeatureVector';
import { labelMicroOpportunitySample } from './MicroOpportunityLabeler';
import {
  auditOpportunitySampleCausality,
  buildOpportunityDatasetManifestV1,
  splitOpportunityDataset,
} from './MicroOpportunityDatasetGovernance';
import { buildMicroOpportunityResearchSample } from './MicroOpportunityResearchSampler';
import type { MicroOpportunityLabeledSample } from './MicroOpportunityTypes';

const T0 = 1_700_000_000_000;

function slow(): MicroBurstSlowMarketState {
  return {
    schemaVersion: 1,
    symbol: 'SOLUSDT',
    snapshotAtMs: T0 - 100,
    referencePrice: 99,
    referencePriceObservedAtMs: T0 - 60_000,
    structuralPosition: 'near_support',
    levels: {
      levels: [],
      nearest: {
        support: { price: 98, type: 'support', strength: 0.8, touches: 3, lastTouchIndex: 1, pivotCandleIndex: 1, availableAtCandleIndex: 4, pivotAtMs: T0 - 600_000, availableAtMs: T0 - 300_000, volumeAtLevel: 100 },
        resistance: { price: 105, type: 'resistance', strength: 0.8, touches: 3, lastTouchIndex: 1, pivotCandleIndex: 1, availableAtCandleIndex: 4, pivotAtMs: T0 - 600_000, availableAtMs: T0 - 300_000, volumeAtLevel: 100 },
        distanceToSupportBps: 100,
        distanceToResistanceBps: 500,
        corridorWidthBps: 700,
        structuralPosition: 'near_support',
      },
    },
    momentum: {
      direction: 'LONG', strength: 0.8, continuationScore: 0.75,
      slope1m: 0.001, slope3m: 0.0008, slope5m: 0.0005,
      bodyStrength: 0.7, wickRejectionUpper: 0.1, wickRejectionLower: 0.2,
      volumeExpansion: true, candleSequenceQuality: 0.8,
    },
    btcContext: {
      ret1m: 0.001, ret3m: 0.002, ret5m: 0.003, acceleration: 0.0001,
      conflictFlag: false, direction: 'LONG', observedAtMs: T0 - 200, receivedAtMs: T0 - 190,
    },
    structuralClarity: true,
    microRegime: 'TRENDING_UP',
    dataQuality: {
      latestClosed1mAt: T0 - 60_000,
      latestClosed3mAt: T0 - 180_000,
      latestClosed5mAt: T0 - 300_000,
      freshness1mMs: 60_000,
      freshness3mMs: 180_000,
      freshness5mMs: 300_000,
      levelsAvailableAt: T0 - 300_000,
      contextValid: true,
      invalidReasons: [],
    },
  };
}

function fast(): MicroBurstFastMarketSnapshot {
  return {
    schemaVersion: 1,
    symbol: 'SOLUSDT',
    observedAtMs: T0,
    lastPrice: 100,
    lastTradeAtMs: T0,
    returnsBps: { ms250: 2, s1: 4, s3: 8, s5: 12, s10: 20 },
    velocityBpsPerSecond: 4,
    accelerationBpsPerSecond2: 0.7,
    tradeIntensityPerSecond: 10,
    buyTakerVolume: 8,
    sellTakerVolume: 2,
    takerImbalance: 0.6,
    bestBid: 99.99,
    bestAsk: 100.01,
    midPrice: 100,
    spreadBps: 2,
    signedBookImbalance: 0.4,
    bookImbalanceSlope: 0.1,
    temporalSweepDetected: false,
    temporalAbsorptionDetected: false,
    dataQuality: {
      tradeAgeMs: 0,
      bookAgeMs: 10,
      bookStatus: 'HEALTHY',
      gapFree: true,
      windowComplete: true,
      capacityTruncated: false,
      coverageStartedAtMs: T0 - 20_000,
      eventWatermarkMs: T0,
    },
  };
}

function sample(at = T0) {
  return buildMicroOpportunityResearchSample({ symbol: 'SOLUSDT', sampledAtMs: at, slow: slow(), fast: fast() })!;
}

function futureTrades(): AggTradeEvent[] {
  return [
    { eventTime: T0 + 5_000, price: 100.2, quantity: 1, isBuyerMaker: false },
    { eventTime: T0 + 9_500, price: 99.9, quantity: 1, isBuyerMaker: true },
    { eventTime: T0 + 10_000, price: 100.1, quantity: 1, isBuyerMaker: false },
    { eventTime: T0 + 20_000, price: 100.5, quantity: 1, isBuyerMaker: false },
    { eventTime: T0 + 30_000, price: 100.4, quantity: 1, isBuyerMaker: true },
    { eventTime: T0 + 45_000, price: 99.7, quantity: 1, isBuyerMaker: true },
    { eventTime: T0 + 60_000, price: 100.3, quantity: 1, isBuyerMaker: false },
  ];
}

describe('Micro Opportunity research contract', () => {
  it('builds a hashed causal feature sample without using stable-Micro decision as a model feature', () => {
    const result = sample();
    expect(result.featureSchemaHash).toBe(MICRO_OPPORTUNITY_FEATURE_SCHEMA_HASH);
    expect(result.features.priceReturn1sBps).toBe(4);
    expect(result.features.distanceToSupportBps).toBeCloseTo(200);
    expect(result.features.distanceToResistanceBps).toBeCloseTo(500);
    expect(result.stableMicroDecision.decision).toBe('UNKNOWN');
    expect(result.population).toBe('UNCLEAR');
    expect(result.candidateOrientations).toEqual(['LONG', 'SHORT']);
    expect('decision' in result.features).toBe(false);
    expect(auditOpportunitySampleCausality([result]).valid).toBe(true);
  });

  it('captures NO_TRADE continuously without requiring an order or shadow trade', () => {
    const result = buildMicroOpportunityResearchSample({
      symbol: 'SOLUSDT',
      sampledAtMs: T0,
      slow: slow(),
      fast: fast(),
      stableMicroDecision: {
        decision: 'NO_TRADE',
        side: null,
        reason: 'insufficient_room',
        confidence: 0.2,
        uniqueCandidateId: null,
      },
    })!;
    expect(result.population).toBe('NO_TRADE');
    expect(result.stableMicroDecision.uniqueCandidateId).toBeNull();
    expect(result.candidateOrientations).toEqual(['LONG', 'SHORT']);
  });

  it('rejects sample construction if a fast observation is from the future', () => {
    const futureFast = { ...fast(), observedAtMs: T0 + 1 };
    expect(buildMicroOpportunityResearchSample({ symbol: 'SOLUSDT', sampledAtMs: T0, slow: slow(), fast: futureFast })).toBeNull();
  });

  it('labels LONG and SHORT counterfactual MFE/MAE on the same T0 state', () => {
    const labeled = labelMicroOpportunitySample(sample(), {
      trades: futureTrades(),
      watermarkMs: T0 + 60_000,
      hasAggTradeGap: () => false,
    });
    expect(labeled.labels[10_000].valid).toBe(true);
    expect(labeled.labels[10_000].long!.mfeBps).toBeCloseTo(20);
    expect(labeled.labels[10_000].long!.maeBps).toBeCloseTo(10);
    expect(labeled.labels[10_000].short!.mfeBps).toBeCloseTo(10);
    expect(labeled.labels[10_000].short!.maeBps).toBeCloseTo(20);
    expect(labeled.labels[30_000].longEconomic!.netFavorableBps.cost_14).toBeCloseTo(36);
  });

  it('never zero-fills an invalid/gapped horizon', () => {
    const labeled = labelMicroOpportunitySample(sample(), {
      trades: futureTrades(),
      watermarkMs: T0 + 60_000,
      hasAggTradeGap: (_from, to) => to >= T0 + 30_000,
    });
    expect(labeled.labels[10_000].valid).toBe(true);
    expect(labeled.labels[30_000].valid).toBe(false);
    expect(labeled.labels[30_000].long).toBeNull();
    expect(labeled.labels[30_000].invalidReason).toBe('AGG_TRADE_GAP');
  });

  it('creates chronological splits with a 60-second purge and a reproducible manifest', () => {
    const rows: MicroOpportunityLabeledSample[] = [];
    for (let index = 0; index < 20; index++) {
      const t = T0 + index * 120_000;
      const s = { ...sample(), sampledAtMs: t, sampleId: `sample-${index}` };
      rows.push({ sample: s, labels: labelMicroOpportunitySample(sample(), {
        trades: futureTrades(), watermarkMs: T0 + 60_000, hasAggTradeGap: () => false,
      }).labels });
    }
    const split = splitOpportunityDataset(rows);
    expect(split.train.length + split.validation.length + split.holdout.length + split.purged.length).toBe(20);
    expect(split.purged.length).toBeGreaterThan(0);
    const manifest = buildOpportunityDatasetManifestV1({
      datasetVersion: 'test-v1', codeCommitSha: 'abc', configHash: 'def', split,
    });
    expect(manifest.rowCounts.total).toBe(20);
    expect(manifest.featureSchemaHash).toBe(MICRO_OPPORTUNITY_FEATURE_SCHEMA_HASH);
    expect(manifest.manifestHash).toMatch(/^[a-f0-9]{64}$/);
  });
});
