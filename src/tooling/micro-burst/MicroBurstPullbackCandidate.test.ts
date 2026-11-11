import { afterEach, describe, expect, it } from 'vitest';
import { MicroBurstPullbackCandidate } from './MicroBurstPullbackCandidate';
import { readVerifiedDecisionRecords } from './MicroBurstCaptureSession';
import {
  createSyntheticCaptureSession,
  makeSyntheticDecisionRecord,
} from './MicroBurstCaptureSession.test-support';
import type { ArchiveTrade } from '../../strategies/micro-burst/research/MicroBurstStorage';
import { TEST_SNAPSHOT_AT_MS } from '../../strategies/micro-burst/domain/MicroBurst.test-support';

const BASE = TEST_SNAPSHOT_AT_MS;
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function fixture(
  options: {
    side?: 'LONG' | 'SHORT';
    flat?: boolean;
    opposingFlow?: boolean;
    sequenceGapAt?: number;
    marketGap?: { fromMs: number; throughMs: number };
    rejectBaseline?: boolean;
  } = {},
) {
  const side = options.side ?? 'LONG';
  const start = BASE - 120_000;
  const end = BASE + 10_000;
  const tradeStart = BASE - 61_000;
  const trades: ArchiveTrade[] = [];
  let idOffset = 0;
  for (let index = 0; index <= 71; index++) {
    if (index === options.sequenceGapAt) idOffset++;
    const eventTime = tradeStart + index * 1000;
    const directionalSign = side === 'LONG' ? 1 : -1;
    trades.push({
      symbol: 'SOLUSDT',
      eventTime,
      receivedAtMs: eventTime,
      aggregateTradeId: index + idOffset + 1,
      price: options.flat ? 100 : 100 + directionalSign * index * 0.01,
      quantity: 1,
      isBuyerMaker: (side === 'SHORT') !== Boolean(options.opposingFlow),
    });
  }
  const records = [0, 1000, 2000, 3000, 4000].map((offset) =>
    makeSyntheticDecisionRecord(BASE + offset, side, 'SOLUSDT', {
      rejectBaseline: options.rejectBaseline,
    }),
  );
  const session = await createSyntheticCaptureSession({
    startedAtMs: start,
    completedAtMs: end,
    storageNowMs: start,
    trades,
    decisionRecords: records,
    gaps: options.marketGap
      ? [
          {
            symbol: 'SOLUSDT',
            startedAtMs: options.marketGap.fromMs,
            endedAtMs: options.marketGap.throughMs,
            feed: 'AGG_TRADE',
          },
        ]
      : [],
  });
  cleanups.push(session.cleanup);
  const verifiedRecords = await readVerifiedDecisionRecords(session.session, BASE, BASE + 4000);
  return { ...session, records: verifiedRecords };
}

describe('archive-verified Pullback continuation selector', () => {
  it.each(['LONG', 'SHORT'] as const)(
    'qualifies %s only after fresh, sequence-verified evidence persists',
    async (side) => {
      const captured = await fixture({ side });
      const candidate = new MicroBurstPullbackCandidate();
      const observations = [];
      for (const record of captured.records)
        observations.push(await candidate.evaluate(captured.session, record));

      expect(captured.records.every((record) => record.decision === 'ENTRY_INTENT')).toBe(true);
      expect(observations.map((row) => row.candidate)).toEqual([
        'WAIT',
        'WAIT',
        'WAIT',
        'QUALIFIED',
        'QUALIFIED',
      ]);
      expect(observations.every((row) => row.executionEligibility === 'NOT_EVALUATED')).toBe(true);
      expect(
        observations.every((row) => row.sourceArtifactHash === captured.session.artifactHash),
      ).toBe(true);
    },
  );

  it('rejects copied or caller-authored decision records before evaluating them', async () => {
    const captured = await fixture();
    const candidate = new MicroBurstPullbackCandidate();
    await expect(
      candidate.evaluate(captured.session, { ...captured.records[0], reason: 'FORGED' }),
    ).rejects.toThrow('PULLBACK_REPLAY_REQUIRES_VERIFIED_CAPTURE_RECORD');
  });

  it('rejects an indexed aggregate-trade sequence gap as non-evaluable evidence', async () => {
    const captured = await fixture({ sequenceGapAt: 20 });
    const observation = await new MicroBurstPullbackCandidate().evaluate(
      captured.session,
      captured.records[0],
    );
    expect(observation).toMatchObject({
      candidate: 'REJECT',
      reason: 'TRADE_SEQUENCE_INVALID',
    });
  });

  it('rejects a persisted aggTrade gap without interpolating the window', async () => {
    const captured = await fixture({ marketGap: { fromMs: BASE - 10, throughMs: BASE + 10 } });
    const observation = await new MicroBurstPullbackCandidate().evaluate(
      captured.session,
      captured.records[0],
    );
    expect(observation).toMatchObject({ candidate: 'REJECT', reason: 'ARCHIVED_FEED_GAP' });
  });

  it('does not borrow post-decision movement to create a price response', async () => {
    const captured = await fixture({ flat: true });
    const observation = await new MicroBurstPullbackCandidate().evaluate(
      captured.session,
      captured.records[0],
    );
    expect(observation).toMatchObject({ candidate: 'REJECT', reason: 'PRICE_NOT_RESPONDING' });
  });

  it('preserves current-policy rejection as a rejection and never creates a candidate entry', async () => {
    const captured = await fixture({ rejectBaseline: true });
    expect(captured.records.every((record) => record.decision === 'NO_TRADE')).toBe(true);
    const observation = await new MicroBurstPullbackCandidate().evaluate(
      captured.session,
      captured.records[0],
    );
    expect(observation).toMatchObject({
      authority: 'SHADOW_ONLY',
      candidate: 'REJECT',
      reason: 'BASELINE_REJECTED',
      executionEligibility: 'NOT_EVALUATED',
    });
  });

  it('does not accumulate persistence from a repeated captured decision', async () => {
    const captured = await fixture();
    const candidate = new MicroBurstPullbackCandidate();
    expect((await candidate.evaluate(captured.session, captured.records[0])).reason).toBe(
      'PERSISTENCE_STARTED',
    );
    expect((await candidate.evaluate(captured.session, captured.records[0])).reason).toBe(
      'NON_MONOTONIC_OBSERVATION',
    );
  });
});
