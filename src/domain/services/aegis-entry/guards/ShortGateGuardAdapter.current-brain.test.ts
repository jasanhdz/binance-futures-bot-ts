import { describe, expect, it } from 'vitest';
import {
  CURRENT_BRAIN_AUTHORITY,
  CURRENT_BRAIN_BUNDLE_SHA256,
  CURRENT_BRAIN_CONFIGURATION_SHA256,
  CURRENT_BRAIN_CONTRACT_VERSION,
  CURRENT_BRAIN_FEATURE_COUNT,
  CURRENT_BRAIN_FEATURE_SCHEMA,
  CURRENT_BRAIN_MODEL_ID,
  CURRENT_BRAIN_MODEL_SHA256,
} from '../../CurrentBrainCanonicalDecision';
import { AegisEntryContext, AegisEntryGuardPolicy } from '../AegisEntryDecisionTypes';
import { ShortGateGuardAdapter } from './ShortGateGuardAdapter';

const policy: AegisEntryGuardPolicy = { enabled: true, mode: 'ENFORCE' };

function canonicalAegisBlock() {
  return {
    candidate: CURRENT_BRAIN_MODEL_ID,
    candidate_status: CURRENT_BRAIN_AUTHORITY,
    live_enabled: true,
    prod: { allowed: true, execute: true, action: 'SHORT' as const },
    decision_brain: {
      contract_version: CURRENT_BRAIN_CONTRACT_VERSION,
      authority: CURRENT_BRAIN_AUTHORITY,
      mode: 'CURRENT_BRAIN_LIVE',
      execute: true,
      selected: true,
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
      side: 'SHORT' as const,
      decision: 'ENTER_NOW' as const,
      recommendation: 'ENTER_NOW',
    },
  };
}

function context() {
  return {
    symbol: 'ETHUSDT',
    side: 'SHORT',
    turboScore: 0.00001,
    votes: { short: 1 },
    leverage: 20,
    requestedPositionFraction: 0.12,
    signal: {
      symbol: 'ETHUSDT',
      action: 'PASS',
      confidence: 0,
      source: 'AEGIS_SAFE',
      longProb: 0,
      shortProb: 1,
      neutralProb: 0,
      metadata: { aegis: canonicalAegisBlock() },
    },
    shortGate: {
      config: {
        enabled: true,
        min_score: 0.8,
        require_votes: 3,
        max_leverage: 10,
        position_fraction_multiplier: 1,
        block_symbols: [],
      },
    },
  } as unknown as AegisEntryContext;
}

describe('ShortGateGuardAdapter current-brain contract', () => {
  it('bypasses only legacy score and vote checks after exact contract validation', () => {
    const result = ShortGateGuardAdapter.evaluate(context(), policy);

    expect(result.decision).toMatchObject({
      allowed: true,
      reason: 'short_allowed_current_brain_canonical',
      adjustedLeverage: 10,
      adjustedPositionFraction: 0.12,
    });
  });

  it('does not bypass legacy checks when the canonical hash is invalid', () => {
    const input = context();
    input.signal.metadata!.aegis!.decision_brain!.model_sha256 = '0'.repeat(64);

    const result = ShortGateGuardAdapter.evaluate(input, policy);

    expect(result.decision).toMatchObject({
      allowed: false,
      reason: 'short_score_below_premium_threshold',
    });
  });
});
