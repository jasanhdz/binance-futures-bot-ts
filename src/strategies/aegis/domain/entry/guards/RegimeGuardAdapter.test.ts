import { describe, expect, it } from 'vitest';
import { RegimeGuardAdapter } from './RegimeGuardAdapter';

describe('RegimeGuardAdapter', () => {
  it.each(['OFF', 'SHADOW', 'ENFORCE'] as const)(
    'missing context cannot be rescued by score in %s',
    (mode) => {
      const result = RegimeGuardAdapter.evaluate(
        {
          symbol: 'DOGEUSDT',
          side: 'SHORT',
          turboScore: 0.99,
          setupGrade: 'A_PLUS',
          eventRisk: { isAltSymbol: true, btcAction: 'SHORT', ethAction: 'SHORT' },
          entryQuality: { tailRiskScore: 0.1 },
          operational: { timestamp: 1 },
        } as any,
        { enabled: true, mode },
      );
      expect(result.guard.decision).toBe(
        mode === 'OFF' ? 'NOT_APPLICABLE' : mode === 'SHADOW' ? 'SHADOW_DENY' : 'DENY',
      );
      if (mode !== 'OFF') {
        expect(result.decision?.regime).toBe('UNKNOWN');
        expect(result.guard.enforced).toBe(mode === 'ENFORCE');
      }
    },
  );
  it('fails closed as UNKNOWN when enabled context is missing', () => {
    const result = RegimeGuardAdapter.evaluate(
      {
        symbol: 'ADAUSDT',
        side: 'SHORT',
        eventRisk: { isAltSymbol: true },
        entryQuality: { entryQualityScore: 0.8, tailRiskScore: 0.1 },
        operational: { timestamp: Date.now() },
      } as any,
      { enabled: true, mode: 'ENFORCE' },
    );

    expect(result.decision?.regime).toBe('UNKNOWN');
    expect(result.decision?.wouldBlock).toBe(true);
    expect(result.guard.decision).toBe('DENY');
  });
});
