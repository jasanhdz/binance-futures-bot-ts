import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { expect, it } from 'vitest';
import {
  causalExecutionBook,
  causalTradeEvidence,
  depthVwap,
  replayCausalDepth,
  replayCausalDepthFromRestSnapshot,
  readVerifiedSegments,
  type ArchiveEvent,
} from './MicroBurstCausalArchive';
import {
  readVerifiedExecutionBookForDecision,
  readVerifiedDecisionRecords,
  readVerifiedFundingEvidence,
} from './MicroBurstCaptureSession';
import { MicroBurstPullbackCandidate, PULLBACK_EXPERIMENT_V1 } from './MicroBurstPullbackCandidate';
import { replayPairedExecutions } from './MicroBurstPairedExecutionReplay';
import { buildVerifiedReplayFrame } from './MicroBurstVerifiedReplayFrame';
import { summarizePairedReplay } from './MicroBurstPairedReplayReport';
import { TEST_SNAPSHOT_AT_MS } from '../../strategies/micro-burst/domain/MicroBurst.test-support';
import {
  createSyntheticCaptureSession,
  makeSyntheticDecisionRecord,
  makeSyntheticNoFundingEvidence,
} from './MicroBurstCaptureSession.test-support';
import type {
  ArchiveDepth,
  ArchiveTrade,
} from '../../strategies/micro-burst/research/MicroBurstStorage';
import { defaultMicroBurstConfig } from '../../strategies/micro-burst/domain/MicroBurstTypes';

const BASE = TEST_SNAPSHOT_AT_MS;

it('verifies segment checksums, sequence evidence, bounded depth, and quantity VWAP', () => {
  const root = mkdtempSync(join(tmpdir(), 'micro-archive-low-level-'));
  try {
    const records: ArchiveEvent[] = Array.from({ length: 4 }, (_, i) => {
      const eventTime = 39_000 + i * 1000;
      return {
        symbol: 'SOLUSDT',
        type: 'trades',
        eventTime,
        receivedAtMs: eventTime,
        payload: {
          symbol: 'SOLUSDT',
          eventTime,
          receivedAtMs: eventTime,
          aggregateTradeId: i + 1,
          price: 100 + i * 0.01,
          quantity: 1,
          isBuyerMaker: false,
        },
      };
    });
    const text = `${records.map((row) => JSON.stringify(row)).join('\n')}\n`;
    const filePath = join(root, 'trades.gz');
    writeFileSync(filePath, gzipSync(text));
    const segment = {
      filePath,
      checksum: createHash('sha256').update(text).digest('hex'),
      recordCount: records.length,
    };
    const events = readVerifiedSegments([segment]);
    expect(
      causalTradeEvidence(
        events,
        { symbol: 'SOLUSDT', fromMs: 1, throughMs: 100_000, gaps: [] },
        100_000,
        100_000,
      ).sequenceValid,
    ).toBe(true);
    expect(() => readVerifiedSegments([{ ...segment, checksum: 'bad' }])).toThrow(
      'ARCHIVE_CHECKSUM',
    );
    expect(depthVwap([{ price: 99, qty: 1 }], 2)).toBeNull();
    const book = causalExecutionBook(
      {
        symbol: 'SOLUSDT',
        receivedAtMs: 100,
        lastUpdateId: 10,
        bids: [{ price: 99, qty: 1 }],
        asks: [{ price: 101, qty: 1 }],
      },
      [
        {
          symbol: 'SOLUSDT',
          type: 'depth',
          eventTime: 101,
          receivedAtMs: 200,
          payload: {
            U: 11,
            u: 12,
            pu: 10,
            b: [],
            a: [
              ['101', '0'],
              ['102', '100'],
            ],
          },
        },
      ],
      200,
      1000,
    );
    expect(book).toBeNull(); // new 102 ask is outside the initial known-depth boundary
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it('accepts exact duplicates and overlapping USD-M ranges while rejecting conflicting duplicates', () => {
  const checkpointInput = {
    symbol: 'SOLUSDT',
    receivedAtMs: 100,
    availableAtMs: 100,
    lastUpdateId: 100,
    bids: [
      { price: 99, qty: 10 },
      { price: 98, qty: 10 },
    ],
    asks: [
      { price: 101, qty: 10 },
      { price: 102, qty: 10 },
    ],
  };
  const first = {
    symbol: 'SOLUSDT',
    type: 'depth' as const,
    eventTime: 200,
    receivedAtMs: 200,
    payload: {
      symbol: 'SOLUSDT',
      eventTime: 200,
      receivedAtMs: 200,
      U: 101,
      u: 102,
      pu: 100,
      b: [['99', '9']],
      a: [],
    },
  };
  const overlapping = {
    symbol: 'SOLUSDT',
    type: 'depth' as const,
    eventTime: 300,
    receivedAtMs: 300,
    payload: {
      symbol: 'SOLUSDT',
      eventTime: 300,
      receivedAtMs: 300,
      U: 102,
      u: 103,
      pu: 102,
      b: [],
      a: [['101', '8']],
    },
  };
  const valid = replayCausalDepth(
    checkpointInput,
    [first, { ...first, payload: { ...first.payload, b: [['99', '9']] } }, overlapping],
    { exchangeAsOfMs: 300, receivedAsOfMs: 300 },
    1000,
    true,
  );
  expect(valid).toMatchObject({
    status: 'VERIFIED',
    book: { lastUpdateId: 103, appliedEventCount: 2 },
  });
  const conflicting = replayCausalDepth(
    checkpointInput,
    [first, { ...first, payload: { ...first.payload, b: [['99', '1']] } }],
    { exchangeAsOfMs: 300, receivedAsOfMs: 300 },
    1000,
    true,
  );
  expect(conflicting).toMatchObject({ status: 'UNKNOWN', reason: 'DEPTH_DUPLICATE_CONFLICT' });
});

it('accepts pu-linked USD-M updates when U begins beyond the checkpoint update id', () => {
  const checkpointInput = {
    symbol: 'SOLUSDT',
    receivedAtMs: 100,
    availableAtMs: 100,
    lastUpdateId: 100,
    bids: [{ price: 99, qty: 10 }],
    asks: [{ price: 101, qty: 10 }],
  };
  const event = (eventTime: number, U: number, u: number, pu: number) => ({
    symbol: 'SOLUSDT',
    type: 'depth' as const,
    eventTime,
    receivedAtMs: eventTime,
    payload: {
      symbol: 'SOLUSDT',
      eventTime,
      receivedAtMs: eventTime,
      U,
      u,
      pu,
      b: [['99', String(10 + u)]],
      a: [],
    },
  });
  expect(
    replayCausalDepth(
      checkpointInput,
      [event(200, 110, 115, 100), event(300, 120, 125, 115)],
      { exchangeAsOfMs: 300, receivedAsOfMs: 300 },
      1000,
      true,
    ),
  ).toMatchObject({ status: 'VERIFIED', book: { lastUpdateId: 125, appliedEventCount: 2 } });
});

it('reconstructs a full-depth REST snapshot through its bridge event and subsequent pu chain', () => {
  const snapshot = {
    symbol: 'SOLUSDT',
    requestedAtMs: 100,
    snapshotReceivedAtMs: 150,
    availableAtMs: 160,
    exchangeUpperBoundAtAvailableMs: 140,
    lastUpdateId: 100,
    bids: [
      { price: 99, qty: 10 },
      { price: 98, qty: 10 },
    ],
    asks: [
      { price: 101, qty: 10 },
      { price: 102, qty: 10 },
    ],
    bufferLengthBefore: 0,
    bufferLengthAfter: 0,
    bufferedEvents: [],
    evidenceSha256: 'a'.repeat(64),
  };
  const event = (eventTime: number, receivedAtMs: number, U: number, u: number, pu: number) => ({
    symbol: 'SOLUSDT',
    type: 'depth' as const,
    eventTime,
    receivedAtMs,
    payload: {
      symbol: 'SOLUSDT',
      eventTime,
      receivedAtMs,
      U,
      u,
      pu,
      b: [['99', String(10 + u)]],
      a: [],
    },
  });
  const replay = replayCausalDepthFromRestSnapshot(
    snapshot,
    [event(200, 200, 95, 105, 90), event(300, 300, 110, 115, 105)],
    { exchangeAsOfMs: 400, exchangeLowerBoundMs: 350, receivedAsOfMs: 400 },
    1000,
  );
  expect(replay).toMatchObject({
    status: 'VERIFIED',
    book: {
      lastUpdateId: 115,
      appliedEventCount: 2,
      knownDepthBounds: { bidFloor: 98, askCeiling: 102 },
    },
  });
});

it('rejects REST-snapshot replay if the snapshot is not proven prior to the decision exchange clock', () => {
  const snapshot = {
    symbol: 'SOLUSDT',
    requestedAtMs: 100,
    snapshotReceivedAtMs: 150,
    availableAtMs: 160,
    exchangeUpperBoundAtAvailableMs: 350,
    lastUpdateId: 100,
    bids: [{ price: 99, qty: 10 }],
    asks: [{ price: 101, qty: 10 }],
    bufferLengthBefore: 0,
    bufferLengthAfter: 0,
    bufferedEvents: [],
    evidenceSha256: 'a'.repeat(64),
  };
  expect(
    replayCausalDepthFromRestSnapshot(
      snapshot,
      [],
      { exchangeAsOfMs: 400, exchangeLowerBoundMs: 350, receivedAsOfMs: 400 },
      1000,
    ),
  ).toMatchObject({ status: 'UNKNOWN', reason: 'REST_DEPTH_SNAPSHOT_INVALID' });
});

it('reconstructs the previous point and interval from the captured full REST snapshot, not the truncated feature checkpoint', async () => {
  const fullBids = Array.from({ length: 21 }, (_, index) => ({
    price: 99.99 - index * 0.01,
    qty: 100 + index,
  }));
  const fullAsks = Array.from({ length: 21 }, (_, index) => ({
    price: 100.01 + index * 0.01,
    qty: 100 + index,
  }));
  const beforeBids = fullBids.slice(0, 20);
  const asks = fullAsks.slice(0, 20);
  const removedBid = beforeBids[19].price;
  const afterBids = [...beforeBids.slice(0, 19), fullBids[20]];
  const decisions = [
    makeSyntheticDecisionRecord(BASE + 4000, 'LONG', 'SOLUSDT', {
      exchangeClockOffsetMs: 100,
      exchangeClockLowerBoundOffsetMs: 50,
      bookDepth: { bidDepth: beforeBids, askDepth: asks },
    }),
    makeSyntheticDecisionRecord(BASE + 5000, 'LONG', 'SOLUSDT', {
      exchangeClockOffsetMs: 100,
      exchangeClockLowerBoundOffsetMs: 50,
      bookDepth: { bidDepth: afterBids, askDepth: asks },
    }),
  ];
  const update = (
    eventTime: number,
    U: number,
    u: number,
    pu: number,
    bids: [string, string][] = [],
  ): ArchiveDepth => ({
    symbol: 'SOLUSDT',
    eventTime,
    receivedAtMs: eventTime,
    E: eventTime,
    T: eventTime,
    U,
    u,
    pu,
    b: bids,
    a: [],
  });
  const restSnapshot = {
    method: 'getDepthSnapshot',
    args: ['SOLUSDT', 1000],
    requestedAtMs: BASE - 100,
    receivedAtMs: BASE + 1,
    response: {
      lastUpdateId: 1000,
      bids: fullBids.map((level) => [String(level.price), String(level.qty)]),
      asks: fullAsks.map((level) => [String(level.price), String(level.qty)]),
      receivedAtMs: BASE,
    },
  };
  const capture = await createSyntheticCaptureSession({
    startedAtMs: BASE - 500,
    completedAtMs: BASE + 90_000,
    storageNowMs: BASE - 500,
    trades: coverageTrades(),
    depth: [
      update(BASE + 1000, 999, 1001, 998, [[String(fullBids[0].price), String(fullBids[0].qty)]]),
      update(BASE + 2000, 1002, 1002, 1001),
      update(BASE + 3000, 1003, 1003, 1002),
      update(BASE + 4000, 1004, 1004, 1003),
      update(BASE + 5000, 1005, 1005, 1004, [[String(removedBid), '0']]),
    ],
    checkpoints: [
      {
        symbol: 'SOLUSDT',
        eventTimeMs: BASE + 4000,
        persistedAtMs: BASE + 4000,
        checkpoint: {
          schemaVersion: 1,
          symbol: 'SOLUSDT',
          observedAtMs: BASE + 4000,
          lastUpdateId: 1004,
          bids: beforeBids,
          asks,
        },
      },
    ],
    decisionRecords: decisions,
    rawRestRecords: [
      {
        method: 'getServerTime',
        args: [],
        requestedAtMs: BASE - 200,
        receivedAtMs: BASE + 100,
        response: { serverTime: BASE },
      },
      restSnapshot,
    ],
    eventRecords: [
      {
        atMs: BASE + 1,
        level: 'info',
        message: 'market_data_order_book_snapshot_received',
        context: {
          symbol: 'SOLUSDT',
          requestedAtMs: BASE - 100,
          receivedAtMs: BASE + 1,
          snapshotLastUpdateId: 1000,
          bufferLengthBefore: 0,
          bufferLengthAfter: 0,
        },
      },
    ],
  });
  try {
    const records = await readVerifiedDecisionRecords(capture.session, BASE + 4000, BASE + 5000);
    const frames = await buildReplayFrames(capture.session, records);
    expect(frames[0].book?.checkpointSource).toBe('PUBLIC_REST_DEPTH_SNAPSHOT');
    expect(frames[0].book?.bidDepth).toEqual(fullBids);
    expect(frames[1].book?.bidDepth).toEqual(afterBids);
    expect(frames[1].verificationStatus).toBe('VERIFIED_INTERVAL');
    expect(frames[1].intervalCoverage).toMatchObject({
      checkpointSource: 'PUBLIC_REST_DEPTH_SNAPSHOT',
      depthFirstUpdateId: 1004,
      depthLastUpdateId: 1005,
    });
  } finally {
    capture.cleanup();
  }
});

it('does not consume depth events outside either the exchange or local receive cutoff', () => {
  const checkpointInput = {
    symbol: 'SOLUSDT',
    receivedAtMs: 100,
    availableAtMs: 100,
    lastUpdateId: 100,
    bids: [{ price: 99, qty: 10 }],
    asks: [{ price: 101, qty: 10 }],
  };
  const event = (eventTime: number, receivedAtMs: number) => ({
    symbol: 'SOLUSDT',
    type: 'depth' as const,
    eventTime,
    receivedAtMs,
    payload: {
      symbol: 'SOLUSDT',
      eventTime,
      receivedAtMs,
      U: 101,
      u: 101,
      pu: 100,
      b: [['99', '9']],
      a: [],
    },
  });
  expect(
    replayCausalDepth(
      checkpointInput,
      [event(200, 400)],
      { exchangeAsOfMs: 300, receivedAsOfMs: 300 },
      1000,
      true,
    ),
  ).toMatchObject({ status: 'UNKNOWN', reason: 'DEPTH_NO_UPDATES_OBSERVED' });
  expect(
    replayCausalDepth(
      checkpointInput,
      [event(400, 200)],
      { exchangeAsOfMs: 300, receivedAsOfMs: 300 },
      1000,
      true,
    ),
  ).toMatchObject({ status: 'UNKNOWN', reason: 'DEPTH_NO_UPDATES_OBSERVED' });
});

async function pairedSession(
  gapAt?: number,
  includeFundingEvidence = true,
  flatTradePrices = false,
  depthQty = 100,
  mixedExitPolicy = false,
) {
  const times = Array.from({ length: 8 }, (_, i) => BASE + i * 1000);
  const decisions = times.map((atMs, index) =>
    makeSyntheticDecisionRecord(atMs, 'LONG', 'SOLUSDT', {
      book: {
        bid: 99.99 + index * 0.001,
        ask: 100.01 + index * 0.001,
        bidQty: depthQty,
        askQty: depthQty,
      },
      ...(mixedExitPolicy && index === 4
        ? {
            replayConfig: {
              ...defaultMicroBurstConfig(),
              exitMaxHoldMs: defaultMicroBurstConfig().exitMaxHoldMs + 1000,
            },
          }
        : {}),
    }),
  );
  const trades: ArchiveTrade[] = Array.from({ length: 72 }, (_, index) => {
    const eventTime = BASE - 61_000 + index * 1000;
    return {
      symbol: 'SOLUSDT',
      eventTime,
      receivedAtMs: eventTime,
      aggregateTradeId: index + 1,
      price: flatTradePrices ? 100 : 100 + index * 0.01,
      quantity: 1,
      isBuyerMaker: false,
    };
  });
  const depth: ArchiveDepth[] = times.map((eventTime, index) => ({
    symbol: 'SOLUSDT',
    eventTime,
    receivedAtMs: eventTime,
    E: eventTime,
    T: eventTime,
    U: 1000 + index,
    u: 1000 + index,
    pu: 999 + index,
    b: [
      ...(index > 0 ? [[String(99.99 + (index - 1) * 0.001), '0'] as [string, string]] : []),
      [String(99.99 + index * 0.001), String(depthQty)],
    ],
    a: [
      ...(index > 0 ? [[String(100.01 + (index - 1) * 0.001), '0'] as [string, string]] : []),
      [String(100.01 + index * 0.001), String(depthQty)],
    ],
  }));
  const checkpoints = times.map((eventTime, index) => ({
    symbol: 'SOLUSDT',
    eventTimeMs: eventTime,
    checkpoint: {
      schemaVersion: 1,
      symbol: 'SOLUSDT',
      observedAtMs: eventTime,
      lastUpdateId: 1000 + index,
      bids: [
        { price: 99.99 + index * 0.001, qty: depthQty },
        { price: 99.98, qty: depthQty },
      ],
      asks: [
        { price: 100.01 + index * 0.001, qty: depthQty },
        { price: 100.02, qty: depthQty },
      ],
    },
  }));
  return createSyntheticCaptureSession({
    startedAtMs: BASE - 120_000,
    completedAtMs: BASE + 90_000,
    storageNowMs: BASE - 120_000,
    trades,
    depth,
    checkpoints,
    decisionRecords: decisions,
    fundingEvidenceRecords: includeFundingEvidence
      ? [makeSyntheticNoFundingEvidence('SOLUSDT', BASE - 120_000, BASE + 90_000)]
      : [],
    gaps:
      gapAt === undefined
        ? []
        : [{ symbol: 'SOLUSDT', startedAtMs: gapAt, endedAtMs: gapAt, feed: 'DEPTH' }],
  });
}

async function buildReplayFrames(
  session: Awaited<ReturnType<typeof createSyntheticCaptureSession>>['session'],
  records: readonly Awaited<ReturnType<typeof readVerifiedDecisionRecords>>[number][],
) {
  const candidate = new MicroBurstPullbackCandidate();
  const frames = [];
  let previous;
  for (const record of records) {
    const observation = await candidate.evaluate(session, record);
    const frame = await buildVerifiedReplayFrame(session, record, observation, previous);
    frames.push(frame);
    previous = frame;
  }
  return frames;
}

function coverageTrades(): ArchiveTrade[] {
  return Array.from({ length: 72 }, (_, index) => {
    const eventTime = BASE - 61_000 + index * 1000;
    return {
      symbol: 'SOLUSDT',
      eventTime,
      receivedAtMs: eventTime,
      aggregateTradeId: index + 1,
      price: 100 + index * 0.01,
      quantity: 1,
      isBuyerMaker: false,
    };
  });
}

function depthEvent(eventTime: number, updateId: number, previousUpdateId: number): ArchiveDepth {
  return {
    symbol: 'SOLUSDT',
    eventTime,
    receivedAtMs: eventTime,
    E: eventTime,
    T: eventTime,
    U: updateId,
    u: updateId,
    pu: previousUpdateId,
    b: [['99.99', '100']],
    a: [['100.01', '100']],
  };
}

function checkpoint(eventTime: number, lastUpdateId: number) {
  return {
    symbol: 'SOLUSDT',
    eventTimeMs: eventTime,
    checkpoint: {
      schemaVersion: 1,
      symbol: 'SOLUSDT',
      observedAtMs: eventTime,
      lastUpdateId,
      bids: [{ price: 99.99, qty: 100 }],
      asks: [{ price: 100.01, qty: 100 }],
    },
  };
}

async function coverageSession(input: {
  depth: readonly ArchiveDepth[];
  checkpoints: readonly ReturnType<typeof checkpoint>[];
  decisionTimes?: readonly number[];
  exchangeClockOffsetMs?: number;
  exchangeClockOffsetsMs?: readonly number[];
  exchangeClockLowerBoundOffsetsMs?: readonly number[];
  bookObservedAtOffsetsMs?: readonly number[];
  includeTrades?: boolean;
  maxActiveSegmentRecords?: number;
}) {
  const records = (input.decisionTimes ?? [BASE + 5000]).map((atMs, index) =>
    makeSyntheticDecisionRecord(atMs, 'LONG', 'SOLUSDT', {
      exchangeClockOffsetMs: input.exchangeClockOffsetsMs?.[index] ?? input.exchangeClockOffsetMs,
      exchangeClockLowerBoundOffsetMs: input.exchangeClockLowerBoundOffsetsMs?.[index],
      bookObservedAtOffsetMs: input.bookObservedAtOffsetsMs?.[index],
    }),
  );
  const capture = await createSyntheticCaptureSession({
    startedAtMs: BASE - 120_000,
    completedAtMs: BASE + 90_000,
    storageNowMs: BASE - 120_000,
    trades: input.includeTrades === false ? [] : coverageTrades(),
    depth: input.depth,
    checkpoints: input.checkpoints,
    decisionRecords: records,
    maxActiveSegmentRecords: input.maxActiveSegmentRecords,
  });
  const verifiedRecords = await readVerifiedDecisionRecords(capture.session, BASE, BASE + 7000);
  return { ...capture, decision: verifiedRecords[0], records: verifiedRecords };
}

it('rejects a depth checkpoint that was persisted after the decision became available', async () => {
  const decision = makeSyntheticDecisionRecord(BASE + 1000);
  const capture = await createSyntheticCaptureSession({
    startedAtMs: BASE - 120_000,
    completedAtMs: BASE + 90_000,
    storageNowMs: BASE - 120_000,
    trades: coverageTrades(),
    depth: [depthEvent(BASE + 750, 1001, 1000)],
    checkpoints: [
      {
        ...checkpoint(BASE + 500, 1000),
        persistedAtMs: BASE + 1500,
      },
    ],
    decisionRecords: [decision],
  });
  try {
    const [record] = await readVerifiedDecisionRecords(capture.session, BASE, BASE + 2000);
    const assessment = await readVerifiedExecutionBookForDecision(capture.session, record);
    expect(assessment).toMatchObject({
      status: 'UNKNOWN',
      reason: 'DEPTH_CHECKPOINT_MISSING_OR_NOT_YET_AVAILABLE',
    });
  } finally {
    capture.cleanup();
  }
});

it('keeps a book-content mismatch as an unknown point instead of claiming a point book', async () => {
  const decision = makeSyntheticDecisionRecord(BASE + 5000, 'LONG', 'SOLUSDT', {
    book: { bid: 99.98, ask: 100.01 },
  });
  const capture = await createSyntheticCaptureSession({
    startedAtMs: BASE - 120_000,
    completedAtMs: BASE + 90_000,
    storageNowMs: BASE - 120_000,
    trades: coverageTrades(),
    depth: [],
    checkpoints: [checkpoint(BASE + 5000, 1000)],
    decisionRecords: [decision],
  });
  try {
    const [record] = await readVerifiedDecisionRecords(capture.session, BASE, BASE + 7000);
    const observation = await new MicroBurstPullbackCandidate().evaluate(capture.session, record);
    const frame = await buildVerifiedReplayFrame(capture.session, record, observation);
    expect(frame.verificationStatus).toBe('UNKNOWN');
    expect(frame.book).toBeNull();
    expect(frame.reason).toBe('DECISION_BOOK_CONTENT_MISMATCH');
    expect(frame.intervalStatus).toBe('NOT_EVALUATED');
  } finally {
    capture.cleanup();
  }
});

it('retains a verified current point when the preceding frame book is unavailable', async () => {
  const capture = await coverageSession({
    decisionTimes: [BASE + 1000, BASE + 5000],
    checkpoints: [checkpoint(BASE + 2000, 1002)],
    depth: [depthEvent(BASE + 3000, 1003, 1002), depthEvent(BASE + 5000, 1004, 1003)],
  });
  try {
    const candidate = new MicroBurstPullbackCandidate();
    const first = await buildVerifiedReplayFrame(
      capture.session,
      capture.records[0],
      await candidate.evaluate(capture.session, capture.records[0]),
    );
    const second = await buildVerifiedReplayFrame(
      capture.session,
      capture.records[1],
      await candidate.evaluate(capture.session, capture.records[1]),
      first,
    );
    expect(first.verificationStatus).toBe('UNKNOWN');
    expect(second.verificationStatus).toBe('VERIFIED_POINT');
    expect(second.book).not.toBeNull();
    expect(second.intervalStatus).toBe('UNKNOWN');
    expect(second.intervalReason).toBe('PREVIOUS_FRAME_BOOK_UNAVAILABLE');
  } finally {
    capture.cleanup();
  }
});

it('keeps a verified point when a pu discontinuity invalidates the interval', async () => {
  const capture = await coverageSession({
    decisionTimes: [BASE, BASE + 1000],
    checkpoints: [checkpoint(BASE, 1000), checkpoint(BASE + 1000, 1006)],
    includeTrades: false,
    depth: [
      depthEvent(BASE + 250, 1001, 1000),
      depthEvent(BASE + 500, 1002, 1001),
      depthEvent(BASE + 750, 1005, 1004),
      depthEvent(BASE + 1000, 1006, 1005),
    ],
    maxActiveSegmentRecords: 2,
  });
  try {
    const candidate = new MicroBurstPullbackCandidate();
    const first = await buildVerifiedReplayFrame(
      capture.session,
      capture.records[0],
      await candidate.evaluate(capture.session, capture.records[0]),
    );
    const second = await buildVerifiedReplayFrame(
      capture.session,
      capture.records[1],
      await candidate.evaluate(capture.session, capture.records[1]),
      first,
    );
    expect(first.verificationStatus).toBe('VERIFIED_POINT');
    expect(second.verificationStatus).toBe('VERIFIED_POINT');
    expect(second.book).not.toBeNull();
    expect(second.intervalStatus).toBe('UNKNOWN');
    expect(second.intervalReason).toBe('DEPTH_SEQUENCE_GAP');
  } finally {
    capture.cleanup();
  }
});

it('does not let a caller-selected freshness allowance certify an old book', async () => {
  const oldAt = BASE - 50_000;
  const capture = await coverageSession({
    checkpoints: [checkpoint(oldAt, 1000)],
    depth: [depthEvent(oldAt, 1000, 999)],
  });
  try {
    const observation = await new MicroBurstPullbackCandidate().evaluate(
      capture.session,
      capture.decision,
    );
    const frame = await buildVerifiedReplayFrame(capture.session, capture.decision, observation);
    expect(frame.verificationStatus).toBe('UNKNOWN');
    expect(frame.reason).toBe('DEPTH_TOO_OLD');
  } finally {
    capture.cleanup();
  }
});

it('keeps a verified point while leaving a no-update interval unknown', async () => {
  const capture = await coverageSession({
    decisionTimes: [BASE, BASE + 1000],
    checkpoints: [checkpoint(BASE, 1000), checkpoint(BASE + 1000, 1000)],
    depth: [depthEvent(BASE, 1000, 999)],
  });
  try {
    const candidate = new MicroBurstPullbackCandidate();
    const first = await buildVerifiedReplayFrame(
      capture.session,
      capture.records[0],
      await candidate.evaluate(capture.session, capture.records[0]),
    );
    const second = await buildVerifiedReplayFrame(
      capture.session,
      capture.records[1],
      await candidate.evaluate(capture.session, capture.records[1]),
      first,
    );
    expect(second.verificationStatus).toBe('VERIFIED_POINT');
    expect(second.book).not.toBeNull();
    expect(second.intervalStatus).toBe('UNKNOWN');
    expect(second.intervalReason).toBe('DEPTH_NO_UPDATES_OBSERVED');
  } finally {
    capture.cleanup();
  }
});

it('keeps the current book as a point when the previous exchange-time upper bound regresses', async () => {
  const capture = await coverageSession({
    decisionTimes: [BASE + 1000, BASE + 2000],
    exchangeClockOffsetsMs: [1200, 100],
    checkpoints: [checkpoint(BASE, 1000)],
    depth: [depthEvent(BASE + 1000, 1001, 1000), depthEvent(BASE + 2000, 1002, 1001)],
  });
  try {
    const candidate = new MicroBurstPullbackCandidate();
    const first = await buildVerifiedReplayFrame(
      capture.session,
      capture.records[0],
      await candidate.evaluate(capture.session, capture.records[0]),
    );
    const second = await buildVerifiedReplayFrame(
      capture.session,
      capture.records[1],
      await candidate.evaluate(capture.session, capture.records[1]),
      first,
    );
    expect(first.exchangeAsOfMs).toBeGreaterThan(second.exchangeAsOfMs);
    expect(first.decisionAvailableAtMs).toBeLessThan(second.decisionAvailableAtMs);
    expect(second.verificationStatus).toBe('VERIFIED_POINT');
    expect(second.book).not.toBeNull();
    expect(second.intervalCoverage).toBeNull();
    expect(second.intervalStatus).toBe('UNKNOWN');
    expect(second.intervalReason).toBe('PREVIOUS_FRAME_EXCHANGE_CLOCK_REGRESSION');
  } finally {
    capture.cleanup();
  }
});

it.each([
  { eventOffsetMs: 40, expected: 'DEPTH_LATE_EVENT_CROSSES_INTERVAL_START' },
  { eventOffsetMs: 75, expected: 'DEPTH_EVENT_ORDER_AMBIGUOUS_AT_INTERVAL_START' },
])(
  'classifies late depth using the exchange-clock uncertainty bounds',
  async ({ eventOffsetMs, expected }) => {
    const startAtMs = BASE + 1000;
    const throughAtMs = BASE + 2000;
    const lateEvent = depthEvent(startAtMs + eventOffsetMs, 1001, 1000);
    const lateReceivedAtMs = BASE + 1500;
    const capture = await coverageSession({
      decisionTimes: [startAtMs, throughAtMs],
      exchangeClockOffsetsMs: [100, 100],
      exchangeClockLowerBoundOffsetsMs: [50, 50],
      bookObservedAtOffsetsMs: [0, -400],
      checkpoints: [checkpoint(startAtMs, 1000), checkpoint(BASE + 1600, 1002)],
      depth: [
        {
          ...lateEvent,
          receivedAtMs: lateReceivedAtMs,
        },
        depthEvent(BASE + 1600, 1002, 1001),
      ],
    });
    try {
      const candidate = new MicroBurstPullbackCandidate();
      const first = await buildVerifiedReplayFrame(
        capture.session,
        capture.records[0],
        await candidate.evaluate(capture.session, capture.records[0]),
      );
      const second = await buildVerifiedReplayFrame(
        capture.session,
        capture.records[1],
        await candidate.evaluate(capture.session, capture.records[1]),
        first,
      );
      expect(first.verificationStatus).toBe('VERIFIED_POINT');
      expect(second.verificationStatus).toBe('VERIFIED_POINT');
      expect(second.intervalStatus).toBe('UNKNOWN');
      expect(second.intervalReason).toBe(expected);
      expect(second.intervalCoverage).toBeNull();
    } finally {
      capture.cleanup();
    }
  },
);

it('uses a reconnect checkpoint only as a new point and never fills across the prior gap', async () => {
  const capture = await coverageSession({
    decisionTimes: [BASE, BASE + 1000, BASE + 2000],
    checkpoints: [checkpoint(BASE, 1000), checkpoint(BASE + 1000, 2000)],
    depth: [depthEvent(BASE + 500, 1001, 1000), depthEvent(BASE + 2000, 2001, 2000)],
  });
  try {
    const candidate = new MicroBurstPullbackCandidate();
    const frames = [];
    let previous;
    for (const decision of capture.records) {
      const frame = await buildVerifiedReplayFrame(
        capture.session,
        decision,
        await candidate.evaluate(capture.session, decision),
        previous,
      );
      frames.push(frame);
      previous = frame;
    }
    expect(frames[0].verificationStatus).toBe('VERIFIED_POINT');
    expect(frames[1].verificationStatus).toBe('VERIFIED_POINT');
    expect(frames[1].book).not.toBeNull(); // a new checkpoint is a point, not a bridge
    expect(frames[1].intervalStatus).toBe('UNKNOWN');
    expect(frames[1].intervalReason).toBe('THROUGH_INTERVAL_BOOK_DECISION_MISMATCH');
    expect(frames[2].verificationStatus).toBe('VERIFIED_INTERVAL');
    expect(frames[2].intervalCoverage?.checkpointAtMs).toBe(BASE + 1000);
    expect(frames[2].intervalCoverage?.depthFirstUpdateId).toBe(2000);
    expect(frames[2].intervalCoverage?.depthLastUpdateId).toBe(2001);
  } finally {
    capture.cleanup();
  }
});

it('verifies interval event clocks separately from local checkpoint/receive clocks', async () => {
  const capture = await coverageSession({
    decisionTimes: [BASE, BASE + 1000],
    exchangeClockOffsetMs: 500,
    checkpoints: [checkpoint(BASE, 1000), checkpoint(BASE + 1000, 1001)],
    depth: [
      { ...depthEvent(BASE + 500, 1000, 999), receivedAtMs: BASE },
      { ...depthEvent(BASE + 1500, 1001, 1000), receivedAtMs: BASE + 1000 },
    ],
  });
  try {
    const candidate = new MicroBurstPullbackCandidate();
    const first = await buildVerifiedReplayFrame(
      capture.session,
      capture.records[0],
      await candidate.evaluate(capture.session, capture.records[0]),
    );
    const second = await buildVerifiedReplayFrame(
      capture.session,
      capture.records[1],
      await candidate.evaluate(capture.session, capture.records[1]),
      first,
    );
    expect(second.verificationStatus).toBe('VERIFIED_INTERVAL');
    expect(second.intervalCoverage?.fromExchangeAsOfMs).toBe(BASE + 500);
    expect(second.intervalCoverage?.fromReceivedAtMs).toBe(BASE);
    expect(second.intervalCoverage?.throughExchangeAsOfMs).toBe(BASE + 1500);
    expect(second.intervalCoverage?.throughReceivedAtMs).toBe(BASE + 1000);
  } finally {
    capture.cleanup();
  }
});

it('does not let a frame use an observation from a different verified decision', async () => {
  const capture = await pairedSession();
  try {
    const records = await readVerifiedDecisionRecords(capture.session, BASE, BASE + 7000);
    const candidate = new MicroBurstPullbackCandidate();
    const observation = await candidate.evaluate(capture.session, records[0]);
    await expect(
      buildVerifiedReplayFrame(capture.session, records[1], observation),
    ).rejects.toThrow('REPLAY_FRAME_DECISION_IDENTITY_OR_CLOCK_MISMATCH');
  } finally {
    capture.cleanup();
  }
});

it('does not let a verified decision or frame cross capture sessions', async () => {
  const source = await pairedSession();
  const other = await coverageSession({
    checkpoints: [checkpoint(BASE, 1000)],
    depth: [depthEvent(BASE, 1000, 999)],
  });
  try {
    const records = await readVerifiedDecisionRecords(source.session, BASE, BASE + 7000);
    const observation = await new MicroBurstPullbackCandidate().evaluate(
      source.session,
      records[0],
    );
    await expect(buildVerifiedReplayFrame(other.session, records[0], observation)).rejects.toThrow(
      'REPLAY_FRAME_DECISION_IDENTITY_OR_CLOCK_MISMATCH',
    );
  } finally {
    source.cleanup();
    other.cleanup();
  }
});

it('rejects frames evaluated under a non-preregistered Pullback contract', async () => {
  const capture = await pairedSession();
  try {
    const [decision] = await readVerifiedDecisionRecords(capture.session, BASE, BASE + 7000);
    const alteredCandidate = new MicroBurstPullbackCandidate({
      ...PULLBACK_EXPERIMENT_V1,
      persistenceMs: PULLBACK_EXPERIMENT_V1.persistenceMs + 1000,
    });
    const observation = await alteredCandidate.evaluate(capture.session, decision);
    await expect(buildVerifiedReplayFrame(capture.session, decision, observation)).rejects.toThrow(
      'PULLBACK_EXPERIMENT_CONFIG_NOT_PREREGISTERED',
    );
  } finally {
    capture.cleanup();
  }
});

it('rejects mixing recorded CURRENT exit-policy configs in one paired replay', async () => {
  const capture = await pairedSession(undefined, true, false, 100, true);
  try {
    const records = await readVerifiedDecisionRecords(capture.session, BASE, BASE + 7000);
    const frames = await buildReplayFrames(capture.session, records);
    expect(new Set(frames.map((frame) => frame.exitPolicyConfigSha256)).size).toBe(2);
    expect(() =>
      replayPairedExecutions(frames, {
        riskBudgetUsdt: 1,
        maxNotionalUsdt: 100,
        quantityStep: 0.001,
        minNotionalUsdt: 1,
        feeBpsPerSide: 5,
        adverseSlippageBps: 1,
        entryDelayMs: 1000,
        exitDelayMs: 1000,
        fundingEvidence: null,
      }),
    ).toThrow('MIXED_REPLAY_POLICY_CONFIG');
  } finally {
    capture.cleanup();
  }
});

it('preserves distinct exchange-event and local-receive clocks in a verified point frame', async () => {
  const original = makeSyntheticDecisionRecord(BASE + 1000, 'LONG', 'SOLUSDT', {
    exchangeClockOffsetMs: 120_000,
  });
  const decision = {
    ...original,
    evaluatedAtReceivedMs: BASE + 1500,
    recordedAtMs: BASE + 1501,
  };
  const capture = await createSyntheticCaptureSession({
    startedAtMs: BASE - 120_000,
    completedAtMs: BASE + 90_000,
    storageNowMs: BASE - 120_000,
    trades: coverageTrades(),
    depth: [{ ...depthEvent(BASE + 120_500, 1001, 1000), receivedAtMs: BASE + 1000 }],
    checkpoints: [checkpoint(BASE + 1000, 1001)],
    decisionRecords: [decision],
  });
  try {
    const [record] = await readVerifiedDecisionRecords(capture.session, BASE, BASE + 7000);
    const observation = await new MicroBurstPullbackCandidate().evaluate(capture.session, record);
    const frame = await buildVerifiedReplayFrame(capture.session, record, observation);
    expect(frame.verificationStatus).toBe('VERIFIED_POINT');
    expect(frame.exchangeAsOfMs).toBe(BASE + 121_000);
    expect(frame.atMs).toBe(BASE + 1000);
    expect(frame.decisionAvailableAtMs).toBe(BASE + 1500);
    expect(frame.book?.exchangeAsOfMs).toBe(BASE + 121_000);
    expect(frame.book?.receivedAsOfMs).toBe(BASE + 1000);
  } finally {
    capture.cleanup();
  }
});

it('builds independent CURRENT/PULLBACK modelled executions only from verified capture inputs', async () => {
  const capture = await pairedSession();
  try {
    const records = await readVerifiedDecisionRecords(capture.session, BASE, BASE + 7000);
    const fundingEvidence = await readVerifiedFundingEvidence(
      capture.session,
      'SOLUSDT',
      BASE,
      BASE + 7000,
    );
    expect(fundingEvidence?.source).toBe('SYNTHETIC_TEST_FIXTURE');
    const frames = await buildReplayFrames(capture.session, records);
    expect(frames[0].verificationStatus).toBe('VERIFIED_POINT');
    expect(
      frames.slice(1).every((frame) => frame.verificationStatus === 'VERIFIED_INTERVAL'),
      JSON.stringify(frames.map((frame) => [frame.verificationStatus, frame.reason])),
    ).toBe(true);
    const options = {
      riskBudgetUsdt: 1,
      maxNotionalUsdt: 100,
      quantityStep: 0.001,
      minNotionalUsdt: 1,
      feeBpsPerSide: 5,
      adverseSlippageBps: 1,
      entryDelayMs: 1000,
      exitDelayMs: 1000,
      fundingEvidence,
    };
    const results = replayPairedExecutions(frames, options);
    expect(results).toHaveLength(2);
    expect(
      results.every((result) => result.executionKind === 'MODELLED_BOOK_VWAP_NOT_REAL_FILL'),
    ).toBe(true);
    expect(results[0].entryAtMs).toBe(BASE + 1000);
    expect(results[1].entryAtMs).toBe(BASE + 4000);
    expect(results[1].entryAudit?.bookSha256).not.toBe(results[0].entryAudit?.bookSha256);
    expect(results[0].entryAudit).toMatchObject({
      decisionAtMs: BASE,
      decisionExchangeAsOfMs: BASE,
      executedAtMs: BASE + 1000,
      executedExchangeAsOfMs: BASE + 1000,
      intervalCoverageCount: 1,
    });
    expect(results[0].sourceDecisionId).toBe(records[0].decisionId);
    expect(results[0].sourceReplayFrameSha256).toBe(frames[0].evidenceSha256);
    expect(results[0].entryAudit?.intervalCoverageEvidenceSha256s).toEqual([
      frames[1].intervalCoverage?.evidenceSha256,
    ]);
    expect(results[0].entryAudit?.pullbackObservationSha256).toBe(
      frames[1].observation.evidenceSha256,
    );
    expect(results[0].protectionAssumption).toBe('IMMEDIATE_STOP_COVERAGE_NOT_EXCHANGE_VALIDATED');
    const report = summarizePairedReplay(frames, results);
    expect(report.resultKind).toBe('MODELLED_BOOK_VWAP_NOT_REAL_FILL');
    expect(report.independentBaselineEpisodes).toBe(1);
    expect(report.terminalOutcomes).toHaveLength(1);
    expect(() =>
      summarizePairedReplay(
        frames,
        results.map((result) => ({ ...result, sourceDecisionId: 'invented-decision' })),
      ),
    ).toThrow('EPISODE_RESULT_NOT_PAIRED_REPLAY_VERIFIED');
    expect(() =>
      summarizePairedReplay(
        frames,
        results.map((result) => ({ ...result, netPnlUsdt: 999_999 })),
      ),
    ).toThrow('EPISODE_RESULT_NOT_PAIRED_REPLAY_VERIFIED');
    expect(Object.isFrozen(results)).toBe(true);
    expect(Object.isFrozen(results[0])).toBe(true);
    expect(() => replayPairedExecutions([{ ...frames[0] }], options)).toThrow(
      'REPLAY_FRAME_NOT_CAPTURE_VERIFIED',
    );
  } finally {
    capture.cleanup();
  }
});

it('reports selector rejection separately from a missing PULLBACK execution', async () => {
  const capture = await pairedSession(undefined, true, true);
  try {
    const records = await readVerifiedDecisionRecords(capture.session, BASE, BASE + 7000);
    const frames = await buildReplayFrames(capture.session, records);
    expect(frames.every((frame) => frame.observation.disposition === 'STRATEGY_REJECTED')).toBe(
      true,
    );
    const fundingEvidence = await readVerifiedFundingEvidence(
      capture.session,
      'SOLUSDT',
      BASE,
      BASE + 7000,
    );
    const results = replayPairedExecutions(frames, {
      riskBudgetUsdt: 1,
      maxNotionalUsdt: 100,
      quantityStep: 0.001,
      minNotionalUsdt: 1,
      feeBpsPerSide: 5,
      adverseSlippageBps: 1,
      entryDelayMs: 1000,
      exitDelayMs: 1000,
      fundingEvidence,
    });
    expect(results.filter((result) => result.variant === 'PULLBACK')).toHaveLength(0);
    const report = summarizePairedReplay(frames, results);
    expect(report.operable.pullback).toMatchObject({ rejected: 1, noExecutionRecord: 0 });
    expect(report.terminalOutcomes[0]).toMatchObject({
      pullback: 'REJECTED_BY_SELECTOR',
      pullbackSelection: 'STRATEGY_REJECTED',
    });
  } finally {
    capture.cleanup();
  }
});

it('keeps quantity-insufficient verified depth UNFILLED without inventing PnL', async () => {
  const capture = await pairedSession(undefined, true, false, 0.001);
  try {
    const records = await readVerifiedDecisionRecords(capture.session, BASE, BASE + 7000);
    const frames = await buildReplayFrames(capture.session, records);
    const fundingEvidence = await readVerifiedFundingEvidence(
      capture.session,
      'SOLUSDT',
      BASE,
      BASE + 7000,
    );
    const results = replayPairedExecutions(frames, {
      riskBudgetUsdt: 1,
      maxNotionalUsdt: 100,
      quantityStep: 0.001,
      minNotionalUsdt: 1,
      feeBpsPerSide: 5,
      adverseSlippageBps: 1,
      entryDelayMs: 1000,
      exitDelayMs: 1000,
      fundingEvidence,
    });
    expect(results).toHaveLength(2);
    expect(results.every((result) => result.status === 'UNFILLED')).toBe(true);
    expect(results.every((result) => result.entryAudit === undefined)).toBe(true);
    expect(results.every((result) => result.netPnlUsdt === undefined)).toBe(true);
  } finally {
    capture.cleanup();
  }
});

it('keeps a CURRENT modelled position unknown when the verified session ends before closure', async () => {
  const capture = await pairedSession();
  try {
    const records = await readVerifiedDecisionRecords(capture.session, BASE, BASE + 1000);
    const frames = await buildReplayFrames(capture.session, records);
    const fundingEvidence = await readVerifiedFundingEvidence(
      capture.session,
      'SOLUSDT',
      BASE,
      BASE + 7000,
    );
    const results = replayPairedExecutions(frames, {
      riskBudgetUsdt: 1,
      maxNotionalUsdt: 100,
      quantityStep: 0.001,
      minNotionalUsdt: 1,
      feeBpsPerSide: 5,
      adverseSlippageBps: 1,
      entryDelayMs: 1000,
      exitDelayMs: 1000,
      fundingEvidence,
    });
    const current = results.find((result) => result.variant === 'CURRENT');
    expect(current).toMatchObject({ status: 'UNKNOWN', reason: 'END_OF_COVERAGE' });
    expect(current?.netPnlUsdt).toBeUndefined();
    const report = summarizePairedReplay(frames, results);
    expect(report.terminalOutcomes[0]).toMatchObject({
      current: 'SESSION_ENDED_WITH_FOLLOW_UP_PENDING',
      pullbackSelection: 'WAITING',
      pullback: 'WAITING_AT_END_OF_CAPTURE',
    });
  } finally {
    capture.cleanup();
  }
});

it('keeps modeled fills UNKNOWN when there is no verified funding coverage', async () => {
  const capture = await pairedSession(undefined, false);
  try {
    const records = await readVerifiedDecisionRecords(capture.session, BASE, BASE + 7000);
    const frames = await buildReplayFrames(capture.session, records);
    const report = replayPairedExecutions(frames, {
      riskBudgetUsdt: 1,
      maxNotionalUsdt: 100,
      quantityStep: 0.001,
      minNotionalUsdt: 1,
      feeBpsPerSide: 5,
      adverseSlippageBps: 1,
      entryDelayMs: 1000,
      exitDelayMs: 1000,
      fundingEvidence: null,
    });
    expect(report.length).toBeGreaterThan(0);
    expect(
      report.every((result) => result.status === 'UNKNOWN' && result.netPnlUsdt === undefined),
    ).toBe(true);
    expect(
      report.every(
        (result) => result.reason === 'FUNDING_EVIDENCE_UNAVAILABLE_OR_OUTSIDE_REPLAY_WINDOW',
      ),
    ).toBe(true);
  } finally {
    capture.cleanup();
  }
});

it('marks loss of archived depth coverage unknown and never turns it into zero PnL', async () => {
  const capture = await pairedSession(BASE + 5000);
  try {
    const records = await readVerifiedDecisionRecords(capture.session, BASE, BASE + 7000);
    const fundingEvidence = await readVerifiedFundingEvidence(
      capture.session,
      'SOLUSDT',
      BASE,
      BASE + 7000,
    );
    const frames = await buildReplayFrames(capture.session, records);
    const results = replayPairedExecutions(frames, {
      riskBudgetUsdt: 1,
      maxNotionalUsdt: 100,
      quantityStep: 0.001,
      minNotionalUsdt: 1,
      feeBpsPerSide: 5,
      adverseSlippageBps: 1,
      entryDelayMs: 1000,
      exitDelayMs: 1000,
      fundingEvidence,
    });
    expect(results.every((result) => result.entryAtMs !== undefined && result.entryAudit)).toBe(
      true,
    );
    expect(
      results.every((result) => result.status === 'UNKNOWN' && result.netPnlUsdt === undefined),
    ).toBe(true);
    expect(results.every((result) => result.reason === 'DECLARED_DEPTH_GAP')).toBe(true);
    const report = summarizePairedReplay(frames, results);
    expect(report.operable.pairedClosedEpisodes).toBe(0);
    expect(report.terminalOutcomes[0].current).toBe('UNKNOWN_TOTAL_AFTER_MODELLED_ENTRY');
  } finally {
    capture.cleanup();
  }
});
