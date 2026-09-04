import { MICRO_OPPORTUNITY_FEATURE_SCHEMA_HASH } from '../research/MicroOpportunityFeatureVector';
import { MICRO_OPPORTUNITY_FEATURE_SCHEMA_VERSION } from '../research/MicroOpportunityTypes';

export interface MicroOpportunityPredictionV1 {
  readonly expectedMfeBps: number;
  readonly expectedMaeBps: number;
  readonly probabilityNetPositive: number;
  readonly opportunityScore: number;
  readonly modelVersion: string;
  readonly schemaVersion: typeof MICRO_OPPORTUNITY_FEATURE_SCHEMA_VERSION;
  readonly featureHash: string;
  readonly observedAt: number;
  readonly predictionAt: number;
  readonly inferenceLatencyMs: number;
}

export function validateOpportunityPrediction(prediction: MicroOpportunityPredictionV1): boolean {
  return (
    prediction.schemaVersion === MICRO_OPPORTUNITY_FEATURE_SCHEMA_VERSION &&
    prediction.featureHash === MICRO_OPPORTUNITY_FEATURE_SCHEMA_HASH &&
    prediction.modelVersion.length > 0 &&
    prediction.observedAt > 0 &&
    prediction.predictionAt >= prediction.observedAt &&
    prediction.inferenceLatencyMs >= 0 &&
    Number.isFinite(prediction.expectedMfeBps) &&
    Number.isFinite(prediction.expectedMaeBps) &&
    prediction.expectedMfeBps >= 0 &&
    prediction.expectedMaeBps >= 0 &&
    Number.isFinite(prediction.probabilityNetPositive) &&
    prediction.probabilityNetPositive >= 0 &&
    prediction.probabilityNetPositive <= 1 &&
    Number.isFinite(prediction.opportunityScore)
  );
}
