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

export interface V17FrozenFeatureVector {
  side: V17Side;
  schemaVersion: string;
  schemaHash: string;
  names: string[];
  values: number[];
  dtype: 'float64';
}

interface V17FrozenLinearModel {
  feature_names: string[];
  means: number[];
  scales: number[];
  coefficients: number[];
  intercept: number;
  output: 'PROBABILITY' | 'RAW_SCORE';
}

interface V17TreeNode {
  feature_index: number;
  threshold: number;
  left: number;
  right: number;
  value: number;
  is_leaf: boolean;
  missing_go_to_left: boolean;
}

interface V17TreeEnsemble {
  feature_names: string[];
  aggregation: 'ADDITIVE';
  base_value: number;
  trees: V17TreeNode[][];
}

export interface V17ResearchSideArtifact {
  status: string;
  feature_schema_hash: string;
  models: {
    clean: V17FrozenLinearModel;
    danger: V17FrozenLinearModel;
    mae_q90: V17TreeEnsemble;
    ranker: V17FrozenLinearModel;
  };
  gate: {
    thresholds: {
      minimum_clean_probability: number;
      maximum_danger_probability: number;
      maximum_mae_q90: number;
    };
  };
  policy: { minimum_score: number } | null;
}

function finite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new Error(`V17_NON_FINITE_${name}`);
  return value;
}

function sameNames(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

function evaluateLinear(model: V17FrozenLinearModel, vector: V17FrozenFeatureVector): number {
  if (
    !sameNames(model.feature_names, vector.names) ||
    model.means.length !== vector.values.length ||
    model.scales.length !== vector.values.length ||
    model.coefficients.length !== vector.values.length
  ) {
    throw new Error('V17_LINEAR_FEATURE_CONTRACT_MISMATCH');
  }
  let raw = finite(model.intercept, 'LINEAR_INTERCEPT');
  for (let index = 0; index < vector.values.length; index += 1) {
    const scale = finite(model.scales[index], 'LINEAR_SCALE');
    if (scale <= 0) throw new Error('V17_LINEAR_SCALE_INVALID');
    raw +=
      finite(model.coefficients[index], 'LINEAR_COEFFICIENT') *
      ((finite(vector.values[index], 'FEATURE_VALUE') - finite(model.means[index], 'LINEAR_MEAN')) /
        scale);
  }
  return model.output === 'PROBABILITY' ? 1 / (1 + Math.exp(-raw)) : raw;
}

function evaluateTree(tree: V17TreeNode[], values: number[]): number {
  let index = 0;
  for (let step = 0; step <= tree.length; step += 1) {
    const node = tree[index];
    if (!node) throw new Error('V17_TREE_CHILD_INVALID');
    if (node.is_leaf) return finite(node.value, 'TREE_LEAF');
    const value = finite(values[node.feature_index], 'TREE_FEATURE');
    index = value <= finite(node.threshold, 'TREE_THRESHOLD') ? node.left : node.right;
  }
  throw new Error('V17_TREE_CYCLE');
}

function evaluateTreeEnsemble(model: V17TreeEnsemble, vector: V17FrozenFeatureVector): number {
  if (!sameNames(model.feature_names, vector.names) || model.aggregation !== 'ADDITIVE') {
    throw new Error('V17_TREE_FEATURE_CONTRACT_MISMATCH');
  }
  return (
    finite(model.base_value, 'TREE_BASE') +
    model.trees.reduce((sum, tree) => sum + evaluateTree(tree, vector.values), 0)
  );
}

export function evaluateV17ResearchArtifact(
  artifact: V17ResearchSideArtifact,
  vector: V17FrozenFeatureVector,
): {
  clean_probability: number;
  danger_probability: number;
  mae_q90: number;
  rank_score: number;
  selected: boolean;
  policy_status: string;
} {
  if (
    vector.dtype !== 'float64' ||
    vector.schemaVersion !== 'aegis-v17-v9-directional-features-v1' ||
    vector.schemaHash !== artifact.feature_schema_hash ||
    !vector.values.every(Number.isFinite)
  ) {
    throw new Error('V17_FEATURE_CONTRACT_MISMATCH');
  }
  const clean = evaluateLinear(artifact.models.clean, vector);
  const danger = evaluateLinear(artifact.models.danger, vector);
  const mae = Math.max(0, evaluateTreeEnsemble(artifact.models.mae_q90, vector));
  const rank = evaluateLinear(artifact.models.ranker, vector);
  const threshold = artifact.gate.thresholds;
  const selected =
    artifact.policy !== null &&
    clean >= threshold.minimum_clean_probability &&
    danger <= threshold.maximum_danger_probability &&
    mae <= threshold.maximum_mae_q90 &&
    rank >= artifact.policy.minimum_score;
  return {
    clean_probability: clean,
    danger_probability: danger,
    mae_q90: mae,
    rank_score: rank,
    selected,
    policy_status: artifact.status,
  };
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
