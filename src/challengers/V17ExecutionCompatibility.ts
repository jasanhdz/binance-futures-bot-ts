export type V17Side = 'LONG' | 'SHORT';

export interface V17CanonicalDecision {
  schema_id: 'aegis-v17-canonical-decision-v1';
  symbol: string;
  side: V17Side;
  selected: boolean;
  clean_probability: number;
  danger_probability: number;
  mae_q90: number;
  rank_score: number;
  thresholds: {
    minimum_clean_probability: number;
    maximum_danger_probability: number;
    maximum_mae_q90: number;
    minimum_rank_score: number;
  };
  expected_price: number;
  market_timestamp: string;
  feature_hash: string;
  model_identifier: string;
  model_sha256: string;
  policy_identifier: string;
}

export interface V17ExecutionIntentEvidence {
  symbol: string;
  side: V17Side;
  selected: boolean;
  expectedPrice: number;
  marketTimestamp: string;
  featureHash: string;
  modelIdentifier: string;
  modelSha256: string;
  policyIdentifier: string;
  safety: {
    cleanProbability: number;
    dangerProbability: number;
    maeQ90: number;
    rankScore: number;
  };
}

function finite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new Error(`V17_NON_FINITE_${name}`);
  return value;
}

export function validateV17Decision(decision: V17CanonicalDecision): V17ExecutionIntentEvidence {
  const clean = finite(decision.clean_probability, 'CLEAN_PROBABILITY');
  const danger = finite(decision.danger_probability, 'DANGER_PROBABILITY');
  const mae = finite(decision.mae_q90, 'MAE_Q90');
  const rank = finite(decision.rank_score, 'RANK_SCORE');
  const expectedPrice = finite(decision.expected_price, 'EXPECTED_PRICE');
  const thresholds = decision.thresholds;
  const gatePassed =
    clean >= finite(thresholds.minimum_clean_probability, 'MINIMUM_CLEAN') &&
    danger <= finite(thresholds.maximum_danger_probability, 'MAXIMUM_DANGER') &&
    mae <= finite(thresholds.maximum_mae_q90, 'MAXIMUM_MAE') &&
    rank >= finite(thresholds.minimum_rank_score, 'MINIMUM_RANK');
  if (clean < 0 || clean > 1 || danger < 0 || danger > 1) {
    throw new Error('V17_PROBABILITY_OUT_OF_RANGE');
  }
  if (mae < 0 || expectedPrice <= 0) throw new Error('V17_MAGNITUDE_INVALID');
  if (decision.selected !== gatePassed) throw new Error('V17_POLICY_DISAGREEMENT');
  if (!decision.symbol.endsWith('USDT') || !decision.market_timestamp) {
    throw new Error('V17_IDENTITY_INVALID');
  }
  if (
    !decision.feature_hash ||
    !decision.model_identifier ||
    !decision.model_sha256 ||
    !decision.policy_identifier
  ) {
    throw new Error('V17_AUTHORITY_INCOMPLETE');
  }
  return {
    symbol: decision.symbol,
    side: decision.side,
    selected: decision.selected,
    expectedPrice,
    marketTimestamp: decision.market_timestamp,
    featureHash: decision.feature_hash,
    modelIdentifier: decision.model_identifier,
    modelSha256: decision.model_sha256,
    policyIdentifier: decision.policy_identifier,
    safety: {
      cleanProbability: clean,
      dangerProbability: danger,
      maeQ90: mae,
      rankScore: rank,
    },
  };
}

export function entrySlippageBps(
  side: V17Side,
  expectedPrice: number,
  executionPrice: number,
): number {
  if (
    !Number.isFinite(expectedPrice) ||
    expectedPrice <= 0 ||
    !Number.isFinite(executionPrice) ||
    executionPrice <= 0
  ) {
    throw new Error('V17_EXECUTION_PRICE_INVALID');
  }
  const adverseDifference =
    side === 'LONG' ? executionPrice - expectedPrice : expectedPrice - executionPrice;
  return (adverseDifference / expectedPrice) * 10_000;
}
