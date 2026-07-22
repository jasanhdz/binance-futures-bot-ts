import { AegisBlock } from './AegisStrategy';

export const CURRENT_BRAIN_CONTRACT_VERSION = 'aegis-current-brain-live-decision-v1';
export const CURRENT_BRAIN_AUTHORITY = 'OWNER_AUTHORIZED_CURRENT_PYTHON_COMMITTEE_LIVE_INTEGRATION';
export const CURRENT_BRAIN_MODEL_ID = 'aegis-prospective-shadow-candidate-v1';
export const CURRENT_BRAIN_MODEL_SHA256 =
  '386742c20d74a3b67d47cd95629c646195472e05e9e8d136587d40989a82e3d1';
export const CURRENT_BRAIN_BUNDLE_SHA256 =
  '23b22403b70f7d6c385d1214e6543197f4ca4e57269af19b1013987891ed550a';
export const CURRENT_BRAIN_CONFIGURATION_SHA256 =
  'f944b0210b31928a519dc63459be3f1d53de811517dc1bbe9753596314579ec1';
export const CURRENT_BRAIN_FEATURE_SCHEMA = 'aegis-features-v2';
export const CURRENT_BRAIN_FEATURE_COUNT = 83;

export interface CurrentBrainCanonicalDecision {
  recognized: boolean;
  valid: boolean;
  selected: boolean;
  side?: 'LONG' | 'SHORT';
  reason: string;
}

export function inspectCurrentBrainCanonicalDecision(
  aegis?: AegisBlock,
  expectedSymbol?: string,
): CurrentBrainCanonicalDecision {
  const brain = aegis?.decision_brain;
  if (brain?.contract_version !== CURRENT_BRAIN_CONTRACT_VERSION) {
    return {
      recognized: false,
      valid: false,
      selected: false,
      reason: 'current_brain_contract_not_present',
    };
  }

  const selected = brain.selected === true;
  const side = brain.side === 'LONG' || brain.side === 'SHORT' ? brain.side : undefined;
  const expectedDecision = selected ? 'ENTER_NOW' : 'DO_NOT_ENTER';
  const identityValid =
    brain.authority === CURRENT_BRAIN_AUTHORITY &&
    brain.mode === 'CURRENT_BRAIN_LIVE' &&
    brain.status === 'LOADED' &&
    brain.production_allowed === true &&
    brain.model_version === CURRENT_BRAIN_MODEL_ID &&
    brain.model_sha256 === CURRENT_BRAIN_MODEL_SHA256 &&
    brain.bundle_sha256 === CURRENT_BRAIN_BUNDLE_SHA256 &&
    brain.configuration_sha256 === CURRENT_BRAIN_CONFIGURATION_SHA256 &&
    brain.feature_schema === CURRENT_BRAIN_FEATURE_SCHEMA &&
    brain.feature_count === CURRENT_BRAIN_FEATURE_COUNT &&
    brain.fallback === false &&
    (!expectedSymbol || brain.symbol === expectedSymbol.trim().toUpperCase()) &&
    aegis?.candidate === CURRENT_BRAIN_MODEL_ID &&
    aegis?.candidate_status === CURRENT_BRAIN_AUTHORITY &&
    aegis?.live_enabled === true;
  const decisionValid =
    brain.decision === expectedDecision &&
    brain.recommendation === expectedDecision &&
    brain.execute === selected &&
    (!selected || side !== undefined);
  const prodValid =
    aegis?.prod?.allowed === selected &&
    aegis?.prod?.execute === selected &&
    aegis?.prod?.action === (selected ? side : 'HOLD');

  if (!identityValid || !decisionValid || !prodValid) {
    return {
      recognized: true,
      valid: false,
      selected: false,
      reason: 'current_brain_canonical_contract_invalid',
    };
  }
  return {
    recognized: true,
    valid: true,
    selected,
    side,
    reason: selected ? 'current_brain_canonical_enter_now' : 'current_brain_canonical_do_not_enter',
  };
}
