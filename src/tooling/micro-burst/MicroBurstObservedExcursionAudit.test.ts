import { expect, it } from 'vitest';
import type { ProspectiveOutcomeRecord } from '../../strategies/micro-burst/research/MicroBurstOutcomeTypes';
import { auditObservedExcursions } from './MicroBurstObservedExcursionAudit';

it('excludes pre-fill and post-exit extrema without inventing executable profit or position MFE', () => {
  const outcome = {
    shadowSignalId: 'signal',
    side: 'LONG',
    signalAtMs: 1000,
    entryOutcomes: {
      SIGNAL_PRICE: {
        assumption: { available: true, entryPrice: 100 },
        horizons: {
          10000: {
            horizonMs: 10000,
            tradeCount: 10,
            mfeBps: 20,
            timeToMfeMs: 100,
            maeBps: 10,
            timeToMaeMs: 9000,
          },
          20000: {
            horizonMs: 20000,
            tradeCount: 20,
            mfeBps: 30,
            timeToMfeMs: 2000,
            maeBps: 0,
            timeToMaeMs: 0,
          },
        },
      },
    },
  } as unknown as ProspectiveOutcomeRecord;
  const actual = {
    shadowSignalId: 'signal',
    side: 'LONG' as const,
    entryPrice: 100.1,
    entryAtMs: 1500,
    exitAtMs: 5000,
  };
  const result = auditObservedExcursions(outcome, actual);
  expect(result.executableProfitOpportunity).toBe('UNKNOWN');
  expect(result.horizons[0]).toMatchObject({
    favorableObservation: { status: 'BEFORE_ACTUAL_ENTRY', returnFromActualEntryBps: null },
    adverseObservation: { status: 'AFTER_ACTUAL_EXIT' },
    actualPositionMfeBps: null,
  });
  expect(result.horizons[1].favorableObservation).toMatchObject({
    status: 'OBSERVED_DURING_POSITION',
    price: 100.29999999999998,
  });
  expect(result.horizons[1].adverseObservation.status).toBe('SIGNAL_BASELINE_NOT_A_TRADE');
  expect(() => auditObservedExcursions(outcome, { ...actual, shadowSignalId: 'other' })).toThrow(
    'SIGNAL_IDENTITY_MISMATCH',
  );
});
