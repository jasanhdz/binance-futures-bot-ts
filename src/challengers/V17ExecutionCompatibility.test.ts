import { describe, expect, it } from 'vitest';
import {
  entrySlippageBps,
  V17CanonicalDecision,
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
});
