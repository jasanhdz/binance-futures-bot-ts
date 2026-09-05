import { describe, expect, it } from 'vitest';
import {
  REGIME_AUTHORITY,
  REGIME_CONTEXT_AUTHORITY,
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

  it('context authority is informational independently of policy or decision', () => {
    expect(REGIME_CONTEXT_AUTHORITY).toEqual({
      source: 'LEGACY',
      role: 'INFORMATIONAL',
      confidenceKind: 'HEURISTIC_NOT_PROBABILITY',
    });
    expect(regimeContextIsInformational()).toBe(true);
  });

  it('engineV2HasAuthority always returns false', () => {
    expect(engineV2HasAuthority()).toBe(false);
  });
});
