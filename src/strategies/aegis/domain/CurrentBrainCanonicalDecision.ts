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

export const HYBRID_DIRECTIONAL_CONTRACT_VERSION = 'aegis-hybrid-directional-live-decision-v2';
export const HYBRID_DIRECTIONAL_AUTHORITY =
  'OWNER_AUTHORIZED_HYBRID_DIRECTIONAL_MULTI_SYMBOL_5M_QUALITY_SELECTION_V2';
export const HYBRID_DIRECTIONAL_MODEL_ID = 'aegis-hybrid-directional-committee-v1';
export const HYBRID_DIRECTIONAL_MODEL_SHA256 =
  'f52dcaa12fe94b6cc9023c25cf95ea2d6fc16296c9b65c2c93d00e13e66ba0e8';
export const HYBRID_DIRECTIONAL_CONFIGURATION_SHA256 =
  '26507443adf07dfc5a90d48a1c5f472f989a26cfe929740bd9e2009c39aaa3a9';

interface DecisionAuthorityProfile {
  authority: string;
  mode: string;
  modelId: string;
  modelSha256: string;
  bundleSha256: string;
  configurationSha256: string;
}

function authorityProfile(contractVersion?: string): DecisionAuthorityProfile | undefined {
  if (contractVersion === CURRENT_BRAIN_CONTRACT_VERSION) {
    return {
      authority: CURRENT_BRAIN_AUTHORITY,
      mode: 'CURRENT_BRAIN_LIVE',
      modelId: CURRENT_BRAIN_MODEL_ID,
      modelSha256: CURRENT_BRAIN_MODEL_SHA256,
      bundleSha256: CURRENT_BRAIN_BUNDLE_SHA256,
      configurationSha256: CURRENT_BRAIN_CONFIGURATION_SHA256,
    };
  }
  if (contractVersion === HYBRID_DIRECTIONAL_CONTRACT_VERSION) {
    return {
      authority: HYBRID_DIRECTIONAL_AUTHORITY,
      mode: 'HYBRID_DIRECTIONAL_LIVE',
      modelId: HYBRID_DIRECTIONAL_MODEL_ID,
      modelSha256: HYBRID_DIRECTIONAL_MODEL_SHA256,
      bundleSha256: HYBRID_DIRECTIONAL_MODEL_SHA256,
      configurationSha256: HYBRID_DIRECTIONAL_CONFIGURATION_SHA256,
    };
  }
  return undefined;
}

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
  const profile = brain ? authorityProfile(brain.contract_version) : undefined;
  if (!brain || !profile) {
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
    brain.authority === profile.authority &&
    brain.mode === profile.mode &&
    brain.status === 'LOADED' &&
    brain.production_allowed === true &&
    brain.model_version === profile.modelId &&
    brain.model_sha256 === profile.modelSha256 &&
    brain.bundle_sha256 === profile.bundleSha256 &&
    brain.configuration_sha256 === profile.configurationSha256 &&
    brain.feature_schema === CURRENT_BRAIN_FEATURE_SCHEMA &&
    brain.feature_count === CURRENT_BRAIN_FEATURE_COUNT &&
    brain.fallback === false &&
    (!expectedSymbol || brain.symbol === expectedSymbol.trim().toUpperCase()) &&
    aegis?.candidate === profile.modelId &&
    aegis?.candidate_status === profile.authority &&
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
