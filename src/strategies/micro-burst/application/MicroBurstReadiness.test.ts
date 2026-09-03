import { describe, expect, it } from 'vitest';
import {
  assessMicroBurstReadiness,
  MicroBurstReadinessInput,
} from '../application/MicroBurstReadiness';

const complete: MicroBurstReadinessInput = {
  codeSha: 'abc123',
  configHash: 'def456',
  strategyVersion: '0.6.0',
  cohortId: 'MBV1-M3_2-abc123-def456',
  officialCohortReady: true,
  mode: 'SHADOW',
  enabled: true,
  enabledSymbolCount: 2,
  healthyBookCount: 2,
  btcHealthy: true,
  aggTradeHealthy: true,
  archiveEnabled: true,
  archiveAvailable: true,
  archiveHealthy: true,
  storageHealthy: true,
  storageErrors: 0,
  unresolvedTradeGaps: 0,
  mutationAuditAvailable: true,
  preregistrationEnabled: true,
  manifestValid: true,
  databaseValid: true,
  schemaValid: true,
  episodeDefinitionValid: true,
  gapSemanticsValid: true,
  costSemanticsValid: true,
};

describe('Micro Burst readiness', () => {
  it('denies LIVE authority while the candidate awaits black-box validation', () => {
    const result = assessMicroBurstReadiness({ ...complete, mode: 'LIVE' });
    expect(result.liveAuthority).toBe(false);
    expect(result.ready).toBe(false);
    expect(result.blockers).toContain('LIVEFLAGS_NOT_READY');
  });

  it('is complete only when every requested check is evidenced', () => {
    const result = assessMicroBurstReadiness(complete);
    expect(result.ready).toBe(true);
    expect(result.readyForSoak).toBe(true);
    expect(result.readyForFreeze).toBe(true);
    expect(result.officialAuthority).toBe(true);
    expect(Object.values(result.checks).every(Boolean)).toBe(true);
    expect(result.official).toBe(false);
    expect(result.liveAuthority).toBe(false);
  });

  it('fails closed for unknown runtime evidence', () => {
    const result = assessMicroBurstReadiness({ ...complete, manifestValid: undefined });
    expect(result.ready).toBe(false);
    expect(result.checks.manifest).toBe(false);
    expect(result.blockers).toContain('MANIFEST_NOT_READY');
  });

  it('does not infer official readiness from a SHA and cohort prefix', () => {
    const result = assessMicroBurstReadiness({ ...complete, officialCohortReady: undefined });
    expect(result.checks.cohort).toBe(true);
    expect(result.ready).toBe(true);
    expect(result.readyForSoak).toBe(true);
    expect(result.readyForFreeze).toBe(false);
    expect(result.officialAuthority).toBe(false);
    expect(result.official).toBe(false);
  });
});
