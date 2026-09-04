import { describe, expect, it } from 'vitest';
import { MICRO_OPPORTUNITY_FEATURE_SCHEMA_HASH } from '../research/MicroOpportunityFeatureVector';
import { MICRO_OPPORTUNITY_FEATURE_SCHEMA_VERSION } from '../research/MicroOpportunityTypes';
import { evaluateMicroOpportunityGate } from './MicroOpportunityGate';
import { MicroOpportunityLocalInference } from './MicroOpportunityLocalInference';
import { validateOpportunityPrediction } from './MicroOpportunityPredictionContract';

const prediction = {
  expectedMfeBps: 20,
  expectedMaeBps: 5,
  probabilityNetPositive: 0.8,
  opportunityScore: 0.75,
  modelVersion: 'fake-v1',
  schemaVersion: MICRO_OPPORTUNITY_FEATURE_SCHEMA_VERSION,
  featureHash: MICRO_OPPORTUNITY_FEATURE_SCHEMA_HASH,
  observedAt: 1_000,
  predictionAt: 1_001,
  inferenceLatencyMs: 0,
} as const;

describe('Micro Opportunity P/Q/U/W contracts', () => {
  it('validates the small prediction contract and rejects schema drift', () => {
    expect(validateOpportunityPrediction(prediction)).toBe(true);
    expect(validateOpportunityPrediction({ ...prediction, featureHash: 'wrong' })).toBe(false);
  });

  it('is fail-closed and cannot create or flip a Micro direction', () => {
    expect(evaluateMicroOpportunityGate({ stableDecision: 'NO_TRADE', stableSide: null, prediction, nowMs: 1_002, maxPredictionAgeMs: 10_000, minimumProbability: 0.5 })).toMatchObject({ action: 'REJECT', side: null });
    expect(evaluateMicroOpportunityGate({ stableDecision: 'ENTRY_INTENT', stableSide: 'LONG', prediction: { ...prediction, probabilityNetPositive: 0.2 }, nowMs: 1_002, maxPredictionAgeMs: 10_000, minimumProbability: 0.5 })).toMatchObject({ action: 'REJECT' });
    expect(evaluateMicroOpportunityGate({ stableDecision: 'ENTRY_INTENT', stableSide: 'SHORT', prediction, nowMs: 1_002, maxPredictionAgeMs: 10_000, minimumProbability: 0.5 })).toMatchObject({ action: 'ALLOW', side: 'SHORT' });
  });

  it('keeps inference local and fail-closed on stale features/model errors', () => {
    const model = { modelVersion: 'fake-v1', predict: () => ({ expectedMfeBps: 1, expectedMaeBps: 1, probabilityNetPositive: 0.5, opportunityScore: 0.5 }) };
    const inference = new MicroOpportunityLocalInference(model, 100);
    expect(inference.predict({} as any, 1_000, 1_101)).toEqual({ prediction: null, reason: 'FEATURES_STALE_OR_INVALID' });
    const broken = new MicroOpportunityLocalInference({ modelVersion: 'broken', predict: () => { throw new Error('broken'); } }, 100);
    expect(broken.predict({} as any, 1_000, 1_001).reason).toBe('MODEL_EXCEPTION');
  });
});
