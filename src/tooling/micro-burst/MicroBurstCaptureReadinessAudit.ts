import { createReadStream, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import type { StrategyDecisionEvidenceV2 } from '../../core/blackbox/StrategyDecisionBlackBox';
import type { MicroBurstExactReplay } from '../../strategies/micro-burst/domain/MicroBurstExactReplay';

interface Bucket {
  observations: number;
  phase: Record<string, number>;
  reasons: Record<string, number>;
  inputInvalidReasons: Record<string, number>;
  sideReasons: Record<string, number>;
  acceptedEpisodeIds: string[];
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

export function classifyReadiness(
  record: StrategyDecisionEvidenceV2,
  captureStartMs: number,
): {
  phase: string;
  reason: string;
  invalidReasons: string[];
  sideReasons: string[];
  episodeId: string | null;
} {
  const replay = record.diagnostics?.strategyInputReplay as MicroBurstExactReplay | undefined;
  const ctx = replay?.context;
  const flow = ctx?.aggTradeFlow;
  const invalidReasons = ctx?.dataQuality?.invalidReasons ?? [];
  const elapsedWarmup = record.evaluatedAtReceivedMs - captureStartMs >= 300_000;
  const complete =
    flow?.windowComplete === true && flow.gapFree === true && flow.capacityTruncated === false;
  const phase = !elapsedWarmup
    ? 'INITIAL_CAPTURE_WARMUP'
    : !ctx
      ? 'POST_WARMUP_INPUT_MISSING'
      : !ctx.dataQuality.contextValid || !complete
        ? 'POST_WARMUP_DATA_INCOMPLETE'
        : [
              'BTC_UNAVAILABLE',
              'BOOK_NOT_HEALTHY',
              'REACTION_BOOK_NOT_FRESH',
              'REACTION_SNAPSHOT_EXPIRED',
              'REACTION_FLOW_UNAVAILABLE',
            ].includes(record.reason)
          ? 'POST_WARMUP_AT_USE_DATA_REJECTED'
          : 'POST_WARMUP_CONTEXT_EVALUABLE';
  const sides = record.diagnostics?.sides as Record<string, { reason?: string }> | undefined;
  return {
    phase,
    reason: record.reason,
    invalidReasons,
    sideReasons: Object.entries(sides ?? {}).map(
      ([side, value]) => `${side}:${value.reason ?? 'UNKNOWN'}`,
    ),
    episodeId:
      typeof record.diagnostics?.episodeId === 'string' ? record.diagnostics.episodeId : null,
  };
}

/** Read-only streaming audit. Malformed rows quarantine their source file, not silently repaired. */
export async function auditCaptureReadiness(
  files: readonly string[],
  captureStartMs: number,
  throughMs: number,
): Promise<Record<string, unknown>> {
  if (![captureStartMs, throughMs].every(Number.isFinite) || captureStartMs >= throughMs)
    throw new Error('INVALID_CAPTURE_AUDIT_RANGE');
  const buckets: Record<string, Bucket> = {};
  const sources: Record<string, unknown>[] = [];
  const malformed: Record<string, unknown>[] = [];
  for (const file of files) {
    const before = statSync(file);
    const hash = createHash('sha256');
    const input = createReadStream(file);
    input.on('data', (chunk) => hash.update(chunk));
    const decoded = file.endsWith('.gz') ? input.pipe(createGunzip()) : input;
    input.on('error', (error) => decoded.destroy(error));
    const lines = createInterface({ input: decoded, crlfDelay: Infinity });
    let lineNumber = 0,
      bad = 0,
      inRange = 0;
    let previous: Record<string, unknown> | null = null;
    const pending: Record<string, unknown>[] = [];
    try {
      for await (const line of lines) {
        lineNumber++;
        if (!line.trim()) continue;
        let record: StrategyDecisionEvidenceV2;
        try {
          record = JSON.parse(line) as StrategyDecisionEvidenceV2;
        } catch {
          bad++;
          const issue: Record<string, unknown> = {
            file,
            line: lineNumber,
            lineSha256: createHash('sha256').update(line).digest('hex'),
            bytes: Buffer.byteLength(line),
            previousValid: previous,
            nextValid: null,
            inferredTimestamp: null,
            disposition: 'QUARANTINE_SOURCE_FILE_NO_TIMESTAMP_INFERENCE',
          };
          malformed.push(issue);
          pending.push(issue);
          continue;
        }
        const location = {
          line: lineNumber,
          decisionId: record?.decisionId ?? null,
          receivedAtMs: record?.evaluatedAtReceivedMs ?? null,
          symbol: record?.symbol ?? null,
        };
        for (const issue of pending.splice(0)) issue.nextValid = location;
        previous = location;
        if (
          record?.strategy?.strategyId !== 'MICRO_BURST' ||
          !Number.isFinite(record.evaluatedAtReceivedMs) ||
          record.evaluatedAtReceivedMs < captureStartMs ||
          record.evaluatedAtReceivedMs > throughMs
        )
          continue;
        inRange++;
        const hour = new Date(record.evaluatedAtReceivedMs).toISOString().slice(0, 13);
        const key = `${record.symbol}:${hour}`;
        const bucket = (buckets[key] ??= {
          observations: 0,
          phase: {},
          reasons: {},
          inputInvalidReasons: {},
          sideReasons: {},
          acceptedEpisodeIds: [],
        });
        const classification = classifyReadiness(record, captureStartMs);
        bucket.observations++;
        increment(bucket.phase, classification.phase);
        increment(bucket.reasons, classification.reason);
        for (const reason of classification.invalidReasons)
          increment(bucket.inputInvalidReasons, reason);
        for (const reason of classification.sideReasons) increment(bucket.sideReasons, reason);
        if (
          record.decision === 'ENTRY_INTENT' &&
          classification.episodeId &&
          !bucket.acceptedEpisodeIds.includes(classification.episodeId)
        )
          bucket.acceptedEpisodeIds.push(classification.episodeId);
      }
    } finally {
      lines.close();
    }
    const after = statSync(file);
    if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs)
      throw new Error(`CAPTURE_SOURCE_CHANGED:${file}`);
    sources.push({
      file,
      sha256: hash.digest('hex'),
      bytes: before.size,
      lines: lineNumber,
      inRange,
      malformed: bad,
      eligibility: bad ? 'QUARANTINED' : 'PARSE_INTEGRITY_ONLY',
    });
  }
  const totals: Record<string, number> = {};
  const reasons: Record<string, number> = {};
  for (const bucket of Object.values(buckets)) {
    for (const [phase, n] of Object.entries(bucket.phase)) totals[phase] = (totals[phase] ?? 0) + n;
    for (const [reason, n] of Object.entries(bucket.reasons))
      reasons[reason] = (reasons[reason] ?? 0) + n;
  }
  return {
    authority: 'DESCRIPTIVE_CAPTURE_AUDIT',
    captureStartMs,
    throughMs,
    clock: 'LOCAL_RECEIVE_TIME',
    warmupRule: '300S_FROM_CAPTURE_START_PLUS_RECORDED_INPUT_QUALITY',
    observationCountsAreNotIndependentOpportunities: true,
    totals,
    reasons,
    buckets,
    sources,
    malformed,
    coverage: 'NOT_CERTIFIED_BY_PARSE_OR_AGGREGATED_COUNTS',
  };
}

if (require.main === module) {
  const [directory, prefix, from, through] = process.argv.slice(2);
  if (!directory || !prefix || !from || !through)
    throw new Error('USAGE: <directory> <prefix> <fromMs> <throughMs>');
  const files = readdirSync(directory)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.jsonl.gz'))
    .sort()
    .map((name) => join(directory, name));
  auditCaptureReadiness(files, Number(from), Number(through)).then(
    (report) => {
      if (!process.argv.includes('--summary')) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }
      const buckets = report.buckets as Record<string, Bucket>;
      const bySymbol: Record<string, Bucket> = {};
      for (const [key, bucket] of Object.entries(buckets)) {
        const symbol = key.split(':')[0];
        const sum = (bySymbol[symbol] ??= {
          observations: 0,
          phase: {},
          reasons: {},
          inputInvalidReasons: {},
          sideReasons: {},
          acceptedEpisodeIds: [],
        });
        sum.observations += bucket.observations;
        for (const field of ['phase', 'reasons', 'inputInvalidReasons', 'sideReasons'] as const)
          for (const [reason, n] of Object.entries(bucket[field]))
            sum[field][reason] = (sum[field][reason] ?? 0) + n;
        sum.acceptedEpisodeIds = [
          ...new Set([...sum.acceptedEpisodeIds, ...bucket.acceptedEpisodeIds]),
        ];
      }
      console.log(
        JSON.stringify(
          {
            totals: report.totals,
            reasons: report.reasons,
            bySymbol,
            malformed: report.malformed,
            sourceCount: (report.sources as unknown[]).length,
          },
          null,
          2,
        ),
      );
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    },
  );
}
