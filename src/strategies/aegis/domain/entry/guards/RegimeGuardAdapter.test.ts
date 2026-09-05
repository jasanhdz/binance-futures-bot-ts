import { describe, expect, it } from 'vitest';
import { RegimeGuardAdapter } from './RegimeGuardAdapter';

describe('RegimeGuardAdapter', () => {
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
