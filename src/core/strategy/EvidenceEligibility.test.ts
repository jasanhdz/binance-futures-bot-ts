import { describe, expect, it } from 'vitest';
import { classifyEvidence, summarizeEvidence } from './EvidenceEligibility';
import { analyzeMicroBurstProspective } from '../../tooling/micro-burst/MicroBurstProspectiveAnalyzer';

const market = {
  schemaVersion: 1,
  strategyId: 'MICRO_BURST',
  strategyVersion: 'MICRO',
  codeCommitSha: 'a'.repeat(40),
  configHash: 'b'.repeat(64),
  shadowSignalId: 'market-1',
  symbol: 'ETHUSDT',
  side: 'LONG',
  snapshotAtMs: 1_700_000_000_000,
  cohortId: 'UNOFFICIAL',
  liveExecution: false,
};
describe('read-only evidence eligibility', () => {
  it.each([
    ['live-signal', '0.8.0-expected-continuation-shadow'],
    ['runtime-golden', 'golden'],
  ])(
    'recognizes legacy incident %s only with its full marker combination',
    (shadowSignalId, strategyVersion) => {
      const row = {
        ...market,
        shadowSignalId,
        strategyVersion,
        codeCommitSha: 'UNKNOWN',
        configHash: 'UNKNOWN',
        snapshotAtMs: 1000,
        observedAtMs: 1000,
      };
      const before = JSON.stringify(row);
      expect(classifyEvidence(row)).toMatchObject({
        category: 'SYNTHETIC',
        reason: 'KNOWN_LEGACY_RUNTIME_FIXTURE',
        researchEligible: false,
      });
      expect(JSON.stringify(row)).toBe(before);
      expect(classifyEvidence({ ...row, shadowSignalId: 'other' }).category).toBe(
        'INSUFFICIENT_PROVENANCE',
      );
    },
  );
  it('keeps legitimate unofficial SHADOW research, excludes explicit synthetic with plausible timestamps, and never certifies LIVE fills', () => {
    expect(classifyEvidence(market).researchEligible).toBe(true);
    expect(
      classifyEvidence({ ...market, configHash: `sha256:${market.configHash}` }).researchEligible,
    ).toBe(true);
    expect(classifyEvidence({ ...market, evidenceOrigin: 'SYNTHETIC' }).researchEligible).toBe(
      false,
    );
    expect(
      classifyEvidence({ ...market, mode: 'LIVE', liveExecution: true, accountVerified: true })
        .liveEconomicsEligible,
    ).toBe(false);
    expect(
      summarizeEvidence([market, { ...market, evidenceOrigin: 'TEST' }, { shadowSignalId: 'old' }]),
    ).toMatchObject({ rowsSeen: 3, eligibleRows: 1, excludedRows: 2 });
  });
  it('requires an eligible matching signal for outcome economics; keeps raw coverage visible', () => {
    const outcome = {
      ...market,
      episodeId: 'episode',
      completedAtMs: market.snapshotAtMs + 1000,
      signalAtMs: market.snapshotAtMs,
      horizons: {},
      grossBps: 20,
      costScenarios: { cost_14: 6 },
    };
    const text = (signals: object[], outcomes: object[]) =>
      analyzeMicroBurstProspective({ signals: signals as any, outcomes: outcomes as any }).text;
    expect(text([market], [outcome])).toContain('Research outcomes eligible=1; excluded=0');
    expect(text([], [outcome])).toContain('Research outcomes eligible=0; excluded=1');
    expect(text([{ ...market, evidenceOrigin: 'TEST' }], [outcome])).toContain(
      'Research outcomes eligible=0; excluded=1',
    );
    expect(text([market], [{ ...outcome, configHash: 'c'.repeat(64) }])).toContain(
      'Research outcomes eligible=0; excluded=1',
    );
  });
});
