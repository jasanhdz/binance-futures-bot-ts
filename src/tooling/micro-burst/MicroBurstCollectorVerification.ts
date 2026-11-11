import {
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  openSync,
  fstatSync,
  readSync,
  closeSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { hashTree } from './MicroBurstCollectorFreeze';
import { scanStableJsonl, canonicalEvidence } from './MicroBurstInputForensics';
import { readVerifiedSegments, causalExecutionBook } from './MicroBurstCausalArchive';
import type { StrategyDecisionEvidenceV2 } from '../../core/blackbox/StrategyDecisionBlackBox';
import type { MicroBurstExactReplay } from '../../strategies/micro-burst/domain/MicroBurstExactReplay';

export async function verifyCollector(root: string): Promise<Record<string, unknown>> {
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  const health = JSON.parse(readFileSync(join(root, 'health.json'), 'utf8'));
  const codeVerified =
    canonicalEvidence(hashTree(join(root, 'code'))) === canonicalEvidence(manifest.files.code);
  const dependenciesVerified =
    canonicalEvidence(hashTree(join(root, 'node_modules'))) ===
    canonicalEvidence(manifest.files.dependencies);
  if (!codeVerified || !dependenciesVerified) throw new Error('FROZEN_COLLECTOR_ARTIFACT_CHANGED');
  const evaluator = require(
    join(root, 'code/strategies/micro-burst/domain/MicroBurstExactReplay.js'),
  ) as typeof import('../../strategies/micro-burst/domain/MicroBurstExactReplay');
  const capture = join(root, 'capture');
  const sources: unknown[] = [];
  const records: StrategyDecisionEvidenceV2[] = [];
  const selected = new Map<string, number>();
  // Immutable bounded excerpt of an append-only active file. Boundaries are explicitly
  // excluded; this is replay evidence for selected rows, never full-session coverage.
  const active = join(capture, 'decisions.jsonl');
  const fd = openSync(active, 'r');
  let excerpt: string;
  try {
    const stat = fstatSync(fd);
    const start = Math.max(0, stat.size - 32 * 1024 * 1024);
    const buffer = Buffer.alloc(stat.size - start);
    let bytes = 0;
    while (bytes < buffer.length) {
      const n = readSync(fd, buffer, bytes, buffer.length - bytes, start + bytes);
      if (n <= 0) throw new Error('ACTIVE_CAPTURE_PREFIX_READ_INCOMPLETE');
      bytes += n;
    }
    const first = start === 0 ? 0 : buffer.indexOf(10) + 1;
    const last = buffer.lastIndexOf(10);
    if (last < first) throw new Error('ACTIVE_CAPTURE_HAS_NO_COMPLETE_ROWS');
    excerpt = join(root, `decision-excerpt-${Date.now()}.jsonl`);
    writeFileSync(excerpt, buffer.subarray(first, last + 1), { flag: 'wx' });
    sources.push({
      originalFile: active,
      inode: stat.ino,
      sourceSizeAtRead: stat.size,
      includedByteStart: start + first,
      includedByteEndExclusive: start + last + 1,
      excerpt,
      boundaryPolicy: 'EXCLUDED_PARTIAL_ROWS_NOT_FULL_SESSION_COVERAGE',
    });
  } finally {
    closeSync(fd);
  }
  const visit = (value: unknown): void => {
    const r = value as StrategyDecisionEvidenceV2;
    if (
      !r.symbol ||
      (selected.get(r.symbol) ?? 0) >= 5 ||
      r.evaluatedAtReceivedMs < health.startedAtMs + 300_000 ||
      r.evaluatedAtReceivedMs > health.atMs - 60_000 ||
      r.reason !== 'REACTION_NO_QUALIFIED_SIDE'
    )
      return;
    const replay = r.diagnostics?.strategyInputReplay as MicroBurstExactReplay;
    if (!replay?.context.dataQuality.contextValid || !replay.context.executionBook) return;
    selected.set(r.symbol, (selected.get(r.symbol) ?? 0) + 1);
    records.push(r);
  };
  sources.push(await scanStableJsonl(excerpt, visit));
  for (const name of readdirSync(capture)
    .filter(
      (name) =>
        name.startsWith('decisions.') && name.endsWith('.jsonl.gz') && !name.includes('timing'),
    )
    .sort()) {
    sources.push(
      await scanStableJsonl(join(capture, name), (value) => {
        const r = value as StrategyDecisionEvidenceV2;
        if (
          !r.symbol ||
          (selected.get(r.symbol) ?? 0) >= 5 ||
          r.evaluatedAtReceivedMs < health.startedAtMs + 300_000 ||
          r.reason !== 'REACTION_NO_QUALIFIED_SIDE'
        )
          return;
        const replay = r.diagnostics?.strategyInputReplay as MicroBurstExactReplay;
        if (!replay?.context.dataQuality.contextValid || !replay.context.executionBook) return;
        selected.set(r.symbol, (selected.get(r.symbol) ?? 0) + 1);
        records.push(r);
      }),
    );
    if (selected.size >= 2 && [...selected.values()].every((n) => n >= 5)) break;
  }
  const db = new Database(join(capture, 'research.sqlite'), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const comparisons = records.map((r) => {
      const replay = r.diagnostics.strategyInputReplay as MicroBurstExactReplay;
      const actual = evaluator.replayMicroBurstExact(replay, replay.codeCommitSha);
      const decisionMatch =
        actual.action === r.decision &&
        actual.reason === r.reason &&
        actual.side === r.side &&
        actual.stopInvalidationPrice === r.structuralInvalidation &&
        actual.targetPrice === r.destinationPrice;
      const expectedBook = replay.context.executionBook!;
      const row = db
        .prepare(
          'SELECT checkpoint_json,created_at_ms FROM book_checkpoints WHERE symbol=? AND event_time_ms<=? AND created_at_ms<=? ORDER BY event_time_ms DESC LIMIT 1',
        )
        .get(r.symbol, expectedBook.observedAtMs, r.evaluatedAtReceivedMs) as
        | { checkpoint_json: string; created_at_ms: number }
        | undefined;
      if (!row)
        return {
          decisionId: r.decisionId,
          symbol: r.symbol,
          decisionMatch,
          book: 'CHECKPOINT_MISSING',
        };
      const checkpoint = JSON.parse(row.checkpoint_json);
      // Read all finalized depth segments for the symbol: range indexes use exchange time,
      // while this replay selects strictly by recorded receive time.
      const segments = db
        .prepare(
          "SELECT file_path AS filePath,checksum,record_count AS recordCount FROM market_data_segments WHERE symbol=? AND data_type='depth' ORDER BY first_event_time_ms",
        )
        .all(r.symbol) as { filePath: string; checksum: string; recordCount: number }[];
      const events = readVerifiedSegments(segments);
      const reconstructed = causalExecutionBook(
        {
          symbol: r.symbol,
          receivedAtMs: checkpoint.observedAtMs,
          lastUpdateId: checkpoint.lastUpdateId,
          bids: checkpoint.bids,
          asks: checkpoint.asks,
        },
        events,
        expectedBook.observedAtMs,
        2000,
      );
      const floor = Math.min(...checkpoint.bids.map((l: { price: number }) => l.price));
      const ceiling = Math.max(...checkpoint.asks.map((l: { price: number }) => l.price));
      const expectedBids = expectedBook.bidDepth.filter((l) => l.price >= floor);
      const expectedAsks = expectedBook.askDepth.filter((l) => l.price <= ceiling);
      // A checkpoint can retain more known levels than the live top-20 projection.
      const matched =
        reconstructed &&
        canonicalEvidence(reconstructed.bidDepth.slice(0, expectedBids.length)) ===
          canonicalEvidence(expectedBids) &&
        canonicalEvidence(reconstructed.askDepth.slice(0, expectedAsks.length)) ===
          canonicalEvidence(expectedAsks) &&
        reconstructed.observedAtMs === expectedBook.observedAtMs &&
        expectedBids.length > 0 &&
        expectedAsks.length > 0;
      return {
        decisionId: r.decisionId,
        symbol: r.symbol,
        observedAtMs: r.evaluatedAtReceivedMs,
        decision: r.decision,
        reason: r.reason,
        decisionMatch,
        book: matched ? 'MATCH_WITHIN_KNOWN_DEPTH' : 'MISMATCH_OR_GAP',
        checkpointAtMs: checkpoint.observedAtMs,
        checkpointPersistedAtMs: row.created_at_ms,
        bookAtMs: expectedBook.observedAtMs,
        replayedDepthEvents: events.filter(
          (e) =>
            e.receivedAtMs > checkpoint.observedAtMs && e.receivedAtMs <= expectedBook.observedAtMs,
        ).length,
        knownBidLevelsCompared: expectedBids.length,
        knownAskLevelsCompared: expectedAsks.length,
      };
    });
    const size = (path: string): number =>
      readdirSync(path).reduce((sum, name) => {
        const p = join(path, name),
          s = statSync(p);
        return sum + (s.isDirectory() ? size(p) : s.size);
      }, 0);
    return {
      authority: 'OBSERVATIONAL_CAPTURE_VERIFICATION',
      root,
      verifiedAtMs: Date.now(),
      artifactHash: manifest.artifactHash,
      codeVerified,
      dependenciesVerified,
      sources,
      comparisons,
      captureBytes: size(capture),
      sessionAgeMs: health.atMs - health.startedAtMs,
      health,
      economicEpisodeCertified: false,
      milestone:
        comparisons.length >= 10 &&
        comparisons.every((c) => c.decisionMatch && c.book === 'MATCH_WITHIN_KNOWN_DEPTH')
          ? 'REAL_POST_WARMUP_SLICE_REPRODUCED_CHECK_HEALTH_AND_GAPS'
          : 'INCOMPLETE_OR_MISMATCH',
    };
  } finally {
    db.close();
  }
}

if (require.main === module) {
  const root = resolve(process.argv[2]);
  verifyCollector(root)
    .then((report) => {
      const output = join(root, `verification-${Date.now()}.json`);
      writeFileSync(output, JSON.stringify(report, null, 2), { flag: 'wx' });
      const h = report.health as Record<string, unknown>;
      const runtime = h.runtime as Record<string, unknown>;
      console.log(
        JSON.stringify(
          {
            ...report,
            health: undefined,
            sources: undefined,
            observations: h.observations,
            memory: h.memory,
            cpu: h.cpu,
            eventLoopP99Ms: h.eventLoopP99Ms,
            auxiliaryWriteFailures: h.auxiliaryWriteFailures,
            runtimeHealth: Object.fromEntries(
              [
                'totalEvaluations',
                'totalEvaluationFailures',
                'marketArchiveHealthy',
                'archiveQueueDepth',
                'archiveOverflowRecords',
                'archiveWrittenRecords',
                'storageErrors',
                'observationQueue',
                'mutationAttempts',
                'forwardedMutations',
              ].map((key) => [key, runtime[key]]),
            ),
            output,
          },
          null,
          2,
        ),
      );
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
