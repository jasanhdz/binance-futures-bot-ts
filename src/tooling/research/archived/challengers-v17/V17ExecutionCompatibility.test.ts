import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  entrySlippageBps,
  evaluateV17ResearchArtifact,
  V17CanonicalDecision,
  V17FrozenFeatureVector,
  V17ResearchSideArtifact,
  validateV17Decision,
} from './V17ExecutionCompatibility';

function fixture(changes: Partial<V17CanonicalDecision> = {}): V17CanonicalDecision {
  return {
    schema_id: 'aegis-v17-canonical-decision-v1',
    symbol: 'ETHUSDT',
    side: 'LONG',
    selected: true,
    clean_probability: 0.72,
    danger_probability: 0.18,
    mae_q90: 0.004,
    rank_score: 0.81,
    thresholds: {
      minimum_clean_probability: 0.65,
      maximum_danger_probability: 0.25,
      maximum_mae_q90: 0.006,
      minimum_rank_score: 0.75,
    },
    expected_price: 3000,
    market_timestamp: '2026-08-12T00:00:00Z',
    feature_hash: 'feature-hash',
    model_identifier: 'v17-test-fixture',
    model_sha256: 'a'.repeat(64),
    policy_identifier: 'v17-policy-test-fixture',
    ...changes,
  };
}

describe('V17 execution compatibility boundary', () => {
  it('preserves the canonical decision without deriving trading values', () => {
    expect(validateV17Decision(fixture())).toEqual({
      symbol: 'ETHUSDT',
      side: 'LONG',
      selected: true,
      expectedPrice: 3000,
      marketTimestamp: '2026-08-12T00:00:00Z',
      featureHash: 'feature-hash',
      modelIdentifier: 'v17-test-fixture',
      modelSha256: 'a'.repeat(64),
      policyIdentifier: 'v17-policy-test-fixture',
      safety: {
        cleanProbability: 0.72,
        dangerProbability: 0.18,
        maeQ90: 0.004,
        rankScore: 0.81,
      },
    });
  });

  it('fails closed when selected disagrees with the policy thresholds', () => {
    expect(() => validateV17Decision(fixture({ clean_probability: 0.1 }))).toThrow(
      'V17_POLICY_DISAGREEMENT',
    );
  });

  it('rejects malformed model output instead of fabricating defaults', () => {
    expect(() => validateV17Decision(fixture({ rank_score: Number.NaN }))).toThrow(
      'V17_NON_FINITE_RANK_SCORE',
    );
  });

  it('records adverse slippage consistently for LONG and SHORT', () => {
    expect(entrySlippageBps('LONG', 100, 100.1)).toBeCloseTo(10);
    expect(entrySlippageBps('SHORT', 100, 99.9)).toBeCloseTo(10);
  });

  it('matches frozen Python outputs for every directional golden event', () => {
    const artifact = JSON.parse(
      fs.readFileSync(
        path.resolve(__dirname, '../../../../../../config/bundles/aegis-v17-research-artifact-v1.json'),
        'utf8',
      ),
    ) as { sides: Record<'LONG' | 'SHORT', V17ResearchSideArtifact> };
    const golden = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, 'fixtures/v17-golden-dataset.json'), 'utf8'),
    ) as {
      event_count: number;
      events: Array<{
        side: 'LONG' | 'SHORT';
        feature_vector: V17FrozenFeatureVector;
        python: ReturnType<typeof evaluateV17ResearchArtifact>;
      }>;
    };
    expect(golden.event_count).toBe(22);
    for (const event of golden.events) {
      const actual = evaluateV17ResearchArtifact(artifact.sides[event.side], event.feature_vector);
      expect(actual.clean_probability).toBeCloseTo(event.python.clean_probability, 12);
      expect(actual.danger_probability).toBeCloseTo(event.python.danger_probability, 12);
      expect(actual.mae_q90).toBeCloseTo(event.python.mae_q90, 12);
      expect(actual.rank_score).toBeCloseTo(event.python.rank_score, 6);
      expect(actual.selected).toBe(event.python.selected);
      expect(actual.policy_status).toBe(event.python.policy_status);
    }
  });
});
