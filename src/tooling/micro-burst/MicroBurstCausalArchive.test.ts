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
  readVerifiedSegments,
  type ArchiveEvent,
} from './MicroBurstCausalArchive';
import {
  readVerifiedDecisionRecords,
  readVerifiedExecutionBook,
  readVerifiedFundingEvidence,
  verifyIntervalCoverage,
} from './MicroBurstCaptureSession';
import { MicroBurstPullbackCandidate } from './MicroBurstPullbackCandidate';
import { replayPairedExecutions, type PairedReplayFrame } from './MicroBurstPairedExecutionReplay';
import { summarizePairedReplay } from './MicroBurstPairedReplayReport';
import { defaultMicroBurstConfig } from '../../strategies/micro-burst/domain/MicroBurstTypes';
import { TEST_SNAPSHOT_AT_MS } from '../../strategies/micro-burst/domain/MicroBurst.test-support';
import { decodeValidatedPatternReplay } from './MicroBurstPatternComparison';
import {
  createSyntheticCaptureSession,
  makeSyntheticDecisionRecord,
  makeSyntheticNoFundingEvidence,
} from './MicroBurstCaptureSession.test-support';
import type {
  ArchiveDepth,
  ArchiveTrade,
} from '../../strategies/micro-burst/research/MicroBurstStorage';

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

async function pairedSession(gapAt?: number, includeFundingEvidence = true) {
  const times = Array.from({ length: 8 }, (_, i) => BASE + i * 1000);
  const decisions = times.map((atMs, index) =>
    makeSyntheticDecisionRecord(atMs, 'LONG', 'SOLUSDT', {
      book: {
        bid: 99.99 + index * 0.001,
        ask: 100.01 + index * 0.001,
      },
    }),
  );
  const trades: ArchiveTrade[] = Array.from({ length: 72 }, (_, index) => {
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
  const depth: ArchiveDepth[] = times.map((eventTime, index) => ({
    symbol: 'SOLUSDT',
    eventTime,
    receivedAtMs: eventTime,
    E: eventTime,
    T: eventTime,
    U: 1000 + index,
    u: 1000 + index,
    pu: 999 + index,
    b: [[String(99.99 + index * 0.001), '100']],
    a: [[String(100.01 + index * 0.001), '100']],
  }));
  const checkpoints = times.map((eventTime, index) => ({
    symbol: 'SOLUSDT',
    eventTimeMs: eventTime,
    checkpoint: {
      schemaVersion: 1,
      symbol: 'SOLUSDT',
      observedAtMs: eventTime,
      lastUpdateId: 1000 + index,
      bids: [{ price: 99.99 + index * 0.001, qty: 100 }],
      asks: [{ price: 100.01 + index * 0.001, qty: 100 }],
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
    const candidate = new MicroBurstPullbackCandidate();
    const frames: PairedReplayFrame[] = [];
    let previousAtMs = BASE - 1000;
    for (const record of records) {
      const observation = await candidate.evaluate(capture.session, record);
      const replay = decodeValidatedPatternReplay(
        record.diagnostics.strategyInputReplay,
        record.strategy.codeCommitSha,
      ).replay;
      const atMs = replay.context.observedAtMs!;
      const intervalCoverage = await verifyIntervalCoverage(
        capture.session,
        record,
        record.symbol,
        previousAtMs,
        atMs,
      );
      const book = await readVerifiedExecutionBook(capture.session, {
        decisionId: record.decisionId,
        symbol: record.symbol,
        fromMs: previousAtMs,
        exchangeAsOfMs: replay.context.exchangeObservedAtMs!,
        receivedAsOfMs: atMs,
        maxAgeMs: 1000,
        expected: replay.context.executionBook,
      });
      frames.push({
        atMs,
        observation,
        intervalCoverage,
        book,
        exitEvidence: {
          currentBookPressure: replay.context.bookPressure,
          currentBtcContext: replay.context.btcContext,
          marketEvidence: null,
        },
      });
      previousAtMs = atMs;
    }
    const options = {
      riskBudgetUsdt: 1,
      maxNotionalUsdt: 100,
      quantityStep: 0.001,
      minNotionalUsdt: 1,
      feeBpsPerSide: 5,
      adverseSlippageBps: 1,
      entryDelayMs: 1000,
      exitDelayMs: 1000,
      maxFrameGapMs: 2000,
      fundingEvidence,
    };
    const results = replayPairedExecutions(frames, defaultMicroBurstConfig(), options);
    expect(results).toHaveLength(2);
    expect(
      results.every((result) => result.executionKind === 'MODELLED_BOOK_VWAP_NOT_REAL_FILL'),
    ).toBe(true);
    expect(results[0].entryAtMs).toBe(BASE + 1000);
    expect(results[1].entryAtMs).toBe(BASE + 4000);
    expect(results[1].entryAudit?.bookSha256).not.toBe(results[0].entryAudit?.bookSha256);
    expect(results[0].protectionAssumption).toBe('IMMEDIATE_STOP_COVERAGE_NOT_EXCHANGE_VALIDATED');
    const report = summarizePairedReplay(frames, results);
    expect(report.resultKind).toBe('MODELLED_BOOK_VWAP_NOT_REAL_FILL');
    expect(report.independentBaselineEpisodes).toBe(1);
    expect(report.terminalOutcomes).toHaveLength(1);
  } finally {
    capture.cleanup();
  }
});

it('keeps modeled fills UNKNOWN when there is no verified funding coverage', async () => {
  const capture = await pairedSession(undefined, false);
  try {
    const records = await readVerifiedDecisionRecords(capture.session, BASE, BASE + 7000);
    const candidate = new MicroBurstPullbackCandidate();
    const frames: PairedReplayFrame[] = [];
    let previousAtMs = BASE - 1000;
    for (const record of records) {
      const observation = await candidate.evaluate(capture.session, record);
      const replay = decodeValidatedPatternReplay(
        record.diagnostics.strategyInputReplay,
        record.strategy.codeCommitSha,
      ).replay;
      const atMs = replay.context.observedAtMs!;
      frames.push({
        atMs,
        observation,
        intervalCoverage: await verifyIntervalCoverage(
          capture.session,
          record,
          record.symbol,
          previousAtMs,
          atMs,
        ),
        book: await readVerifiedExecutionBook(capture.session, {
          decisionId: record.decisionId,
          symbol: record.symbol,
          fromMs: previousAtMs,
          exchangeAsOfMs: replay.context.exchangeObservedAtMs!,
          receivedAsOfMs: atMs,
          maxAgeMs: 1000,
          expected: replay.context.executionBook,
        }),
        exitEvidence: { currentBookPressure: null, currentBtcContext: null, marketEvidence: null },
      });
      previousAtMs = atMs;
    }
    const report = replayPairedExecutions(frames, defaultMicroBurstConfig(), {
      riskBudgetUsdt: 1,
      maxNotionalUsdt: 100,
      quantityStep: 0.001,
      minNotionalUsdt: 1,
      feeBpsPerSide: 5,
      adverseSlippageBps: 1,
      entryDelayMs: 1000,
      exitDelayMs: 1000,
      maxFrameGapMs: 2000,
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
    const candidate = new MicroBurstPullbackCandidate();
    const frames: PairedReplayFrame[] = [];
    let previousAtMs = BASE - 1000;
    for (const record of records) {
      const observation = await candidate.evaluate(capture.session, record);
      const replay = decodeValidatedPatternReplay(
        record.diagnostics.strategyInputReplay,
        record.strategy.codeCommitSha,
      ).replay;
      const atMs = replay.context.observedAtMs!;
      const intervalCoverage = await verifyIntervalCoverage(
        capture.session,
        record,
        record.symbol,
        previousAtMs,
        atMs,
      );
      const book = await readVerifiedExecutionBook(capture.session, {
        decisionId: record.decisionId,
        symbol: record.symbol,
        fromMs: previousAtMs,
        exchangeAsOfMs: replay.context.exchangeObservedAtMs!,
        receivedAsOfMs: atMs,
        maxAgeMs: 1000,
      });
      frames.push({
        atMs,
        observation,
        intervalCoverage,
        book,
        exitEvidence: { currentBookPressure: null, currentBtcContext: null, marketEvidence: null },
      });
      previousAtMs = atMs;
    }
    const results = replayPairedExecutions(frames, defaultMicroBurstConfig(), {
      riskBudgetUsdt: 1,
      maxNotionalUsdt: 100,
      quantityStep: 0.001,
      minNotionalUsdt: 1,
      feeBpsPerSide: 5,
      adverseSlippageBps: 1,
      entryDelayMs: 1000,
      exitDelayMs: 1000,
      maxFrameGapMs: 2000,
      fundingEvidence,
    });
    expect(
      results.every((result) => result.status === 'UNKNOWN' && result.netPnlUsdt === undefined),
    ).toBe(true);
    const report = summarizePairedReplay(frames, results);
    expect(report.operable.pairedClosedEpisodes).toBe(0);
    expect(report.terminalOutcomes[0].current).toBe('UNKNOWN_OR_INCOMPLETE');
  } finally {
    capture.cleanup();
  }
});
