import { describe, expect, it } from 'vitest';
import { RegimeAvoidShadowEvaluator } from './RegimeAvoidShadowEvaluator';

describe('RegimeAvoidShadowEvaluator', () => {
  it('matches calibrated avoid rule by symbol side and regime', () => {
    const result = RegimeAvoidShadowEvaluator.evaluate({
      symbol: 'ADAUSDT',
      side: 'LONG',
      technicalRegime: 'CHOP',
      finalDecision: 'ALLOW',
      finalStrategy: 'aegis_turbo',
    });

    expect(result).toMatchObject({
      wouldAvoid: true,
      reason: 'calibrated_avoid_regime',
      matchedRegime: 'CHOP',
      source: 'calibration_20260522',
      mode: 'SHADOW',
      notLiveEnforced: true,
    });
  });

  it('does not match when symbol and side have no avoid rule for the regime', () => {
    const result = RegimeAvoidShadowEvaluator.evaluate({
      symbol: 'ADAUSDT',
      side: 'LONG',
      technicalRegime: 'MOMENTUM_UP',
    });

    expect(result).toMatchObject({
      wouldAvoid: false,
      reason: 'no_avoid_rule',
      matchedRegime: 'MOMENTUM_UP',
    });
  });

  it('handles missing regime without throwing', () => {
    const result = RegimeAvoidShadowEvaluator.evaluate({
      symbol: 'ADAUSDT',
      side: 'SHORT',
    });

    expect(result).toMatchObject({
      wouldAvoid: false,
      reason: 'missing_regime',
    });
  });

  it('reports shadow metadata without changing final decision inputs', () => {
    const result = RegimeAvoidShadowEvaluator.evaluate({
      symbol: 'AVAXUSDT',
      side: 'SHORT',
      regimeContext: { label: 'UNKNOWN' },
      finalDecision: 'ALLOW',
      finalStrategy: 'momentum_ride',
      tradeId: 'trade-1',
    });

    expect(result.wouldAvoid).toBe(true);
    expect(result.finalDecision).toBe('ALLOW');
    expect(result.finalStrategy).toBe('momentum_ride');
    expect(result.tradeId).toBe('trade-1');
  });
});
