import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { TEST_SNAPSHOT_AT_MS } from '../../strategies/micro-burst/domain/MicroBurst.test-support';
import { defaultMicroBurstConfig } from '../../strategies/micro-burst/domain/MicroBurstTypes';
import type { StrategyDecisionEvidenceV2 } from '../../core/blackbox/StrategyDecisionBlackBox';
import type {
  ArchiveDepth,
  ArchiveTrade,
} from '../../strategies/micro-burst/research/MicroBurstStorage';
import { assertVerifiedEpisodeExecution } from './MicroBurstPairedExecutionReplay';
import { replayPairedExecutions } from './MicroBurstPairedExecutionReplay';
import {
  MICRO_PAIRED_REPLAY_EVIDENCE_CONTRACT_SHA256,
  MICRO_PAIRED_REPLAY_EVIDENCE_CONTRACT_V1,
} from './MicroBurstReplayEvidenceContract';
import { assertVerifiedReplayFrame } from './MicroBurstVerifiedReplayFrame';
import { runPairedReplayRequestFile } from './MicroBurstPairedReplayOrchestrator';
import {
  createSyntheticCaptureSession,
  makeSyntheticDecisionRecord,
  makeSyntheticNoFundingEvidence,
} from './MicroBurstCaptureSession.test-support';

const BASE = TEST_SNAPSHOT_AT_MS;
const EXECUTION = {
  riskBudgetUsdt: 1,
  maxNotionalUsdt: 100,
  quantityStep: 0.001,
  minNotionalUsdt: 1,
  feeBpsPerSide: 5,
  adverseSlippageBps: 1,
  entryDelayMs: 1000,
  exitDelayMs: 1000,
};

interface FixtureOptions {
  decisionCount?: number;
  rejectCurrent?: boolean;
  flatTrades?: boolean;
  depthQty?: number;
  gapAt?: number;
  moveBeforeEntry?: boolean;
  mismatchDecision?: boolean;
  maxHoldMs?: number;
  availabilityOffsetMs?: number;
  noFunding?: boolean;
}

async function fixture(options: FixtureOptions = {}) {
  const count = options.decisionCount ?? 8;
  const times = Array.from({ length: count }, (_, index) => BASE + index * 1000);
  const decisions = times.map((atMs, index) => {
    const mid = options.moveBeforeEntry && index >= 1 ? 102 : 100;
    const record = makeSyntheticDecisionRecord(atMs, 'LONG', 'SOLUSDT', {
      rejectBaseline: options.rejectCurrent,
      book: {
        bid: mid - 0.01,
        ask: mid + 0.01,
        bidQty: options.depthQty ?? 100,
        askQty: options.depthQty ?? 100,
      },
      ...(options.maxHoldMs
        ? {
            replayConfig: {
              ...defaultMicroBurstConfig(),
              exitMaxHoldMs: options.maxHoldMs,
            },
          }
        : {}),
    });
    if (!options.mismatchDecision && !options.availabilityOffsetMs) return record;
    return {
      ...record,
      ...(options.availabilityOffsetMs
        ? {
            evaluatedAtReceivedMs: atMs + options.availabilityOffsetMs,
            recordedAtMs: atMs + options.availabilityOffsetMs + 1,
          }
        : {}),
      ...(options.mismatchDecision && index === 0 ? { reason: 'INJECTED_DECISION_MISMATCH' } : {}),
    } as StrategyDecisionEvidenceV2;
  });
  const trades: ArchiveTrade[] = Array.from({ length: 72 }, (_, index) => {
    const eventTime = BASE - 61_000 + index * 1000;
    return {
      symbol: 'SOLUSDT',
      eventTime,
      receivedAtMs: eventTime,
      aggregateTradeId: index + 1,
      price: options.flatTrades ? 100 : 100 + index * 0.01,
      quantity: 1,
      isBuyerMaker: false,
    };
  });
  const depth: ArchiveDepth[] = times.map((eventTime, index) => {
    const mid = options.moveBeforeEntry && index >= 1 ? 102 : 100;
    const previousMid = options.moveBeforeEntry && index - 1 >= 1 ? 102 : 100;
    return {
      symbol: 'SOLUSDT',
      eventTime,
      receivedAtMs: eventTime,
      E: eventTime,
      T: eventTime,
      U: 1000 + index,
      u: 1000 + index,
      pu: 999 + index,
      b: [
        ...(index > 0 ? [[String(previousMid - 0.01), '0'] as [string, string]] : []),
        [String(mid - 0.01), String(options.depthQty ?? 100)],
      ],
      a: [
        ...(index > 0 ? [[String(previousMid + 0.01), '0'] as [string, string]] : []),
        [String(mid + 0.01), String(options.depthQty ?? 100)],
      ],
    };
  });
  const checkpoints = times.map((eventTimeMs, index) => {
    const mid = options.moveBeforeEntry && index >= 1 ? 102 : 100;
    return {
      symbol: 'SOLUSDT',
      eventTimeMs,
      checkpoint: {
        schemaVersion: 1,
        symbol: 'SOLUSDT',
        observedAtMs: eventTimeMs,
        lastUpdateId: 1000 + index,
        bids: [
          { price: mid - 0.01, qty: options.depthQty ?? 100 },
          { price: 98, qty: options.depthQty ?? 100 },
        ],
        asks: [
          { price: mid + 0.01, qty: options.depthQty ?? 100 },
          { price: 104, qty: options.depthQty ?? 100 },
        ],
      },
    };
  });
  const capture = await createSyntheticCaptureSession({
    startedAtMs: BASE - 120_000,
    completedAtMs: BASE + 90_000,
    storageNowMs: BASE - 120_000,
    trades,
    depth,
    checkpoints,
    decisionRecords: decisions,
    fundingEvidenceRecords: options.noFunding
      ? []
      : [makeSyntheticNoFundingEvidence('SOLUSDT', BASE - 120_000, BASE + 90_000)],
    gaps:
      options.gapAt === undefined
        ? []
        : [
            {
              symbol: 'SOLUSDT',
              startedAtMs: options.gapAt,
              endedAtMs: options.gapAt,
              feed: 'DEPTH',
            },
          ],
  });
  const outputRoot = mkdtempSync(join(tmpdir(), 'micro-paired-replay-output-'));
  return {
    ...capture,
    outputRoot,
    cleanup: () => {
      capture.cleanup();
      rmSync(outputRoot, { recursive: true, force: true });
    },
  };
}

function writeRequest(
  root: string,
  captureRoot: string,
  outputDir: string,
  options: {
    throughMs?: number;
    selectionHorizonMs?: number | null;
    episodeId?: string;
    execution?: typeof EXECUTION;
  } = {},
): string {
  const request = {
    schema: 'MICRO_PAIRED_ARCHIVE_REPLAY_REQUEST_V1',
    captureRoot,
    outputDir,
    symbol: 'SOLUSDT',
    range: { fromReceivedAtMs: BASE, throughReceivedAtMs: options.throughMs ?? BASE + 7000 },
    selection: {
      ...(options.episodeId ? { episodeId: options.episodeId } : {}),
      selectionHorizonMs: options.selectionHorizonMs ?? null,
    },
    experiment: {
      schema: MICRO_PAIRED_REPLAY_EVIDENCE_CONTRACT_V1.schema,
      sha256: MICRO_PAIRED_REPLAY_EVIDENCE_CONTRACT_SHA256,
    },
    execution: options.execution ?? EXECUTION,
  };
  const requestPath = join(root, 'request.json');
  writeFileSync(requestPath, JSON.stringify(request), { flag: 'wx' });
  return requestPath;
}

function loadReport(outputDir: string): Record<string, any> {
  return JSON.parse(readFileSync(join(outputDir, 'report.json'), 'utf8')) as Record<string, any>;
}

it('runs verified session to paired CURRENT/PULLBACK closures, deduplicating repeated decisions', async () => {
  const capture = await fixture({ maxHoldMs: 2000 });
  try {
    const out = join(capture.outputRoot, 'run');
    const result = await runPairedReplayRequestFile(
      writeRequest(capture.outputRoot, capture.root, out, { selectionHorizonMs: 5000 }),
    );
    const report = loadReport(out);
    expect(result.status).toBe('COMPLETED');
    expect(report.counts.decisionsForSymbol).toBe(8);
    expect(report.counts.uniqueEpisodes).toBe(1);
    expect(report.executions).toHaveLength(2);
    expect(report.executions.map((row: any) => row.variant)).toEqual(['CURRENT', 'PULLBACK']);
    expect(
      report.executions.every((row: any) => row.status === 'CLOSED'),
      JSON.stringify(report.executions),
    ).toBe(true);
    expect(report.executions[0].entryAtMs).toBe(BASE + 1000);
    expect(report.executions[1].entryAtMs).toBeGreaterThan(report.executions[0].entryAtMs);
    expect(report.executor.currentDecisionMode).toBe('RE_EVALUATION_USING_CAPTURED_INPUTS');
    expect(report.economicComparison.pairedClosedEpisodes).toBe(1);
    expect(report.executionKind).toBe('MODELLED_BOOK_VWAP_NOT_REAL_FILL');
  } finally {
    capture.cleanup();
  }
});

it('starts delays from decision availability, not an earlier context observation timestamp', async () => {
  const capture = await fixture({ availabilityOffsetMs: 100, maxHoldMs: 2000 });
  try {
    const out = join(capture.outputRoot, 'availability');
    await runPairedReplayRequestFile(
      writeRequest(capture.outputRoot, capture.root, out, {
        throughMs: BASE + 7100,
        selectionHorizonMs: 5000,
      }),
    );
    const report = loadReport(out);
    expect(report.observations[0].evaluatedAtReceivedMs).toBe(BASE + 100);
    expect(report.executions.find((row: any) => row.variant === 'CURRENT')?.signalAtMs).toBe(
      BASE + 100,
    );
    expect(report.executions.find((row: any) => row.variant === 'CURRENT')?.entryAtMs).toBe(
      BASE + 2000,
    );
  } finally {
    capture.cleanup();
  }
});

it('distinguishes CURRENT execution, selector rejection, and an explicitly expired selection window', async () => {
  const rejected = await fixture({ flatTrades: true });
  const waiting = await fixture({ decisionCount: 1 });
  try {
    const rejectedOut = join(rejected.outputRoot, 'rejected');
    await runPairedReplayRequestFile(writeRequest(rejected.outputRoot, rejected.root, rejectedOut));
    const rejectedReport = loadReport(rejectedOut);
    expect(rejectedReport.terminalOutcomes[0].current).toMatch(
      /MODELLED_CLOSED|SESSION_ENDED_WITH_FOLLOW_UP_PENDING/,
    );
    expect(rejectedReport.terminalOutcomes[0].pullback).toBe('REJECTED_BY_SELECTOR');

    const waitingOut = join(waiting.outputRoot, 'waiting');
    await runPairedReplayRequestFile(
      writeRequest(waiting.outputRoot, waiting.root, waitingOut, {
        throughMs: BASE + 5000,
        selectionHorizonMs: 3000,
      }),
    );
    const waitingReport = loadReport(waitingOut);
    expect(waitingReport.terminalOutcomes[0].pullback).toBe(
      'SELECTION_WINDOW_EXPIRED_WITHOUT_QUALIFICATION',
    );
    expect(waitingReport.terminalOutcomes[0].pullbackSelection).toBe('WAITING');
    const noHorizonOut = join(waiting.outputRoot, 'no-horizon');
    const noHorizonRequest = join(waiting.outputRoot, 'request-no-horizon.json');
    writeFileSync(
      noHorizonRequest,
      readFileSync(join(waiting.outputRoot, 'request.json'), 'utf8')
        .replace(waitingOut, noHorizonOut)
        .replace('"selectionHorizonMs":3000', '"selectionHorizonMs":null'),
      { flag: 'wx' },
    );
    await runPairedReplayRequestFile(noHorizonRequest);
    expect(loadReport(noHorizonOut).terminalOutcomes[0].pullback).toBe('WAITING_AT_END_OF_CAPTURE');
  } finally {
    rejected.cleanup();
    waiting.cleanup();
  }
});

it('reports disappearing opportunity, shallow depth, and pre-entry depth gap without fabricated PnL', async () => {
  const disappeared = await fixture({ moveBeforeEntry: true });
  const shallow = await fixture({ depthQty: 0.001 });
  const gap = await fixture({ gapAt: BASE + 500 });
  try {
    const disappearedOut = join(disappeared.outputRoot, 'disappeared');
    await runPairedReplayRequestFile(
      writeRequest(disappeared.outputRoot, disappeared.root, disappearedOut),
    );
    expect(
      loadReport(disappearedOut).executions[0],
      JSON.stringify(loadReport(disappearedOut).executions[0]),
    ).toMatchObject({
      variant: 'CURRENT',
      status: 'UNFILLED',
    });

    const shallowOut = join(shallow.outputRoot, 'shallow');
    await runPairedReplayRequestFile(writeRequest(shallow.outputRoot, shallow.root, shallowOut));
    const shallowReport = loadReport(shallowOut);
    expect(shallowReport.executions.every((row: any) => row.status === 'UNFILLED')).toBe(true);
    expect(shallowReport.executions.every((row: any) => row.netPnlUsdt === undefined)).toBe(true);

    const gapOut = join(gap.outputRoot, 'gap');
    await runPairedReplayRequestFile(writeRequest(gap.outputRoot, gap.root, gapOut));
    const gapReport = loadReport(gapOut);
    expect(gapReport.evidenceRejections.length).toBeGreaterThan(0);
    expect(gapReport.executions.every((row: any) => row.netPnlUsdt === undefined)).toBe(true);
  } finally {
    disappeared.cleanup();
    shallow.cleanup();
    gap.cleanup();
  }
});

it('reports accepted signals without an entry when required funding evidence is absent', async () => {
  const capture = await fixture({ noFunding: true });
  try {
    const out = join(capture.outputRoot, 'no-funding');
    await runPairedReplayRequestFile(writeRequest(capture.outputRoot, capture.root, out));
    const report = loadReport(out);
    expect(report.counts.fundingUnavailable).toBe(true);
    expect(report.terminalOutcomes[0]).toMatchObject({
      current: 'ACCEPTED_WITHOUT_MODELLED_EXECUTION',
      currentReason: 'FUNDING_EVIDENCE_UNAVAILABLE_OR_OUTSIDE_REPLAY_WINDOW',
    });
    expect(report.executions.every((row: any) => row.entryAtMs === undefined)).toBe(true);
  } finally {
    capture.cleanup();
  }
});

it('preserves entry evidence but makes total PnL unknown after an open-position gap or session end', async () => {
  const gap = await fixture({ gapAt: BASE + 3000 });
  const short = await fixture({ decisionCount: 2 });
  try {
    for (const capture of [gap, short]) {
      const out = join(capture.outputRoot, 'incomplete');
      await runPairedReplayRequestFile(writeRequest(capture.outputRoot, capture.root, out));
      const report = loadReport(out);
      const current = report.executions.find((row: any) => row.variant === 'CURRENT');
      expect(current?.entryAudit).toBeDefined();
      expect(current?.status).toBe('UNKNOWN');
      expect(current?.netPnlUsdt).toBeUndefined();
    }
  } finally {
    gap.cleanup();
    short.cleanup();
  }
});

it('completes successfully with no eligible episodes and distinguishes incompatible manifests', async () => {
  const empty = await fixture({ rejectCurrent: true });
  const incompatible = await fixture();
  try {
    const emptyOut = join(empty.outputRoot, 'empty');
    await runPairedReplayRequestFile(writeRequest(empty.outputRoot, empty.root, emptyOut));
    const report = loadReport(emptyOut);
    expect(report.status).toBe('NO_ELIGIBLE_EPISODES');
    expect(report.terminalOutcomes).toEqual([]);
    expect(report.economicComparison.current.meanNetUsdt).toBeNull();
    expect(report.economicComparison.pullback.meanNetUsdt).toBeNull();

    const manifestPath = join(incompatible.root, 'capture-session.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.manifestSha256 = '0'.repeat(64);
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const badOut = join(incompatible.outputRoot, 'bad');
    await expect(
      runPairedReplayRequestFile(writeRequest(incompatible.outputRoot, incompatible.root, badOut)),
    ).rejects.toThrow('CAPTURE_SESSION_NOT_CERTIFIED');
  } finally {
    empty.cleanup();
    incompatible.cleanup();
  }
});

it('refuses result directories inside the archived session', async () => {
  const capture = await fixture();
  try {
    const request = writeRequest(capture.outputRoot, capture.root, join(capture.root, 'results'));
    await expect(runPairedReplayRequestFile(request)).rejects.toThrow(
      'PAIRED_REPLAY_OUTPUT_MUST_BE_SEPARATE_FROM_CAPTURE',
    );
  } finally {
    capture.cleanup();
  }
});

it('writes deterministic reports, preserves episode filters, and rejects unverified caller objects', async () => {
  const capture = await fixture();
  try {
    const episodeId = capture.session
      ? (await import('./MicroBurstCaptureSession'))
          .readVerifiedDecisionRecords(capture.session, BASE, BASE + 7000)
          .then((rows) => String(rows[0].diagnostics.episodeId))
      : Promise.resolve('');
    const selectedId = await episodeId;
    const out1 = join(capture.outputRoot, 'deterministic-1');
    const out2 = join(capture.outputRoot, 'deterministic-2');
    const request1 = writeRequest(capture.outputRoot, capture.root, out1, {
      episodeId: selectedId,
    });
    const request2 = join(capture.outputRoot, 'request-2.json');
    writeFileSync(request2, readFileSync(request1, 'utf8').replace(out1, out2), { flag: 'wx' });
    await runPairedReplayRequestFile(request1);
    await runPairedReplayRequestFile(request2);
    const bytes1 = readFileSync(join(out1, 'report.json'));
    const bytes2 = readFileSync(join(out2, 'report.json'));
    expect(bytes1.equals(bytes2)).toBe(true);
    const report = JSON.parse(bytes1.toString('utf8'));
    expect(report.request.selectionCriterion).toBe('EXACT_EPISODE_ID');
    expect(report.counts.uniqueEpisodes).toBe(1);

    expect(() => assertVerifiedReplayFrame({ schema: 'MICRO_VERIFIED_REPLAY_FRAME_V1' })).toThrow(
      'REPLAY_FRAME_NOT_CAPTURE_VERIFIED',
    );
    expect(() => assertVerifiedEpisodeExecution({ variant: 'CURRENT' })).toThrow(
      'EPISODE_RESULT_NOT_PAIRED_REPLAY_VERIFIED',
    );
    const honestResults = replayPairedExecutions([], {
      ...EXECUTION,
      fundingEvidence: null,
    });
    expect(Object.isFrozen(honestResults)).toBe(true);
    expect(createHash('sha256').update(bytes1).digest('hex')).toBe(
      createHash('sha256').update(bytes2).digest('hex'),
    );
  } finally {
    capture.cleanup();
  }
});

it('keeps a CURRENT decision/evaluator discrepancy as a technical error', async () => {
  const capture = await fixture({ mismatchDecision: true });
  try {
    const out = join(capture.outputRoot, 'mismatch');
    await runPairedReplayRequestFile(writeRequest(capture.outputRoot, capture.root, out));
    const report = loadReport(out);
    expect(report.status).toBe('COMPLETED_WITH_TECHNICAL_ERRORS');
    expect(report.technicalErrors[0].reason).toContain('STORED_CURRENT_DECISION_MISMATCH');
    expect(report.observations[0].currentVerification).toBe('TECHNICAL_ERROR');
    expect(report.terminalOutcomes[0]).toMatchObject({
      current: 'TECHNICAL_ERROR',
      pullback: 'TECHNICAL_ERROR',
    });
  } finally {
    capture.cleanup();
  }
});
