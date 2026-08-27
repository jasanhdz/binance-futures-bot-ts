import { describe, expect, it } from 'vitest';
import { StrictDecisionGate, OperationalContext } from './decision-gate';
import { decisionFixture } from './brain-contract.test';

const context = (overrides: Partial<OperationalContext> = {}): OperationalContext => ({
  mode: 'LIVE', now: '2026-07-17T12:00:10Z', allowedSymbols: ['ADAUSDT', 'DOGEUSDT'], allowedSides: ['SHORT'],
  killSwitchActive: false, explicitAuthorization: true, executionEnabledByConfig: true, availableSlots: 1,
  occupiedSymbols: [], expectedModelBundleId: 'aegis-offline-reference-v1',
  expectedSymbolSetHash: 'f6448e67daf1d017e16cc6b331f6494e97e178824474994fff08864303ccd348',
  expectedFeatureSchemaVersion: 'aegis-features-v1', maximumDecisionAgeMs: 30000,
  acceptedDecisionIds: new Set(), ...overrides,
});

describe('strict decision gate', () => {
  it('allows only a fresh compatible candidate into existing operational gates', () => {
    expect(new StrictDecisionGate().validate(decisionFixture(), context()).decision).toBe('ALLOW_EXISTING_ENTRY_FLOW');
  });

  it.each([
    ['stale decision', { now: '2026-07-17T12:01:00Z' }, 'STALE_DECISION'],
    ['execution disabled', { executionEnabledByConfig: false }, 'EXECUTION_DISABLED_BY_CONFIG'],
    ['kill switch', { killSwitchActive: true }, 'KILL_SWITCH_ACTIVE'],
    ['duplicate', { acceptedDecisionIds: new Set(['decision-1']) }, 'DUPLICATE_DECISION'],
    ['symbol blocked', { allowedSymbols: ['DOGEUSDT'] }, 'SYMBOL_NOT_ALLOWED'],
    ['shadow mode', { mode: 'SHADOW' }, 'SHADOW_MODE_NON_EXECUTING'],
  ])('denies %s', (_, override, code) => {
    const result = new StrictDecisionGate().validate(decisionFixture(), context(override as Partial<OperationalContext>));
    expect(result.decision).toBe('DENY'); expect(result.reasonCodes).toContain(code);
  });

  it('treats NO_TRADE as a first-class denial', () => {
    const result = new StrictDecisionGate().validate({ ...decisionFixture(), status: 'NO_TRADE', selected: [] }, context());
    expect(result.decision).toBe('DENY'); expect(result.reasonCodes).toContain('SCIENTIFIC_NO_TRADE');
  });

  it('rejects LONG while scientific parity is SHORT-only', () => {
    const fixture = decisionFixture();
    const selected = [{ ...fixture.selected[0], side: 'LONG' as const }];
    const result = new StrictDecisionGate().validate({ ...fixture, selected }, context());
    expect(result.decision).toBe('DENY');
    expect(result.reasonCodes).toContain('SIDE_NOT_ALLOWED');
  });
});
