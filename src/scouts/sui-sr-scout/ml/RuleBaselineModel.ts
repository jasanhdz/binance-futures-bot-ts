import type { ModelArtifact, ModelPrediction, FeatureVector } from '../domain/ScoutTypes';
import { FEATURE_SCHEMA_VERSION } from '../domain/ScoutTypes';

export const RULE_BASELINE_ARTIFACT_ID = 'rule_baseline_v1';
export const RULE_BASELINE_VERSION = '1.0.0';

export function createRuleBaselineModel(): ModelArtifact {
  return {
    id: RULE_BASELINE_ARTIFACT_ID,
    version: RULE_BASELINE_VERSION,
    featureSchemaVersion: FEATURE_SCHEMA_VERSION,
    type: 'RULE_BASELINE',

    predict(features: FeatureVector): ModelPrediction {
      let probability = 0.5;

      if (features.level.zoneScore >= 0.6) probability += 0.1;
      if (features.level.touchCount >= 3) probability += 0.1;
      if (features.level.bodyWickRatio > 0.5) probability += 0.05;
      if (features.flow.takerBuyRatio1m > 0.55 && features.level.side === 'LONG') {
        probability += 0.1;
      }
      if (features.flow.takerBuyRatio1m < 0.45 && features.level.side === 'SHORT') {
        probability += 0.1;
      }
      if (features.btcContext.aggressiveAgainstTrade) {
        probability -= 0.3;
      }
      if (features.btcContext.directionRelative > 0 && features.level.side === 'LONG') {
        probability += 0.05;
      }
      if (features.btcContext.directionRelative < 0 && features.level.side === 'SHORT') {
        probability += 0.05;
      }
      if (features.price.realizedVol > 0.02) probability -= 0.1;
      if (features.price.rsi14 > 70 && features.level.side === 'SHORT') probability += 0.05;
      if (features.price.rsi14 < 30 && features.level.side === 'LONG') probability += 0.05;

      probability = Math.max(0, Math.min(1, probability));

      return {
        probability,
        artifactId: RULE_BASELINE_ARTIFACT_ID,
        featureSchemaVersion: FEATURE_SCHEMA_VERSION,
      };
    },
  };
}
