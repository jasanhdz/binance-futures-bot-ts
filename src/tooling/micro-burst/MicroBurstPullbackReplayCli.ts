import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { MicroBurstPullbackCandidate, PULLBACK_EXPERIMENT_V1 } from './MicroBurstPullbackCandidate';
import {
  openVerifiedCaptureSession,
  readVerifiedDecisionRecords,
} from './MicroBurstCaptureSession';

interface PullbackReplayRequestV2 {
  schema: 'MICRO_PULLBACK_ARCHIVE_REPLAY_REQUEST_V2';
  captureRoot: string;
  fromMs: number;
  throughMs: number;
  outputPath: string;
}

/** Re-evaluates captured decisions only after session, code, config and archive verification. */
export async function runPullbackReplay(requestPath: string): Promise<Record<string, unknown>> {
  const request = JSON.parse(readFileSync(requestPath, 'utf8')) as PullbackReplayRequestV2;
  if (
    request.schema !== 'MICRO_PULLBACK_ARCHIVE_REPLAY_REQUEST_V2' ||
    ![request.fromMs, request.throughMs].every(Number.isFinite) ||
    request.throughMs <= request.fromMs ||
    request.throughMs - request.fromMs > 10 * 60_000
  )
    throw new Error('INVALID_OR_UNBOUNDED_PULLBACK_REPLAY_REQUEST');
  const session = await openVerifiedCaptureSession(request.captureRoot);
  if (request.fromMs < session.startedAtMs || request.throughMs > session.completedAtMs)
    throw new Error('PULLBACK_REPLAY_RANGE_OUTSIDE_VERIFIED_SESSION');
  const records = await readVerifiedDecisionRecords(session, request.fromMs, request.throughMs);
  if (records.length > 20_000) throw new Error('PULLBACK_REPLAY_DECISION_CAP_EXCEEDED');
  const candidates = new Map<string, MicroBurstPullbackCandidate>();
  const outputs: Record<string, unknown>[] = [];
  let configFingerprint: string | undefined;
  for (const record of records) {
    const rawReplay = record.diagnostics.strategyInputReplay as Record<string, unknown> | undefined;
    const replayConfig = rawReplay?.config;
    const fingerprint = createHash('sha256').update(JSON.stringify(replayConfig)).digest('hex');
    if (configFingerprint && configFingerprint !== fingerprint)
      throw new Error('MIXED_CONFIG_REPLAY_REQUIRES_SEPARATE_RUNS');
    configFingerprint = fingerprint;
    const candidate = candidates.get(record.symbol) ?? new MicroBurstPullbackCandidate();
    candidates.set(record.symbol, candidate);
    const observation = await candidate.evaluate(session, record);
    outputs.push({
      schema: 'MICRO_PULLBACK_ARCHIVE_DECISION_OUTPUT_V2',
      decisionId: record.decisionId,
      sourceArtifactHash: session.artifactHash,
      sessionManifestSha256: session.manifestSha256,
      inputConfigHash: record.strategy.configHash,
      experiment: PULLBACK_EXPERIMENT_V1,
      observation,
    });
  }
  const report = {
    authority: 'ARCHIVE_VERIFIED_SELECTION_REPLAY_ONLY',
    sourceArtifactHash: session.artifactHash,
    sessionManifestSha256: session.manifestSha256,
    captureStartMs: session.startedAtMs,
    captureEndMs: session.completedAtMs,
    requestedFromMs: request.fromMs,
    requestedThroughMs: request.throughMs,
    decisionsRead: records.length,
    baselineEntries: records.filter((record) => record.decision === 'ENTRY_INTENT').length,
    candidateQualified: outputs.filter(
      (row) => (row.observation as { candidate?: unknown }).candidate === 'QUALIFIED',
    ).length,
    executionOrEconomicResult: 'NOT_PRODUCED_BY_SELECTION_REPLAY',
    outputs,
  };
  const outputPath = resolve(request.outputPath);
  const captureRoot = resolve(session.root, 'capture');
  const outputRelative = relative(captureRoot, outputPath);
  if (
    outputRelative === '' ||
    (!isAbsolute(outputRelative) &&
      outputRelative !== '..' &&
      !outputRelative.startsWith(`..${sep}`))
  )
    throw new Error('PULLBACK_REPORT_MUST_NOT_MODIFY_CAPTURE_ARTIFACT');
  const bytes = JSON.stringify(report, null, 2);
  writeFileSync(outputPath, bytes, { flag: 'wx', mode: 0o600 });
  return {
    ...report,
    outputs: undefined,
    outputPath,
    outputSha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 1)
    throw new Error('USAGE: MicroBurstPullbackReplayCli <archive-replay-request-v2.json>');
  runPullbackReplay(args[0]).then(
    (report) => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`),
    (error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : 'PULLBACK_REPLAY_FAILED'}\n`,
      );
      process.exitCode = 1;
    },
  );
}
