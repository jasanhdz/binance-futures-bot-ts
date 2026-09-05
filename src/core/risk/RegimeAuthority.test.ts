import { describe, expect, it } from 'vitest';
import {
  REGIME_AUTHORITY,
  modeAuthorityRole,
  isHeuristicConfidence,
  regimeContextIsInformational,
  engineV2HasAuthority,
} from './RegimeAuthority';

describe('RegimeAuthority', () => {
  it('defines correct static authority mapping', () => {
    expect(REGIME_AUTHORITY.LEGACY.role).toBe('AUTHORITATIVE');
    expect(REGIME_AUTHORITY.ENGINE_V2.role).toBe('INFORMATIONAL');
  });

  it('OFF mode is informational', () => {
    expect(modeAuthorityRole('OFF')).toBe('INFORMATIONAL');
  });

  it('SHADOW mode is informational', () => {
    expect(modeAuthorityRole('SHADOW')).toBe('INFORMATIONAL');
  });

  it('ENFORCE mode is authoritative', () => {
    expect(modeAuthorityRole('ENFORCE')).toBe('AUTHORITATIVE');
  });

  it('validates heuristic confidence range', () => {
    expect(isHeuristicConfidence(0.5)).toBe(true);
    expect(isHeuristicConfidence(0)).toBe(true);
    expect(isHeuristicConfidence(1)).toBe(true);
    expect(isHeuristicConfidence(NaN)).toBe(false);
    expect(isHeuristicConfidence(Infinity)).toBe(false);
    expect(isHeuristicConfidence(-0.1)).toBe(false);
    expect(isHeuristicConfidence(1.1)).toBe(false);
  });

  it('regimeContextIsInformational for OFF/SHADOW mode', () => {
    const offDecision = {
      regime: 'MOMENTUM_UP' as const,
      confidence: 0.8,
      allowed: true,
      wouldBlock: false,
      reason: 'regime_trade_allowed' as const,
      source: 'HYBRID_HEURISTIC' as const,
      metadata: { mode: 'OFF' },
    };
    expect(regimeContextIsInformational(offDecision)).toBe(true);

    const shadowDecision = { ...offDecision, metadata: { mode: 'SHADOW' } };
    expect(regimeContextIsInformational(shadowDecision)).toBe(true);
  });

  it('regimeContextIsInformational when blocked', () => {
    const blocked = {
      regime: 'RISK_OFF' as const,
      confidence: 0.9,
      allowed: false,
      wouldBlock: true,
      reason: 'regime_risk_off_block' as const,
      source: 'HYBRID_HEURISTIC' as const,
      metadata: { mode: 'ENFORCE' },
    };
    expect(regimeContextIsInformational(blocked)).toBe(true);
  });

  it('regimeContextIsInformational returns false for ENFORCE allowed', () => {
    const allowed = {
      regime: 'MOMENTUM_UP' as const,
      confidence: 0.8,
      allowed: true,
      wouldBlock: false,
      reason: 'regime_trade_allowed' as const,
      source: 'HYBRID_HEURISTIC' as const,
      metadata: { mode: 'ENFORCE' },
    };
    expect(regimeContextIsInformational(allowed)).toBe(false);
  });

  it('engineV2HasAuthority always returns false', () => {
    expect(engineV2HasAuthority()).toBe(false);
  });
});
