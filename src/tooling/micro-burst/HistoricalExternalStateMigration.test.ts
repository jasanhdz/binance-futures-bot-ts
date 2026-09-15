import { describe, expect, it } from 'vitest';
import { retireHistoricalExternalState } from './HistoricalExternalStateMigration';

const state = {
  mode: 'IDLE' as const,
  marketOpenAmbiguous: true,
  marketOpenClientOrderId: 'unknown',
  positionOwner: 'EXTERNAL' as const,
  tradeOrigin: 'MANUAL_EXTERNAL' as const,
  eligibleForBotMetrics: false,
  microBurstPnlUnverified: true,
  lastTradeId: 'MANUAL-SOLUSDT-1',
};

describe('historical external state migration', () => {
  it('retires only admission ambiguity and preserves unresolved accounting', () => {
    const result = retireHistoricalExternalState(state, {
      migrationId: 'migration-1',
      authorizedAt: '2026-09-15T00:00:00.000Z',
      evidenceSha256: 'evidence-hash',
      previousStateSha256: 'state-hash',
    });
    expect(result).toMatchObject({
      mode: 'IDLE',
      marketOpenAmbiguous: false,
      positionOwner: 'EXTERNAL',
      tradeOrigin: 'MANUAL_EXTERNAL',
      eligibleForBotMetrics: false,
      microBurstPnlUnverified: true,
      historicalAccountingStatus: 'UNRESOLVED',
      historicalResolution: expect.objectContaining({
        kind: 'HISTORICAL_EXTERNAL_STATE_RETIRED_BY_OPERATOR',
      }),
    });
    expect(result.marketOpenClientOrderId).toBeUndefined();
  });

  it('rejects active or non-external states', () => {
    expect(() =>
      retireHistoricalExternalState(
        { ...state, mode: 'LONG_RIDE' },
        {
          migrationId: 'migration-1',
          authorizedAt: '2026-09-15T00:00:00.000Z',
          evidenceSha256: 'evidence-hash',
          previousStateSha256: 'state-hash',
        },
      ),
    ).toThrow('HISTORICAL_EXTERNAL_STATE_NOT_ELIGIBLE');
  });
});
