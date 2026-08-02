import { describe, expect, it } from 'vitest';
import { AegisBlock } from './AegisStrategy';
import {
  CURRENT_BRAIN_AUTHORITY,
  CURRENT_BRAIN_BUNDLE_SHA256,
  CURRENT_BRAIN_CONFIGURATION_SHA256,
  CURRENT_BRAIN_CONTRACT_VERSION,
  CURRENT_BRAIN_FEATURE_COUNT,
  CURRENT_BRAIN_FEATURE_SCHEMA,
  CURRENT_BRAIN_MODEL_ID,
  CURRENT_BRAIN_MODEL_SHA256,
  HYBRID_DIRECTIONAL_AUTHORITY,
  HYBRID_DIRECTIONAL_CONFIGURATION_SHA256,
  HYBRID_DIRECTIONAL_CONTRACT_VERSION,
  HYBRID_DIRECTIONAL_MODEL_ID,
  HYBRID_DIRECTIONAL_MODEL_SHA256,
  inspectCurrentBrainCanonicalDecision,
} from './CurrentBrainCanonicalDecision';

export function canonicalAegisBlock(selected = true, side: 'LONG' | 'SHORT' = 'SHORT'): AegisBlock {
  const decision = selected ? 'ENTER_NOW' : 'DO_NOT_ENTER';
  const action = selected ? side : 'HOLD';
  return {
    candidate: CURRENT_BRAIN_MODEL_ID,
    candidate_status: CURRENT_BRAIN_AUTHORITY,
    live_enabled: true,
    prod: { allowed: selected, execute: selected, action },
    decision_brain: {
      contract_version: CURRENT_BRAIN_CONTRACT_VERSION,
      authority: CURRENT_BRAIN_AUTHORITY,
      mode: 'CURRENT_BRAIN_LIVE',
      execute: selected,
      selected,
      production_allowed: true,
      status: 'LOADED',
      model_version: CURRENT_BRAIN_MODEL_ID,
      model_sha256: CURRENT_BRAIN_MODEL_SHA256,
      bundle_sha256: CURRENT_BRAIN_BUNDLE_SHA256,
      configuration_sha256: CURRENT_BRAIN_CONFIGURATION_SHA256,
      feature_schema: CURRENT_BRAIN_FEATURE_SCHEMA,
      feature_count: CURRENT_BRAIN_FEATURE_COUNT,
      fallback: false,
      symbol: 'ETHUSDT',
      side,
      decision,
      recommendation: decision,
    },
  };
}

describe('CurrentBrainCanonicalDecision', () => {
  it('accepts the owner-authorized hybrid LONG/SHORT experiment contract', () => {
    const block = canonicalAegisBlock();
    block.candidate = HYBRID_DIRECTIONAL_MODEL_ID;
    block.candidate_status = HYBRID_DIRECTIONAL_AUTHORITY;
    block.prod!.action = 'LONG';
    Object.assign(block.decision_brain!, {
      contract_version: HYBRID_DIRECTIONAL_CONTRACT_VERSION,
      authority: HYBRID_DIRECTIONAL_AUTHORITY,
      mode: 'HYBRID_DIRECTIONAL_LIVE',
      model_version: HYBRID_DIRECTIONAL_MODEL_ID,
      model_sha256: HYBRID_DIRECTIONAL_MODEL_SHA256,
      bundle_sha256: HYBRID_DIRECTIONAL_MODEL_SHA256,
      configuration_sha256: HYBRID_DIRECTIONAL_CONFIGURATION_SHA256,
      side: 'LONG',
    });

    expect(inspectCurrentBrainCanonicalDecision(block, 'ETHUSDT')).toEqual({
      recognized: true,
      valid: true,
      selected: true,
      side: 'LONG',
      reason: 'current_brain_canonical_enter_now',
    });
  });

  it('rejects a hybrid experiment contract with the wrong artifact hash', () => {
    const block = canonicalAegisBlock();
    block.candidate = HYBRID_DIRECTIONAL_MODEL_ID;
    block.candidate_status = HYBRID_DIRECTIONAL_AUTHORITY;
    Object.assign(block.decision_brain!, {
      contract_version: HYBRID_DIRECTIONAL_CONTRACT_VERSION,
      authority: HYBRID_DIRECTIONAL_AUTHORITY,
      mode: 'HYBRID_DIRECTIONAL_LIVE',
      model_version: HYBRID_DIRECTIONAL_MODEL_ID,
      model_sha256: 'wrong',
      bundle_sha256: HYBRID_DIRECTIONAL_MODEL_SHA256,
      configuration_sha256: HYBRID_DIRECTIONAL_CONFIGURATION_SHA256,
    });

    expect(inspectCurrentBrainCanonicalDecision(block, 'ETHUSDT')).toMatchObject({
      recognized: true,
      valid: false,
      selected: false,
    });
  });

  it('accepts a coherent selected decision', () => {
    expect(inspectCurrentBrainCanonicalDecision(canonicalAegisBlock(), 'ETHUSDT')).toEqual({
      recognized: true,
      valid: true,
      selected: true,
      side: 'SHORT',
      reason: 'current_brain_canonical_enter_now',
    });
  });

  it('accepts a coherent no-trade decision without authorizing entry', () => {
    expect(inspectCurrentBrainCanonicalDecision(canonicalAegisBlock(false))).toMatchObject({
      recognized: true,
      valid: true,
      selected: false,
      reason: 'current_brain_canonical_do_not_enter',
    });
  });

  it.each([
    ['authority', 'WRONG'],
    ['model_sha256', '0'.repeat(64)],
    ['bundle_sha256', '0'.repeat(64)],
    ['configuration_sha256', '0'.repeat(64)],
    ['feature_schema', 'wrong-schema'],
    ['feature_count', 82],
    ['fallback', true],
  ])('rejects a canonical contract with invalid %s', (field, value) => {
    const block = canonicalAegisBlock();
    (block.decision_brain as Record<string, unknown>)[field] = value;
    expect(inspectCurrentBrainCanonicalDecision(block)).toMatchObject({
      recognized: true,
      valid: false,
      selected: false,
      reason: 'current_brain_canonical_contract_invalid',
    });
  });

  it('rejects disagreement between selection and decision', () => {
    const block = canonicalAegisBlock();
    block.decision_brain!.decision = 'DO_NOT_ENTER';
    expect(inspectCurrentBrainCanonicalDecision(block).valid).toBe(false);
  });

  it('rejects a decision for another symbol', () => {
    expect(inspectCurrentBrainCanonicalDecision(canonicalAegisBlock(), 'BTCUSDT').valid).toBe(
      false,
    );
  });

  it('does not reinterpret a legacy block as canonical', () => {
    expect(inspectCurrentBrainCanonicalDecision({ turbo: { enabled: true } })).toMatchObject({
      recognized: false,
      valid: false,
    });
  });
});
