import { describe, expect, it } from 'vitest';
import { buildAegisOperationalDispositionShadow } from './AegisOperationalDispositionShadow';

describe('AegisOperationalDispositionShadow', () => {
  it('correlates Python rank with an operational denial without changing selection', () => {
    const record = buildAegisOperationalDispositionShadow({
      symbol: 'AVAXUSDT',
      stage: 'ENTRY_POLICY',
      intelligence: {
        mode: 'SHADOW',
        decision_cycle_id: 'cycle-1',
        market_timestamp: '2026-08-01T00:00:00Z',
        current_symbol_canonical_rank: 1,
        current_symbol_timing_rank: 4,
        entry_timing_shadow: { state: 'WAITING_FOR_RETEST' },
      },
      operationalAllowed: false,
      operationalReason: 'active_cooldown',
      deniedBy: 'operational_state',
    });

    expect(record).toMatchObject({
      mode: 'SHADOW',
      pythonCanonicalRank: 1,
      pythonTimingRank: 4,
      pythonTimingState: 'WAITING_FOR_RETEST',
      operationalAllowed: false,
      fallbackToNextCandidate: 'NOT_IMPLEMENTED_OBSERVATION_ONLY',
      selectionEffect: 'NONE',
      exchangeAuthority: false,
      exchangeMutations: 0,
    });
  });

  it('ignores absent or non-Shadow intelligence', () => {
    expect(
      buildAegisOperationalDispositionShadow({
        symbol: 'BTCUSDT',
        stage: 'MICRO_GATE',
        operationalAllowed: true,
        operationalReason: 'allowed',
      }),
    ).toBeUndefined();
    expect(
      buildAegisOperationalDispositionShadow({
        symbol: 'BTCUSDT',
        stage: 'MICRO_GATE',
        intelligence: { mode: 'LIVE' },
        operationalAllowed: true,
        operationalReason: 'allowed',
      }),
    ).toBeUndefined();
  });
});
