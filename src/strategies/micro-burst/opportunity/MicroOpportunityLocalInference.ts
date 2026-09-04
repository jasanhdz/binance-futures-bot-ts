import { MICRO_OPPORTUNITY_FEATURE_NAMES, MICRO_OPPORTUNITY_FEATURE_SCHEMA_HASH } from '../research/MicroOpportunityFeatureVector';
import type { OpportunityFeatureVectorV1 } from '../research/MicroOpportunityTypes';
import { MICRO_OPPORTUNITY_FEATURE_SCHEMA_VERSION } from '../research/MicroOpportunityTypes';
import { validateOpportunityPrediction, type MicroOpportunityPredictionV1 } from './MicroOpportunityPredictionContract';

export interface MicroOpportunityModelV1 {
  readonly modelVersion: string;
  predict(values: readonly number[], observedAt: number, predictionAt: number): Omit<MicroOpportunityPredictionV1, 'modelVersion' | 'schemaVersion' | 'featureHash' | 'observedAt' | 'predictionAt' | 'inferenceLatencyMs'>;
}

export interface MicroOpportunityInferenceResult {
  readonly prediction: MicroOpportunityPredictionV1 | null;
  readonly reason: string | null;
}

export class MicroOpportunityLocalInference {
  constructor(
    private readonly model: MicroOpportunityModelV1,
    private readonly maxFeatureAgeMs: number,
  ) {}

  predict(features: OpportunityFeatureVectorV1, observedAt: number, nowMs: number): MicroOpportunityInferenceResult {
    const startedAt = Date.now();
    if (!Number.isFinite(observedAt) || observedAt <= 0 || nowMs < observedAt || nowMs - observedAt > this.maxFeatureAgeMs)
      return { prediction: null, reason: 'FEATURES_STALE_OR_INVALID' };
    try {
      const raw = this.model.predict(encodeFeatures(features), observedAt, nowMs);
      const prediction: MicroOpportunityPredictionV1 = {
        ...raw,
        modelVersion: this.model.modelVersion,
        schemaVersion: MICRO_OPPORTUNITY_FEATURE_SCHEMA_VERSION,
        featureHash: MICRO_OPPORTUNITY_FEATURE_SCHEMA_HASH,
        observedAt,
        predictionAt: nowMs,
        inferenceLatencyMs: Math.max(0, Date.now() - startedAt),
      };
      return validateOpportunityPrediction(prediction)
        ? { prediction, reason: null }
        : { prediction: null, reason: 'MODEL_OUTPUT_INVALID' };
    } catch {
      return { prediction: null, reason: 'MODEL_EXCEPTION' };
    }
  }
}

function encodeFeatures(features: OpportunityFeatureVectorV1): number[] {
  return MICRO_OPPORTUNITY_FEATURE_NAMES.map((name) => {
    const value = features[name];
    if (value === null) return Number.NaN;
    if (typeof value === 'number') return value;
    if (value === 'near_support' || value === 'TRENDING_UP') return 1;
    return 0;
  });
}
