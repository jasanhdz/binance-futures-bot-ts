import { describe, expect, it } from 'vitest';
import { evaluateAegisExitEyeV2Shadow } from './AegisExitEyeV2Shadow';

const canonical = {
  recognized: true,
  valid: true,
  selected: true,
  side: 'SHORT' as const,
  reason: 'current_brain_canonical_enter_now',
};

function input(overrides: Record<string, unknown> = {}) {
  return {
    symbol: 'BTCUSDT',
    positionSide: 'SHORT' as const,
    currentRoe: 0.08,
    peakRoe: 0.12,
    canonical,
    minimumPeakRoeToStudyProtection: 0.12,
    minimumGivebackRoeToStudyProtection: 0.04,
    ...overrides,
  };
}

describe('AegisExitEyeV2Shadow', () => {
  it('keeps management when canonical direction still supports the position', () => {
    const decision = evaluateAegisExitEyeV2Shadow(input());
    expect(decision.action).toBe('KEEP_MANAGING');
    expect(decision.legacyVoteCountUsed).toBe(false);
    expect(decision.selectionEffect).toBe('NONE');
    expect(decision.exchangeAuthority).toBe(false);
    expect(decision.exchangeMutations).toBe(0);
  });

  it('observes an opposite profitable direction without executing a close', () => {
    const decision = evaluateAegisExitEyeV2Shadow(
      input({
        positionSide: 'LONG',
      }),
    );
    expect(decision.action).toBe('EXIT_RECOMMENDED');
    expect(decision.wouldRecommendExit).toBe(true);
    expect(decision.exchangeAuthority).toBe(false);
  });

  it('observes profitable giveback without moving the active stop', () => {
    const decision = evaluateAegisExitEyeV2Shadow(
      input({
        currentRoe: 0.08,
        peakRoe: 0.13,
        canonical: { ...canonical, selected: false, side: undefined },
      }),
    );
    expect(decision.action).toBe('PROTECT_PROFIT');
    expect(decision.wouldProtectProfit).toBe(true);
    expect(decision.exchangeMutations).toBe(0);
  });

  it('does not interpret HOLD as an exit when evidence is insufficient', () => {
    const decision = evaluateAegisExitEyeV2Shadow(
      input({
        currentRoe: -0.02,
        canonical: { ...canonical, selected: false, side: undefined },
      }),
    );
    expect(decision.action).toBe('UNKNOWN');
    expect(decision.wouldRecommendExit).toBe(false);
    expect(decision.wouldProtectProfit).toBe(false);
  });
});
