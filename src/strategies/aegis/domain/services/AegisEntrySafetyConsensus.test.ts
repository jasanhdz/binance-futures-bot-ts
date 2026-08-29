import { describe, expect, it } from 'vitest';
import { evaluateAegisEntrySafetyConsensus } from './AegisEntrySafetyConsensus';
import {
  AegisEntryDecisionResult,
  AegisEntryGuardResult,
} from '../entry/AegisEntryDecisionTypes';

function guard(
  name: AegisEntryGuardResult['name'],
  wouldBlock: boolean,
  metadata: Record<string, unknown> = {},
): AegisEntryGuardResult {
  return {
    name,
    enabled: true,
    mode: 'SHADOW',
    decision: wouldBlock ? 'SHADOW_DENY' : 'ALLOW',
    reason: wouldBlock ? `${name}_risk` : `${name}_clear`,
    wouldBlock,
    enforced: false,
    metadata,
  };
}

function decision(guards: AegisEntryGuardResult[], validRegime = false): AegisEntryDecisionResult {
  return {
    allowed: true,
    finalDecision: 'ALLOW',
    finalReason: 'all_enforced_guards_allowed',
    finalStrategy: 'aegis_turbo',
    strategy: 'aegis_turbo',
    shouldOpen: true,
    adjustedLeverage: 15,
    adjustedPositionFraction: 0.08,
    guards,
    strategyCandidates: {
      aegis_turbo: { decision: 'ALLOW', reason: 'all_enforced_guards_allowed' },
    },
    warnings: [],
    decisions: validRegime
      ? {
          regimeContext: {
            label: 'HIGH_VOL_RISK',
            confidence: 0.8,
            momentumLongAllowed: false,
            momentumShortAllowed: false,
            trendDirection: 'UP',
            chopRisk: 0.4,
            exhaustionRisk: 0.9,
            volatilityState: 'HIGH',
            volumeState: 'HIGH',
            reasons: ['regime_tail_risk_high'],
            indicators: {
              emaFast: 75,
              emaFastSlope: 0.01,
              atrPct: 0.004,
              atrPercentile: 0.95,
              volumeRatio: 2,
            },
          },
        }
      : {},
    trace: {} as AegisEntryDecisionResult['trace'],
    metadata: {} as AegisEntryDecisionResult['metadata'],
  };
}

const config = {
  enabled: true,
  mode: 'SHADOW' as const,
  minimumRootRiskFamilies: 2,
  criticalLongVetoMode: 'ENFORCE' as const,
  requireValidRegimeForCriticalLong: true,
};

const derivedRiskChain = [
  guard('regime', true),
  guard('event_risk', true),
  guard('entry_quality', true),
  guard('decision_brain', true),
  guard('clean_entry', true),
];

describe('AegisEntrySafetyConsensus', () => {
  it('counts correlated quality adapters as one root family and leaves SHORT in Shadow', () => {
    const result = evaluateAegisEntrySafetyConsensus({
      side: 'SHORT',
      config,
      entryDecision: decision([
        ...derivedRiskChain,
        guard('long_risk_shadow', false, { longRiskShadow: { riskLevel: 'LOW' } }),
      ]),
    });

    expect(result).toMatchObject({
      allowed: true,
      enforced: false,
      wouldBlock: true,
      reason: 'entry_safety_root_consensus_shadow_block',
      riskFamilies: ['regime', 'quality_chain'],
      riskFamilyCount: 2,
    });
    expect(result.derivedWarnings).toEqual([
      'entry_quality',
      'event_risk',
      'decision_brain',
      'clean_entry',
    ]);
  });

  it('keeps the narrow critical LONG veto when regime evidence is populated', () => {
    const result = evaluateAegisEntrySafetyConsensus({
      side: 'LONG',
      config,
      entryDecision: decision(
        [
          ...derivedRiskChain,
          guard('long_risk_shadow', true, { longRiskShadow: { riskLevel: 'CRITICAL' } }),
        ],
        true,
      ),
    });

    expect(result).toMatchObject({
      allowed: false,
      enforced: true,
      reason: 'entry_safety_critical_long_veto',
      regimeDataValid: true,
      criticalLongVetoWouldBlock: true,
      longRiskLevel: 'CRITICAL',
    });
  });

  it('does not enforce the critical LONG veto with UNKNOWN or empty regime data', () => {
    const result = evaluateAegisEntrySafetyConsensus({
      side: 'LONG',
      config,
      entryDecision: decision([
        ...derivedRiskChain,
        guard('long_risk_shadow', true, { longRiskShadow: { riskLevel: 'CRITICAL' } }),
      ]),
    });

    expect(result).toMatchObject({
      allowed: true,
      enforced: false,
      regimeDataValid: false,
      criticalLongVetoWouldBlock: false,
    });
  });

  it('does not block from one isolated root warning', () => {
    const result = evaluateAegisEntrySafetyConsensus({
      side: 'SHORT',
      config,
      entryDecision: decision([
        guard('regime', false),
        guard('entry_quality', true),
        guard('event_risk', false),
        guard('decision_brain', false),
        guard('clean_entry', false),
      ]),
    });

    expect(result).toMatchObject({ allowed: true, wouldBlock: false, riskFamilyCount: 1 });
  });
});
