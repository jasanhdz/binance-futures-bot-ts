import {
  createReadStream,
  lstatSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { createGunzip } from 'node:zlib';
import { createInterface } from 'node:readline';
import Database from 'better-sqlite3';
import {
  hashTree,
  isVerifiedFrozenCollectorArtifact,
  verifyFrozenCollectorArtifact,
  type VerifiedFrozenCollectorArtifact,
} from './MicroBurstCollectorFreeze';
import {
  causalTradeEvidence,
  replayCausalDepth,
  readVerifiedSegments,
  type ArchiveEvent,
  type ArchiveSegment,
  type CausalDepthReplay,
  type DepthKnowledgeBounds,
  type RestDepthSnapshotAnchor,
  replayCausalDepthFromRestSnapshot,
} from './MicroBurstCausalArchive';
import type { PullbackEvidence } from './MicroBurstPullbackCandidate';
import {
  MICRO_PAIRED_REPLAY_EVIDENCE_CONTRACT_SHA256,
  MICRO_PAIRED_REPLAY_EVIDENCE_CONTRACT_V1,
} from './MicroBurstReplayEvidenceContract';
import type { MicroBurstExitContext } from '../../strategies/micro-burst/domain/MicroBurstTypes';
import {
  reconcileMicroBurstCaptureCounters,
  type CaptureCounterReconciliation,
} from './MicroBurstCaptureCounters';
import {
  assertStrategyDecisionEvidenceV2,
  type StrategyDecisionEvidenceV2,
} from '../../core/blackbox/StrategyDecisionBlackBox';

export interface CaptureSessionSegment extends Omit<ArchiveSegment, 'filePath'> {
  readonly relativePath: string;
  readonly type: 'trades' | 'depth';
  readonly symbol: string;
  readonly firstEventTimeMs: number;
  readonly lastEventTimeMs: number;
}

export interface CaptureSessionGap {
  readonly symbol: string;
  readonly fromMs: number;
  readonly throughMs: number;
  readonly kind: string;
  readonly feed: string | null;
  readonly reason: string;
}

interface CaptureSessionBody {
  readonly schema: 'MICRO_BURST_CAPTURE_SESSION_V1';
  readonly producerArtifactHash: string;
  readonly producerCommit: string;
  readonly configHash: string;
  readonly startedAtMs: number;
  readonly completedAtMs: number;
  readonly captureComplete: boolean;
  readonly blockers: readonly string[];
  readonly segments: readonly CaptureSessionSegment[];
  readonly gaps: readonly CaptureSessionGap[];
  readonly decisionFiles: readonly { relativePath: string; sha256: string; bytes: number }[];
  readonly databaseSha256: string;
  readonly healthSha256: string;
  readonly completionSha256: string;
  readonly decisionRecordCount: number;
  readonly counterReconciliation: CaptureCounterReconciliation;
}

export interface CaptureSessionManifest extends CaptureSessionBody {
  readonly manifestSha256: string;
  readonly decisionRecordCount: number;
}

export interface CaptureSessionBuildInput {
  readonly collectorRoot: string;
  readonly captureRoot: string;
  readonly producer: VerifiedFrozenCollectorArtifact;
  readonly configHash: string;
  readonly startedAtMs: number;
  readonly completedAtMs: number;
  readonly shutdownFailures: readonly string[];
  readonly auxiliaryWriteFailures: number;
}

export interface VerifiedCaptureSession {
  readonly root: string;
  readonly captureRoot: string;
  readonly artifactHash: string;
  readonly producerCommit: string;
  readonly configHash: string;
  readonly startedAtMs: number;
  readonly completedAtMs: number;
  readonly manifestSha256: string;
  readonly segments: readonly CaptureSessionSegment[];
  readonly gaps: readonly CaptureSessionGap[];
  readonly decisionFiles: CaptureSessionManifest['decisionFiles'];
}

export interface VerifiedDecisionIndexEntry {
  readonly symbol: string;
  readonly evaluatedAtReceivedMs: number;
  readonly canonicalSha256: string;
  readonly strategyConfigHash: string;
  readonly codeCommitSha: string;
}

export interface VerifiedExecutionBook {
  readonly decisionId: string;
  readonly symbol: string;
  readonly decisionInputSha256: string;
  readonly exchangeAsOfMs: number;
  readonly receivedAsOfMs: number;
  readonly maxAgeMs: number;
  readonly evidenceContractSha256: string;
  readonly observedAtMs: number;
  readonly bidDepth: readonly { price: number; qty: number }[];
  readonly askDepth: readonly { price: number; qty: number }[];
  readonly lastUpdateId: number;
  readonly checkpointAtMs: number;
  readonly checkpointPersistedAtMs: number;
  readonly checkpointSource: 'SQLITE_DEPTH_CHECKPOINT' | 'PUBLIC_REST_DEPTH_SNAPSHOT';
  readonly checkpointEvidenceSha256: string;
  readonly knownDepthBounds: DepthKnowledgeBounds;
  readonly exchangeLowerBoundMs: number | null;
  readonly depthEventCount: number;
  readonly sessionManifestSha256: string;
  readonly evidenceSha256: string;
}

export type VerifiedExecutionBookAssessment =
  | { readonly status: 'VERIFIED'; readonly book: VerifiedExecutionBook }
  | { readonly status: 'UNKNOWN'; readonly reason: string };

export interface VerifiedIntervalCoverage {
  readonly fromDecisionId: string;
  readonly fromDecisionInputSha256: string;
  readonly decisionId: string;
  readonly symbol: string;
  readonly fromExchangeAsOfMs: number;
  readonly throughExchangeAsOfMs: number;
  readonly fromReceivedAtMs: number;
  readonly throughReceivedAtMs: number;
  readonly sessionManifestSha256: string;
  readonly sourceArtifactHash: string;
  readonly tradeEvidenceSha256: string;
  readonly depthEvidenceSha256: string;
  readonly checkpointAtMs: number;
  readonly checkpointPersistedAtMs: number;
  readonly checkpointSource: 'SQLITE_DEPTH_CHECKPOINT' | 'PUBLIC_REST_DEPTH_SNAPSHOT';
  readonly checkpointEvidenceSha256: string;
  readonly fromBookEvidenceSha256: string;
  readonly depthFirstUpdateId: number;
  readonly depthLastUpdateId: number;
  readonly depthEventCount: number;
  readonly evidenceContractSha256: string;
  readonly evidenceSha256: string;
}

export interface VerifiedFundingEvidence {
  readonly symbol: string;
  readonly sessionManifestSha256: string;
  readonly fromMs: number;
  readonly throughMs: number;
  readonly source: string;
  readonly evidenceSha256: string;
  readonly events: readonly {
    eventAtMs: number;
    fundingRate: number;
    markPrice: number;
    markObservedAtMs: number;
  }[];
}

const verifiedSessions = new WeakSet<object>();
const verifiedTradeEvidence = new WeakSet<object>();
const verifiedExecutionBooks = new WeakSet<object>();
const verifiedIntervals = new WeakSet<object>();
const verifiedFundingEvidence = new WeakSet<object>();
const verifiedDecisionRecords = new WeakSet<object>();
const sessionDepthSegmentStats = new WeakMap<
  VerifiedCaptureSession,
  ReadonlyMap<string, DepthSegmentStats>
>();
const sessionDecisionIndexes = new WeakMap<
  VerifiedCaptureSession,
  ReadonlyMap<string, VerifiedDecisionIndexEntry>
>();
const sessionRestDepthSnapshotIndexes = new WeakMap<
  VerifiedCaptureSession,
  Promise<ReadonlyMap<string, RestDepthSnapshotAnchor>>
>();
const sessionSnapshotReplayDepthEvents = new WeakMap<
  VerifiedCaptureSession,
  Promise<ReadonlyMap<string, readonly ArchiveEvent[]> | null>
>();
interface DepthSegmentStats {
  readonly minEventTimeMs: number;
  readonly maxEventTimeMs: number;
  readonly minReceivedAtMs: number;
  readonly maxReceivedAtMs: number;
}

const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item) => {
    if (item && typeof item === 'object' && !Array.isArray(item))
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, item[key]]),
      );
    return item;
  });

export function isVerifiedCaptureSession(value: unknown): value is VerifiedCaptureSession {
  return Boolean(value && typeof value === 'object' && verifiedSessions.has(value));
}

export function isVerifiedTradeEvidence(value: unknown): value is PullbackEvidence {
  return Boolean(value && typeof value === 'object' && verifiedTradeEvidence.has(value));
}

export function isVerifiedExecutionBook(value: unknown): value is VerifiedExecutionBook {
  return Boolean(value && typeof value === 'object' && verifiedExecutionBooks.has(value));
}

export function isVerifiedIntervalCoverage(value: unknown): value is VerifiedIntervalCoverage {
  return Boolean(value && typeof value === 'object' && verifiedIntervals.has(value));
}

export function isVerifiedFundingEvidence(value: unknown): value is VerifiedFundingEvidence {
  return Boolean(value && typeof value === 'object' && verifiedFundingEvidence.has(value));
}

export function isVerifiedDecisionRecord(value: unknown): value is StrategyDecisionEvidenceV2 {
  return Boolean(value && typeof value === 'object' && verifiedDecisionRecords.has(value));
}

/** Build a session manifest from a closed runtime, its SQLite index and writer health. */
export async function writeCaptureSessionManifest(
  input: CaptureSessionBuildInput,
): Promise<CaptureSessionManifest> {
  const collectorRoot = resolve(input.collectorRoot);
  const captureRoot = resolve(input.captureRoot);
  if (!isVerifiedFrozenCollectorArtifact(input.producer) || input.producer.root !== collectorRoot)
    throw new Error('CAPTURE_SESSION_PRODUCER_NOT_VERIFIED');
  if (!isWithin(collectorRoot, captureRoot)) throw new Error('CAPTURE_ROOT_OUTSIDE_COLLECTOR');
  if (
    ![input.startedAtMs, input.completedAtMs, input.auxiliaryWriteFailures].every(
      Number.isFinite,
    ) ||
    input.completedAtMs < input.startedAtMs
  )
    throw new Error('INVALID_CAPTURE_SESSION_CLOCK');
  const health = readJson(join(collectorRoot, 'health.json')) as Record<string, any>;
  const completion = readJson(join(collectorRoot, 'completion.json')) as Record<string, any>;
  const effectiveConfig = readJson(join(collectorRoot, 'effective-config.json'));
  const configHash = sha256(JSON.stringify(effectiveConfig));
  if (
    !effectiveConfig ||
    (effectiveConfig as Record<string, unknown>).schema !==
      'MICRO_OBSERVATIONAL_CAPTURE_CONFIG_V1' ||
    configHash !== input.configHash ||
    health.configHash !== input.configHash
  )
    throw new Error('EFFECTIVE_CAPTURE_CONFIG_HASH_MISMATCH');
  const dbPath = join(captureRoot, 'research.sqlite');
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  let segments: CaptureSessionSegment[];
  let gaps: CaptureSessionGap[];
  try {
    const rows = db
      .prepare(
        `SELECT file_path, data_type, symbol, record_count, first_event_time_ms,
                last_event_time_ms, checksum
         FROM market_data_segments ORDER BY data_type, symbol, first_event_time_ms, file_path`,
      )
      .all() as Array<{
      file_path: string;
      data_type: string;
      symbol: string;
      record_count: number;
      first_event_time_ms: number;
      last_event_time_ms: number;
      checksum: string;
    }>;
    segments = rows.map((row) => {
      if (row.data_type !== 'trades' && row.data_type !== 'depth')
        throw new Error('CAPTURE_INDEX_UNKNOWN_SEGMENT_TYPE');
      const filePath = resolve(row.file_path);
      if (!isWithin(captureRoot, filePath)) throw new Error('CAPTURE_INDEX_PATH_OUTSIDE_ROOT');
      return {
        relativePath: relative(collectorRoot, filePath),
        checksum: row.checksum,
        recordCount: row.record_count,
        type: row.data_type,
        symbol: row.symbol,
        firstEventTimeMs: row.first_event_time_ms,
        lastEventTimeMs: row.last_event_time_ms,
      };
    });
    const gapRows = db
      .prepare(
        `SELECT symbol, started_at_ms, ended_at_ms, gap_kind, feed, reason
         FROM market_data_gaps ORDER BY symbol, started_at_ms, ended_at_ms, id`,
      )
      .all() as Array<{
      symbol: string;
      started_at_ms: number;
      ended_at_ms: number;
      gap_kind: string;
      feed: string | null;
      reason: string;
    }>;
    gaps = gapRows.map((gap) => ({
      symbol: gap.symbol,
      fromMs: gap.started_at_ms,
      throughMs: gap.ended_at_ms,
      kind: gap.gap_kind,
      feed: gap.feed,
      reason: gap.reason,
    }));
  } finally {
    db.close();
  }
  const runtime = health.runtime ?? {};
  const counterReconciliation = reconcileMicroBurstCaptureCounters(health);
  const writerStates = [
    health.decisionWriter,
    health.restWriter,
    health.eventWriter,
    health.snapshotWriter,
  ].filter(Boolean);
  const blockers = [...input.shutdownFailures, ...counterReconciliation.blockers];
  if (health.startedAtMs !== input.startedAtMs) blockers.push('CAPTURE_START_CLOCK_MISMATCH');
  if (completion.completedAtMs !== input.completedAtMs) blockers.push('CAPTURE_END_CLOCK_MISMATCH');
  if (writerStates.length !== 4) blockers.push('CAPTURE_WRITER_HEALTH_MISSING');
  if (input.auxiliaryWriteFailures !== 0) blockers.push('AUXILIARY_WRITES_FAILED');
  if (completion.failed === true) blockers.push('COLLECTOR_COMPLETION_FAILED');
  if (completion.episodeCapture?.failed === true) blockers.push('EPISODE_CAPTURE_FAILED');
  if ((completion.episodeCapture?.pendingWrites ?? 0) !== 0)
    blockers.push('EPISODE_CAPTURE_PENDING_WRITES');
  if (health.liveExecution !== false) blockers.push('LIVE_EXECUTION_NOT_FALSE');
  if (runtime.paperTradingEnabled !== false) blockers.push('PAPER_TRADING_NOT_DISABLED');
  if ((runtime.paperTrading?.openPositions ?? -1) !== 0)
    blockers.push('PAPER_POSITION_OPENED_DURING_CAPTURE');
  if ((runtime.mutationAttempts ?? 0) !== 0 || (runtime.forwardedMutations ?? 0) !== 0)
    blockers.push('MUTATION_AUDIT_NONZERO');
  if (runtime.marketArchiveHealthy !== true) blockers.push('MARKET_ARCHIVE_UNHEALTHY');
  if ((runtime.archiveQueueDepth ?? -1) !== 0) blockers.push('ARCHIVE_QUEUE_NOT_DRAINED');
  if ((runtime.archiveOverflowRecords ?? -1) !== 0) blockers.push('ARCHIVE_OVERFLOW');
  if ((runtime.storageErrors ?? -1) !== 0) blockers.push('STORAGE_ERRORS');
  if (runtime.uncleanDeferredWriteMarker !== false) blockers.push('UNCLEAN_RAW_WRITE_MARKER');
  if (runtime.uncleanDeferredWriteMarker !== false) blockers.push('UNCLEAN_RAW_WRITE_MARKER');
  if (writerStates.length !== 4) blockers.push('CAPTURE_WRITER_HEALTH_MISSING');
  for (const writer of writerStates) {
    if ((writer.pendingWrites ?? -1) !== 0) blockers.push('JSONL_WRITER_PENDING');
    if ((writer.writeFailures ?? -1) !== 0) blockers.push('JSONL_WRITER_FAILED');
    if ((writer.overloadRejected ?? -1) !== 0) blockers.push('JSONL_WRITER_OVERLOADED');
  }
  const files = collectCaptureFiles(captureRoot);
  const indexedFiles = new Set(
    segments.map((segment) => resolve(collectorRoot, segment.relativePath)),
  );
  const actualSegments = files.filter((file) => file.endsWith('.ndjson.gz'));
  const activeOrTemporary = files.filter(
    (file) => file.endsWith('.active.ndjson') || file.endsWith('.tmp'),
  );
  if (activeOrTemporary.length) blockers.push('ACTIVE_OR_TEMPORARY_ARCHIVE_FILES');
  if (
    actualSegments.length !== indexedFiles.size ||
    actualSegments.some((file) => !indexedFiles.has(file))
  )
    blockers.push('ARCHIVE_INDEX_FILE_SET_MISMATCH');
  const decisionFiles = await Promise.all(
    files.filter(isDecisionEvidenceFile).map(async (file) => ({
      relativePath: relative(collectorRoot, file),
      sha256: await hashStableFile(file),
      bytes: statSync(file).size,
    })),
  );
  const decisionRecordCount = await countDecisionEvidenceRows(collectorRoot, decisionFiles);
  if (decisionRecordCount !== counterReconciliation.decisionWriter.recordsWritten)
    blockers.push('DECISION_FILE_WRITER_COUNT_MISMATCH');
  const databaseSha256 = await hashStableFile(dbPath);
  const healthSha256 = await hashStableFile(join(collectorRoot, 'health.json'));
  const completionSha256 = await hashStableFile(join(collectorRoot, 'completion.json'));
  if (
    canonical(health.counterReconciliation) !== canonical(counterReconciliation) ||
    canonical(completion.counterReconciliation) !== canonical(counterReconciliation) ||
    completion.finalHealthSha256 !== healthSha256
  )
    blockers.push('COMPLETION_COUNTER_OR_FINAL_HEALTH_MISMATCH');
  const body: CaptureSessionBody = {
    schema: 'MICRO_BURST_CAPTURE_SESSION_V1',
    producerArtifactHash: input.producer.artifactHash,
    producerCommit: input.producer.gitCommit,
    configHash,
    startedAtMs: input.startedAtMs,
    completedAtMs: input.completedAtMs,
    captureComplete: blockers.length === 0 && completion.failed !== true,
    blockers: [...new Set(blockers)].sort(),
    segments,
    gaps,
    decisionFiles,
    databaseSha256,
    healthSha256,
    completionSha256,
    decisionRecordCount,
    counterReconciliation,
  };
  const session = { ...body, manifestSha256: sha256(canonical(body)) };
  writeFileSync(join(collectorRoot, 'capture-session.json'), JSON.stringify(session, null, 2), {
    flag: 'wx',
    mode: 0o600,
  });
  return session;
}

/** Opens only finalized, hash-checked sessions. Existing V1 captures remain untouched and unverified. */
export async function openVerifiedCaptureSession(root: string): Promise<VerifiedCaptureSession> {
  const collectorRoot = resolve(root);
  const producer = verifyFrozenCollectorArtifact(collectorRoot);
  const session = readJson(join(collectorRoot, 'capture-session.json')) as CaptureSessionManifest;
  const { manifestSha256, ...body } = session;
  if (
    session.schema !== 'MICRO_BURST_CAPTURE_SESSION_V1' ||
    sha256(canonical(body)) !== manifestSha256 ||
    session.captureComplete !== true ||
    session.blockers.length > 0 ||
    session.producerArtifactHash !== producer.artifactHash ||
    session.producerCommit !== producer.gitCommit
  )
    throw new Error('CAPTURE_SESSION_NOT_CERTIFIED');
  const health = readJson(join(collectorRoot, 'health.json')) as Record<string, any>;
  const completion = readJson(join(collectorRoot, 'completion.json')) as Record<string, any>;
  const effectiveConfig = readJson(join(collectorRoot, 'effective-config.json'));
  const healthSha256 = await hashStableFile(join(collectorRoot, 'health.json'));
  const completionSha256 = await hashStableFile(join(collectorRoot, 'completion.json'));
  const counterReconciliation = reconcileMicroBurstCaptureCounters(health);
  if (healthSha256 !== session.healthSha256)
    throw new Error('CAPTURE_SESSION_HEALTH_HASH_MISMATCH');
  if (completionSha256 !== session.completionSha256)
    throw new Error('CAPTURE_SESSION_COMPLETION_HASH_MISMATCH');
  if (
    (effectiveConfig as Record<string, unknown>)?.schema !==
      'MICRO_OBSERVATIONAL_CAPTURE_CONFIG_V1' ||
    sha256(JSON.stringify(effectiveConfig)) !== session.configHash ||
    health.configHash !== session.configHash ||
    health.sourceArtifactHash !== producer.artifactHash ||
    health.startedAtMs !== session.startedAtMs ||
    health.atMs > session.completedAtMs ||
    health.liveExecution !== false ||
    completion.completedAtMs !== session.completedAtMs ||
    completion.lifecycle !== 'SESSION_ENDED_NOT_AUTOMATICALLY_EPISODE_COMPLETE' ||
    completion.failed === true ||
    completion.finalHealthSha256 !== healthSha256 ||
    canonical(health.counterReconciliation) !== canonical(counterReconciliation) ||
    canonical(completion.counterReconciliation) !== canonical(counterReconciliation) ||
    canonical(session.counterReconciliation) !== canonical(counterReconciliation) ||
    counterReconciliation.blockers.length > 0 ||
    session.decisionRecordCount !== counterReconciliation.decisionWriter.recordsWritten ||
    completion.episodeCapture?.failed === true ||
    (completion.episodeCapture?.pendingWrites ?? 0) !== 0 ||
    completion.mutationAttempts !== 0 ||
    completion.forwardedMutations !== 0 ||
    completion.auxiliaryWriteFailures !== 0 ||
    runtimeStorageHealthy(health) !== true
  )
    throw new Error('CAPTURE_SESSION_RUNTIME_PROVENANCE_MISMATCH');
  const captureRoot = join(collectorRoot, 'capture');
  const databasePath = join(captureRoot, 'research.sqlite');
  if ((await hashStableFile(databasePath)) !== session.databaseSha256)
    throw new Error('CAPTURE_SESSION_DATABASE_HASH_MISMATCH');
  const db = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const indexed = db
      .prepare(
        `SELECT file_path, data_type, symbol, record_count, first_event_time_ms,
                last_event_time_ms, checksum
         FROM market_data_segments ORDER BY data_type, symbol, first_event_time_ms, file_path`,
      )
      .all() as Array<Record<string, unknown>>;
    const expected = session.segments.map((segment) => ({
      file_path: resolve(collectorRoot, segment.relativePath),
      data_type: segment.type,
      symbol: segment.symbol,
      record_count: segment.recordCount,
      first_event_time_ms: segment.firstEventTimeMs,
      last_event_time_ms: segment.lastEventTimeMs,
      checksum: segment.checksum,
    }));
    const normalizedIndexed = indexed.map((row) => ({
      file_path: resolve(String(row.file_path)),
      data_type: row.data_type,
      symbol: row.symbol,
      record_count: row.record_count,
      first_event_time_ms: row.first_event_time_ms,
      last_event_time_ms: row.last_event_time_ms,
      checksum: row.checksum,
    }));
    if (canonical(normalizedIndexed) !== canonical(expected))
      throw new Error('CAPTURE_SESSION_SQLITE_INDEX_MISMATCH');
    const indexedGaps = db
      .prepare(
        `SELECT symbol, started_at_ms, ended_at_ms, gap_kind, feed, reason
         FROM market_data_gaps ORDER BY symbol, started_at_ms, ended_at_ms, id`,
      )
      .all() as Array<{
      symbol: string;
      started_at_ms: number;
      ended_at_ms: number;
      gap_kind: string;
      feed: string | null;
      reason: string;
    }>;
    const normalizedGaps = indexedGaps.map((gap) => ({
      symbol: gap.symbol,
      fromMs: gap.started_at_ms,
      throughMs: gap.ended_at_ms,
      kind: gap.gap_kind,
      feed: gap.feed,
      reason: gap.reason,
    }));
    if (canonical(normalizedGaps) !== canonical(session.gaps))
      throw new Error('CAPTURE_SESSION_GAP_INDEX_MISMATCH');
  } finally {
    db.close();
  }
  const captureFiles = collectCaptureFiles(captureRoot);
  const indexedPaths = new Set(
    session.segments.map((segment) => resolve(collectorRoot, segment.relativePath)),
  );
  const actualSegments = captureFiles.filter((file) => file.endsWith('.ndjson.gz'));
  if (
    actualSegments.length !== indexedPaths.size ||
    actualSegments.some((file) => !indexedPaths.has(file)) ||
    captureFiles.some((file) => file.endsWith('.active.ndjson') || file.endsWith('.tmp'))
  )
    throw new Error('CAPTURE_SESSION_ARCHIVE_FILE_SET_MISMATCH');
  const verifiedDepthStats = new Map<string, DepthSegmentStats>();
  for (const segment of session.segments) {
    const stats = await verifyArchiveSegment({
      filePath: resolve(collectorRoot, segment.relativePath),
      checksum: segment.checksum,
      recordCount: segment.recordCount,
      expectedType: segment.type,
      expectedSymbol: segment.symbol,
      expectedFirstEventTimeMs: segment.firstEventTimeMs,
      expectedLastEventTimeMs: segment.lastEventTimeMs,
    });
    if (segment.type === 'depth') verifiedDepthStats.set(segment.relativePath, stats);
  }
  const capturedDecisionFiles = collectCaptureFiles(captureRoot).filter(isDecisionEvidenceFile);
  const declaredDecisionFiles = new Set(
    session.decisionFiles.map((source) => resolve(collectorRoot, source.relativePath)),
  );
  if (
    capturedDecisionFiles.length !== declaredDecisionFiles.size ||
    capturedDecisionFiles.some((file) => !declaredDecisionFiles.has(file))
  )
    throw new Error('CAPTURE_SESSION_DECISION_FILE_SET_MISMATCH');
  for (const source of session.decisionFiles) {
    const file = resolve(collectorRoot, source.relativePath);
    if (!isWithin(collectorRoot, file) || (await hashStableFile(file)) !== source.sha256)
      throw new Error('CAPTURE_SESSION_DECISION_SOURCE_HASH_MISMATCH');
  }
  const verified: VerifiedCaptureSession = Object.freeze({
    root: collectorRoot,
    captureRoot,
    artifactHash: producer.artifactHash,
    producerCommit: producer.gitCommit,
    configHash: session.configHash,
    startedAtMs: session.startedAtMs,
    completedAtMs: session.completedAtMs,
    manifestSha256,
    decisionRecordCount: session.decisionRecordCount,
    segments: session.segments,
    gaps: session.gaps,
    decisionFiles: session.decisionFiles,
  });
  verifiedSessions.add(verified);
  sessionDepthSegmentStats.set(verified, verifiedDepthStats);
  const decisionIndex = await buildDecisionIndex(verified);
  if (
    decisionIndex.recordCount !== session.decisionRecordCount ||
    decisionIndex.recordCount !== health.decisionWriter?.recordsWritten
  )
    throw new Error('CAPTURE_DECISION_RECORD_COUNT_MISMATCH');
  sessionDecisionIndexes.set(verified, decisionIndex.index);
  return verified;
}

export async function readVerifiedDecisionRecords(
  session: VerifiedCaptureSession,
  fromMs = session.startedAtMs,
  throughMs = session.completedAtMs,
  maxRecords = Number.POSITIVE_INFINITY,
): Promise<StrategyDecisionEvidenceV2[]> {
  assertVerifiedSession(session);
  if (
    !Number.isFinite(fromMs) ||
    !Number.isFinite(throughMs) ||
    throughMs < fromMs ||
    (!(maxRecords === Number.POSITIVE_INFINITY) &&
      (!Number.isSafeInteger(maxRecords) || maxRecords <= 0))
  )
    throw new Error('INVALID_DECISION_READ_RANGE');
  const rows = new Map<string, StrategyDecisionEvidenceV2>();
  for (const source of session.decisionFiles) {
    const file = resolve(session.root, source.relativePath);
    const names = source.relativePath.split(/[\\/]/);
    const name = names[names.length - 1] ?? '';
    if (!/^decisions(?:\..+)?\.jsonl(?:\.gz)?$/.test(name) || name.includes('.timing.')) continue;
    if ((await hashStableFile(file)) !== source.sha256)
      throw new Error('DECISION_FILE_HASH_MISMATCH');
    const stream = createReadStream(file);
    const input = file.endsWith('.gz') ? stream.pipe(createGunzip()) : stream;
    const reader = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of reader) {
        if (!line.trim()) continue;
        const record = JSON.parse(line) as StrategyDecisionEvidenceV2;
        assertStrategyDecisionEvidenceV2(record);
        if (
          record.strategy.strategyId !== 'MICRO_BURST' ||
          record.evaluatedAtReceivedMs < fromMs ||
          record.evaluatedAtReceivedMs > throughMs
        )
          continue;
        const index = sessionDecisionIndexes.get(session)?.get(record.decisionId);
        if (
          !index ||
          index.symbol !== record.symbol ||
          index.canonicalSha256 !== sha256(canonical(record))
        )
          throw new Error(`CAPTURED_DECISION_INDEX_MISMATCH:${record.decisionId}`);
        const previous = rows.get(record.decisionId);
        if (previous && canonical(previous) !== canonical(record))
          throw new Error(`CONFLICTING_CAPTURED_DECISION:${record.decisionId}`);
        if (!previous && rows.size >= maxRecords)
          throw new Error('DECISION_READ_RECORD_CAP_EXCEEDED');
        const frozen = deepFreeze(record);
        verifiedDecisionRecords.add(frozen);
        rows.set(record.decisionId, frozen);
      }
    } finally {
      reader.close();
    }
  }
  return [...rows.values()].sort(
    (a, b) =>
      a.evaluatedAtReceivedMs - b.evaluatedAtReceivedMs || a.decisionId.localeCompare(b.decisionId),
  );
}

export interface VerifiedEpisodeCaptureEvent {
  readonly sequence: number;
  readonly previousHash: string;
  readonly record: Record<string, unknown>;
}

export async function readVerifiedEpisodeCapture(
  session: VerifiedCaptureSession,
): Promise<VerifiedEpisodeCaptureEvent[]> {
  assertVerifiedSession(session);
  const file = join(session.captureRoot, 'episode-capture', 'capture.jsonl');
  const source = session.decisionFiles.find((entry) =>
    entry.relativePath.endsWith(`${join('episode-capture', 'capture.jsonl')}`),
  );
  if (!source || (await hashStableFile(file)) !== source.sha256)
    throw new Error('EPISODE_CAPTURE_HASH_MISMATCH');
  const reader = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  const events: VerifiedEpisodeCaptureEvent[] = [];
  let previousHash = 'GENESIS';
  let sequence = 0;
  try {
    for await (const line of reader) {
      if (!line.trim()) continue;
      const envelope = JSON.parse(line) as { body: string; hash: string };
      if (sha256(envelope.body) !== envelope.hash)
        throw new Error('EPISODE_CAPTURE_HASH_CHAIN_INVALID');
      const decoded = JSON.parse(envelope.body) as {
        sequence: number;
        previousHash: string;
        record: Record<string, unknown>;
      };
      if (decoded.sequence !== sequence + 1 || decoded.previousHash !== previousHash)
        throw new Error('EPISODE_CAPTURE_HASH_CHAIN_INVALID');
      sequence = decoded.sequence;
      previousHash = envelope.hash;
      events.push(decoded);
    }
  } finally {
    reader.close();
  }
  const completion = readJson(join(session.captureRoot, 'episode-capture', 'completion.json'));
  if (
    completion.sequence !== sequence ||
    completion.finalHash !== previousHash ||
    completion.failed !== false ||
    completion.droppedRecords !== 0 ||
    completion.pendingWrites !== 0
  )
    throw new Error('EPISODE_CAPTURE_COMPLETION_MISMATCH');
  return events;
}

export async function readVerifiedPullbackEvidence(
  session: VerifiedCaptureSession,
  decision: StrategyDecisionEvidenceV2,
  exchangeAsOfMs: number,
  receivedAsOfMs: number,
): Promise<PullbackEvidence> {
  assertVerifiedSession(session);
  if (!isVerifiedDecisionRecord(decision))
    throw new Error('PULLBACK_DECISION_NOT_ARCHIVE_VERIFIED');
  const decisionId = decision.decisionId;
  const symbol = decision.symbol;
  const decisionIndex = sessionDecisionIndexes.get(session)?.get(decisionId);
  if (
    !decisionIndex ||
    decisionIndex.symbol !== symbol ||
    canonical(decisionIndex.canonicalSha256) !== canonical(sha256(canonical(decision))) ||
    decision.strategy.configHash !== `sha256:${session.configHash}` ||
    decisionIndex.strategyConfigHash !== decision.strategy.configHash ||
    decisionIndex.codeCommitSha !== decision.strategy.codeCommitSha ||
    decision.strategy.codeCommitSha !== session.producerCommit ||
    decision.strategy.strategyId !== 'MICRO_BURST'
  )
    throw new Error('PULLBACK_DECISION_SESSION_IDENTITY_MISMATCH');
  if (
    !Number.isFinite(exchangeAsOfMs) ||
    exchangeAsOfMs <= 0 ||
    !Number.isFinite(receivedAsOfMs) ||
    receivedAsOfMs < session.startedAtMs ||
    receivedAsOfMs > session.completedAtMs
  )
    throw new Error('PULLBACK_DECISION_CLOCK_OUTSIDE_VERIFIED_SESSION');
  const fromMs = exchangeAsOfMs - 60_000;
  const segments = session.segments.filter(
    (segment) =>
      segment.type === 'trades' &&
      segment.symbol === symbol &&
      segment.firstEventTimeMs <= exchangeAsOfMs &&
      segment.lastEventTimeMs >= fromMs,
  );
  const preceding = session.segments
    .filter(
      (segment) =>
        segment.type === 'trades' && segment.symbol === symbol && segment.lastEventTimeMs < fromMs,
    )
    .sort((a, b) => b.lastEventTimeMs - a.lastEventTimeMs)[0];
  if (preceding) segments.push(preceding);
  const events = segments.flatMap((segment) =>
    readVerifiedSegments([
      {
        filePath: resolve(session.root, segment.relativePath),
        checksum: segment.checksum,
        recordCount: segment.recordCount,
      },
    ]),
  );
  const evidence = causalTradeEvidence(
    events,
    {
      symbol,
      // Bounds are in exchange-event time and derived from verified segment contents;
      // local session clocks are deliberately not compared with exchange time.
      fromMs: session.segments.some(
        (segment) => segment.type === 'trades' && segment.symbol === symbol,
      )
        ? Math.min(
            ...session.segments
              .filter((segment) => segment.type === 'trades' && segment.symbol === symbol)
              .map((segment) => segment.firstEventTimeMs),
          )
        : Number.NaN,
      throughMs: session.segments.some(
        (segment) => segment.type === 'trades' && segment.symbol === symbol,
      )
        ? Math.max(
            ...session.segments
              .filter((segment) => segment.type === 'trades' && segment.symbol === symbol)
              .map((segment) => segment.lastEventTimeMs),
          )
        : Number.NaN,
      gaps: session.gaps
        .filter((gap) => gap.symbol === symbol && (gap.feed === 'AGG_TRADE' || gap.feed === null))
        .map((gap) => ({ fromMs: gap.fromMs, throughMs: gap.throughMs })),
    },
    exchangeAsOfMs,
    receivedAsOfMs,
  );
  const verified = Object.freeze({
    ...evidence,
    decisionId,
    decisionInputSha256: decisionIndex.canonicalSha256,
    sourceArtifactHash: session.artifactHash,
    sessionManifestSha256: session.manifestSha256,
    verification: 'ARCHIVE_SESSION_AND_TRADE_SEQUENCE_RECHECKED' as const,
  });
  verifiedTradeEvidence.add(verified);
  return verified;
}

function replayEvidenceContractSha256(): string {
  return MICRO_PAIRED_REPLAY_EVIDENCE_CONTRACT_SHA256;
}

function replayContext(decision: StrategyDecisionEvidenceV2): {
  readonly symbol?: string;
  readonly observedAtMs?: number;
  readonly exchangeObservedAtMs?: number;
  readonly clockReference?: {
    readonly contextBuiltExchangeLowerBoundMs?: number;
    readonly contextBuiltExchangeUpperBoundMs?: number;
  };
  readonly executionBook?: {
    readonly status?: string;
    readonly observedAtMs?: number;
    readonly bidDepth?: readonly { price: number; qty: number }[];
    readonly askDepth?: readonly { price: number; qty: number }[];
  };
  readonly bookPressure?: MicroBurstExitContext['currentBookPressure'];
  readonly btcContext?: MicroBurstExitContext['currentBtcContext'] | null;
  readonly marketEvidence?: MicroBurstExitContext['marketEvidence'] | null;
} | null {
  const replay = decision.diagnostics?.strategyInputReplay as
    | { context?: Record<string, unknown> }
    | undefined;
  const context = replay?.context;
  return context ? (context as ReturnType<typeof replayContext> & {}) : null;
}

function assertVerifiedDecisionInSession(
  session: VerifiedCaptureSession,
  decision: StrategyDecisionEvidenceV2,
): VerifiedDecisionIndexEntry {
  assertVerifiedSession(session);
  if (!isVerifiedDecisionRecord(decision)) throw new Error('REPLAY_DECISION_NOT_ARCHIVE_VERIFIED');
  const entry = sessionDecisionIndexes.get(session)?.get(decision.decisionId);
  if (
    !entry ||
    entry.symbol !== decision.symbol ||
    entry.canonicalSha256 !== sha256(canonical(decision)) ||
    entry.strategyConfigHash !== decision.strategy.configHash ||
    entry.codeCommitSha !== decision.strategy.codeCommitSha ||
    decision.strategy.strategyId !== 'MICRO_BURST' ||
    decision.strategy.configHash !== `sha256:${session.configHash}` ||
    decision.strategy.codeCommitSha !== session.producerCommit
  )
    throw new Error('REPLAY_DECISION_SESSION_IDENTITY_MISMATCH');
  return entry;
}

function sameKnownBook(
  actual: {
    readonly bidDepth: readonly { price: number; qty: number }[];
    readonly askDepth: readonly { price: number; qty: number }[];
    readonly observedAtMs: number;
  },
  expected: {
    readonly status?: string;
    readonly bidDepth?: readonly { price: number; qty: number }[];
    readonly askDepth?: readonly { price: number; qty: number }[];
    readonly observedAtMs?: number;
  },
): boolean {
  const bids = expected.bidDepth;
  const asks = expected.askDepth;
  return Boolean(
    expected.status === 'HEALTHY' &&
      bids?.length &&
      asks?.length &&
      actual.observedAtMs === expected.observedAtMs &&
      canonical(actual.bidDepth.slice(0, bids.length)) === canonical(bids) &&
      canonical(actual.askDepth.slice(0, asks.length)) === canonical(asks),
  );
}

function hasSessionFeedGap(
  session: VerifiedCaptureSession,
  symbol: string,
  feed: 'DEPTH' | 'AGG_TRADE',
  fromEventTimeMs: number,
  throughEventTimeMs: number,
): boolean {
  return session.gaps.some(
    (gap) =>
      gap.symbol === symbol &&
      (gap.feed === feed || gap.feed === null) &&
      gap.fromMs <= throughEventTimeMs &&
      gap.throughMs >= fromEventTimeMs,
  );
}

async function readDepthEventsInReceiveWindow(
  session: VerifiedCaptureSession,
  symbol: string,
  fromReceivedAtMs: number,
  throughReceivedAtMs: number,
): Promise<ArchiveEvent[]> {
  const stats = sessionDepthSegmentStats.get(session);
  if (!stats) throw new Error('CAPTURE_DEPTH_SEGMENT_INDEX_UNAVAILABLE');
  const segments = session.segments.filter((segment) => {
    if (segment.type !== 'depth' || segment.symbol !== symbol) return false;
    const range = stats.get(segment.relativePath);
    return Boolean(
      range &&
        range.maxReceivedAtMs >= fromReceivedAtMs &&
        range.minReceivedAtMs <= throughReceivedAtMs,
    );
  });
  const events = segments.flatMap((segment) => {
    const rows = readVerifiedSegments([
      {
        filePath: resolve(session.root, segment.relativePath),
        checksum: segment.checksum,
        recordCount: segment.recordCount,
      },
    ]);
    if (
      rows.some(
        (event) =>
          event.type !== 'depth' ||
          event.symbol !== symbol ||
          event.eventTime < segment.firstEventTimeMs ||
          event.eventTime > segment.lastEventTimeMs,
      )
    )
      throw new Error('CAPTURE_DEPTH_SEGMENT_METADATA_MISMATCH');
    return rows.filter(
      (event) =>
        event.receivedAtMs >= fromReceivedAtMs && event.receivedAtMs <= throughReceivedAtMs,
    );
  });
  return events.sort(
    (a, b) =>
      a.receivedAtMs - b.receivedAtMs ||
      Number(a.payload.U) - Number(b.payload.U) ||
      Number(a.payload.u) - Number(b.payload.u),
  );
}

async function forEachVerifiedEvidenceJsonLine(
  session: VerifiedCaptureSession,
  basenamePattern: RegExp,
  visit: (
    record: Record<string, any>,
    source: CaptureSessionManifest['decisionFiles'][number],
  ) => void,
): Promise<void> {
  for (const source of session.decisionFiles) {
    const basename = source.relativePath.split(/[\\/]/).pop() ?? '';
    if (!basenamePattern.test(basename)) continue;
    const file = resolve(session.root, source.relativePath);
    if ((await hashStableFile(file)) !== source.sha256)
      throw new Error('CAPTURE_EVIDENCE_SOURCE_HASH_MISMATCH');
    const stream = createReadStream(file);
    const input = file.endsWith('.gz') ? stream.pipe(createGunzip()) : stream;
    const reader = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of reader) {
        if (!line.trim()) continue;
        const record = JSON.parse(line) as Record<string, any>;
        visit(record, source);
      }
    } finally {
      reader.close();
    }
    if ((await hashStableFile(file)) !== source.sha256)
      throw new Error('CAPTURE_EVIDENCE_SOURCE_CHANGED_DURING_READ');
  }
}

/** Read the session-hash-bound initial REST snapshots and their recorded sync/buffer facts. */
async function readVerifiedInitialRestDepthSnapshots(
  session: VerifiedCaptureSession,
): Promise<ReadonlyMap<string, RestDepthSnapshotAnchor>> {
  assertVerifiedSession(session);
  const cached = sessionRestDepthSnapshotIndexes.get(session);
  if (cached) return cached;
  const pending = (async () => {
    const snapshots: Array<{
      record: Record<string, any>;
      source: CaptureSessionManifest['decisionFiles'][number];
    }> = [];
    const syncLogs: Array<{
      record: Record<string, any>;
      source: CaptureSessionManifest['decisionFiles'][number];
    }> = [];
    const serverTimeSamples: Array<{
      requestStartedAtMs: number;
      responseReceivedAtMs: number;
      serverTime: number;
    }> = [];
    await forEachVerifiedEvidenceJsonLine(
      session,
      /^rest-inputs(?:\..+)?\.jsonl(?:\.gz)?$/,
      (record, source) => {
        if (record.method === 'getDepthSnapshot') snapshots.push({ record, source });
        if (record.method !== 'getServerTime') return;
        const serverTime = Number(
          record.response && typeof record.response === 'object'
            ? record.response.serverTime
            : record.response,
        );
        if ([record.requestedAtMs, record.receivedAtMs, serverTime].every(Number.isFinite))
          serverTimeSamples.push({
            requestStartedAtMs: Number(record.requestedAtMs),
            responseReceivedAtMs: Number(record.receivedAtMs),
            serverTime,
          });
      },
    );
    await forEachVerifiedEvidenceJsonLine(
      session,
      /^events(?:\..+)?\.jsonl(?:\.gz)?$/,
      (record, source) => {
        if (record.message === 'market_data_order_book_snapshot_received')
          syncLogs.push({ record, source });
      },
    );
    const output = new Map<string, RestDepthSnapshotAnchor>();
    const bySymbol = new Map<string, typeof snapshots>();
    for (const row of snapshots) {
      const symbol = row.record.args?.[0];
      if (typeof symbol !== 'string') continue;
      const values = bySymbol.get(symbol) ?? [];
      values.push(row);
      bySymbol.set(symbol, values);
    }
    for (const [symbol, candidates] of bySymbol) {
      // A second snapshot implies a resync generation; this initial-snapshot reader
      // deliberately declines to guess which websocket generation owns it.
      if (candidates.length !== 1) continue;
      const candidate = candidates[0];
      const record = candidate.record;
      const response = record.response as Record<string, any> | undefined;
      const requestLimit = Number(record.args?.[1]);
      if (
        !response ||
        requestLimit <= 0 ||
        !Number.isSafeInteger(response.lastUpdateId) ||
        response.lastUpdateId < 0 ||
        !Number.isFinite(record.requestedAtMs) ||
        !Number.isFinite(record.receivedAtMs) ||
        !Number.isFinite(response.receivedAtMs) ||
        response.receivedAtMs < session.startedAtMs ||
        record.requestedAtMs > response.receivedAtMs ||
        response.receivedAtMs > record.receivedAtMs ||
        !Array.isArray(response.bids) ||
        !Array.isArray(response.asks) ||
        !response.bids.length ||
        !response.asks.length ||
        response.bids.length > requestLimit ||
        response.asks.length > requestLimit
      )
        continue;
      const syncMatches = syncLogs.filter(({ record: log }) => {
        const context = log.context ?? {};
        return (
          context.symbol === symbol &&
          context.requestedAtMs === record.requestedAtMs &&
          context.snapshotLastUpdateId === response.lastUpdateId
        );
      });
      if (syncMatches.length !== 1) continue;
      const syncLog = syncMatches[0];
      const sync = syncLog.record.context as Record<string, any>;
      if (
        !Number.isFinite(sync.receivedAtMs) ||
        sync.receivedAtMs < response.receivedAtMs ||
        sync.receivedAtMs > session.completedAtMs ||
        record.receivedAtMs > sync.receivedAtMs ||
        sync.bufferLengthBefore !== 0 ||
        !Number.isSafeInteger(sync.bufferLengthAfter) ||
        sync.bufferLengthAfter < 0
      )
        continue;
      const overlappingServerSamples = serverTimeSamples.filter(
        (sample) =>
          sample.requestStartedAtMs <= sync.receivedAtMs &&
          sample.responseReceivedAtMs >= sync.receivedAtMs,
      );
      if (!overlappingServerSamples.length) continue;
      const exchangeLowerBoundAtSnapshot = Math.max(
        ...overlappingServerSamples.map(
          (sample) => sample.serverTime + (sync.receivedAtMs - sample.responseReceivedAtMs),
        ),
      );
      const exchangeUpperBoundAtSnapshot = Math.min(
        ...overlappingServerSamples.map(
          (sample) => sample.serverTime + (sync.receivedAtMs - sample.requestStartedAtMs),
        ),
      );
      if (
        !Number.isFinite(exchangeLowerBoundAtSnapshot) ||
        !Number.isFinite(exchangeUpperBoundAtSnapshot) ||
        exchangeLowerBoundAtSnapshot > exchangeUpperBoundAtSnapshot
      )
        continue;
      const levelArraysValid = (
        levels: readonly unknown[],
        descending: boolean,
      ): Array<{ price: number; qty: number }> | undefined => {
        const parsed: Array<{ price: number; qty: number }> = [];
        for (const raw of levels) {
          if (!Array.isArray(raw) || raw.length !== 2) return undefined;
          const price = Number(raw[0]);
          const qty = Number(raw[1]);
          if (
            !Number.isFinite(price) ||
            price <= 0 ||
            !Number.isFinite(qty) ||
            qty < 0 ||
            (parsed.length > 0 &&
              (descending
                ? parsed[parsed.length - 1].price <= price
                : parsed[parsed.length - 1].price >= price))
          )
            return undefined;
          parsed.push({ price, qty });
        }
        return parsed;
      };
      const bids = levelArraysValid(response.bids, true);
      const asks = levelArraysValid(response.asks, false);
      if (!bids || !asks || bids[0].price > asks[0].price) continue;
      const bufferedEvents = await readDepthEventsInReceiveWindow(
        session,
        symbol,
        record.requestedAtMs,
        sync.receivedAtMs,
      );
      if (bufferedEvents.length !== sync.bufferLengthAfter) continue;
      const rawEvidence = {
        schema: 'MICRO_REST_DEPTH_SNAPSHOT_ANCHOR_V1',
        sessionManifestSha256: session.manifestSha256,
        rawRestSource: {
          relativePath: candidate.source.relativePath,
          sha256: candidate.source.sha256,
        },
        eventSource: {
          relativePath: syncLog.source.relativePath,
          sha256: syncLog.source.sha256,
        },
        record,
        syncLog: syncLog.record,
        bufferedEvents,
        overlappingServerSamples,
        exchangeLowerBoundAtSnapshot,
        exchangeUpperBoundAtSnapshot,
      };
      output.set(
        symbol,
        Object.freeze({
          symbol,
          requestedAtMs: record.requestedAtMs,
          snapshotReceivedAtMs: response.receivedAtMs,
          availableAtMs: sync.receivedAtMs,
          exchangeUpperBoundAtAvailableMs: exchangeUpperBoundAtSnapshot,
          lastUpdateId: response.lastUpdateId,
          bids: Object.freeze(bids.map((level) => Object.freeze(level))),
          asks: Object.freeze(asks.map((level) => Object.freeze(level))),
          bufferLengthBefore: sync.bufferLengthBefore,
          bufferLengthAfter: sync.bufferLengthAfter,
          bufferedEvents: Object.freeze(bufferedEvents),
          evidenceSha256: sha256(canonical(rawEvidence)),
        }),
      );
    }
    return output;
  })();
  sessionRestDepthSnapshotIndexes.set(session, pending);
  return pending;
}

const MAX_SNAPSHOT_REPLAY_COMPRESSED_DEPTH_BYTES = 32 * 1024 * 1024;
const MAX_SNAPSHOT_REPLAY_DEPTH_RECORDS = 100_000;

/** Cache the compact verified depth tape only for sessions small enough for bounded offline replay. */
async function readSnapshotReplayDepthEvents(
  session: VerifiedCaptureSession,
): Promise<ReadonlyMap<string, readonly ArchiveEvent[]> | null> {
  const cached = sessionSnapshotReplayDepthEvents.get(session);
  if (cached) return cached;
  const pending = (async () => {
    const segments = session.segments.filter((segment) => segment.type === 'depth');
    const compressedBytes = segments.reduce(
      (sum, segment) => sum + statSync(resolve(session.root, segment.relativePath)).size,
      0,
    );
    const recordCount = segments.reduce((sum, segment) => sum + segment.recordCount, 0);
    if (
      compressedBytes > MAX_SNAPSHOT_REPLAY_COMPRESSED_DEPTH_BYTES ||
      recordCount > MAX_SNAPSHOT_REPLAY_DEPTH_RECORDS
    )
      return null;
    const records = readVerifiedSegments(
      segments.map((segment) => ({
        filePath: resolve(session.root, segment.relativePath),
        checksum: segment.checksum,
        recordCount: segment.recordCount,
      })),
    );
    if (records.length !== recordCount) throw new Error('CAPTURE_DEPTH_RECORD_COUNT_MISMATCH');
    const grouped = new Map<string, ArchiveEvent[]>();
    for (const record of records) {
      const events = grouped.get(record.symbol) ?? [];
      events.push(record);
      grouped.set(record.symbol, events);
    }
    for (const [symbol, events] of grouped)
      grouped.set(
        symbol,
        events.sort(
          (a, b) =>
            a.receivedAtMs - b.receivedAtMs ||
            Number(a.payload.U) - Number(b.payload.U) ||
            Number(a.payload.u) - Number(b.payload.u),
        ),
      );
    return grouped;
  })();
  sessionSnapshotReplayDepthEvents.set(session, pending);
  return pending;
}

export function assertVerifiedPullbackEvidence(value: unknown): asserts value is PullbackEvidence {
  if (!value || typeof value !== 'object' || !verifiedTradeEvidence.has(value))
    throw new Error('PULLBACK_EVIDENCE_NOT_ARCHIVE_VERIFIED');
}

function createVerifiedExecutionBook(input: {
  session: VerifiedCaptureSession;
  decision: StrategyDecisionEvidenceV2;
  context: {
    observedAtMs: number;
    exchangeObservedAtMs: number;
    clockReference?: { contextBuiltExchangeLowerBoundMs?: number };
  };
  replay: CausalDepthReplay & { status: 'VERIFIED'; book: NonNullable<CausalDepthReplay['book']> };
  checkpointAtMs: number;
  checkpointPersistedAtMs: number;
  checkpointSource: VerifiedExecutionBook['checkpointSource'];
  checkpointEvidenceSha256: string;
  depthEvidenceSha256: string;
  maxAgeMs: number;
}): VerifiedExecutionBook {
  const { session, decision, context, replay } = input;
  const decisionInputSha256 = sessionDecisionIndexes
    .get(session)!
    .get(decision.decisionId)!.canonicalSha256;
  const evidenceContractSha256 = replayEvidenceContractSha256();
  const exchangeLowerBoundMs = Number.isFinite(
    context.clockReference?.contextBuiltExchangeLowerBoundMs,
  )
    ? context.clockReference!.contextBuiltExchangeLowerBoundMs!
    : null;
  const value: VerifiedExecutionBook = Object.freeze({
    decisionId: decision.decisionId,
    symbol: decision.symbol,
    decisionInputSha256,
    exchangeAsOfMs: context.exchangeObservedAtMs,
    receivedAsOfMs: context.observedAtMs,
    maxAgeMs: input.maxAgeMs,
    evidenceContractSha256,
    observedAtMs: replay.book.observedAtMs,
    bidDepth: Object.freeze(replay.book.bidDepth.map((level) => Object.freeze({ ...level }))),
    askDepth: Object.freeze(replay.book.askDepth.map((level) => Object.freeze({ ...level }))),
    lastUpdateId: replay.book.lastUpdateId,
    checkpointAtMs: input.checkpointAtMs,
    checkpointPersistedAtMs: input.checkpointPersistedAtMs,
    checkpointSource: input.checkpointSource,
    checkpointEvidenceSha256: input.checkpointEvidenceSha256,
    knownDepthBounds: Object.freeze({ ...replay.book.knownDepthBounds }),
    exchangeLowerBoundMs,
    depthEventCount: replay.book.appliedEventCount,
    sessionManifestSha256: session.manifestSha256,
    evidenceSha256: sha256(
      canonical({
        session: session.manifestSha256,
        decisionInputSha256,
        checkpointAtMs: input.checkpointAtMs,
        checkpointPersistedAtMs: input.checkpointPersistedAtMs,
        checkpointSource: input.checkpointSource,
        checkpointEvidenceSha256: input.checkpointEvidenceSha256,
        depthEvidenceSha256: input.depthEvidenceSha256,
        clocks: {
          exchangeAsOfMs: context.exchangeObservedAtMs,
          exchangeLowerBoundMs,
          receivedAsOfMs: context.observedAtMs,
        },
        maxAgeMs: input.maxAgeMs,
        evidenceContractSha256,
      }),
    ),
  });
  verifiedExecutionBooks.add(value);
  return value;
}

/** Point book bound to the exact verified decision clocks and captured book. */
export async function readVerifiedExecutionBookForDecision(
  session: VerifiedCaptureSession,
  decision: StrategyDecisionEvidenceV2,
): Promise<VerifiedExecutionBookAssessment> {
  assertVerifiedDecisionInSession(session, decision);
  const replay = decision.diagnostics?.strategyInputReplay as
    | {
        config?: { bookFreshnessMaxMs?: number };
        context?: {
          symbol?: string;
          observedAtMs?: number;
          exchangeObservedAtMs?: number;
          clockReference?: { contextBuiltExchangeLowerBoundMs?: number };
          executionBook?: {
            status?: string;
            bidDepth?: readonly { price: number; qty: number }[];
            askDepth?: readonly { price: number; qty: number }[];
            observedAtMs?: number;
          };
        };
      }
    | undefined;
  const context = replay?.context;
  const maxAgeMs = MICRO_PAIRED_REPLAY_EVIDENCE_CONTRACT_V1.maxBookAgeMs;
  if (
    replay?.config?.bookFreshnessMaxMs !== maxAgeMs ||
    context?.symbol !== decision.symbol ||
    !Number.isFinite(context.observedAtMs) ||
    !Number.isFinite(context.exchangeObservedAtMs) ||
    context.exchangeObservedAtMs! <= 0 ||
    context.observedAtMs! < session.startedAtMs ||
    context.observedAtMs! > session.completedAtMs
  )
    return { status: 'UNKNOWN', reason: 'DECISION_BOOK_CLOCK_OR_CONTRACT_INVALID' };
  const expected = context.executionBook;
  if (
    !expected ||
    expected.status !== 'HEALTHY' ||
    !Array.isArray(expected.bidDepth) ||
    !Array.isArray(expected.askDepth) ||
    !Number.isFinite(expected.observedAtMs)
  )
    return { status: 'UNKNOWN', reason: 'DECISION_BOOK_MISSING_OR_UNHEALTHY' };

  const initialSnapshots = await readVerifiedInitialRestDepthSnapshots(session);
  const snapshotAnchor = initialSnapshots.get(decision.symbol);
  const allDepthEvents = snapshotAnchor ? await readSnapshotReplayDepthEvents(session) : null;
  const snapshotDepthEvents = allDepthEvents?.get(decision.symbol);
  let snapshotFallbackReason: string | undefined;
  if (snapshotAnchor && snapshotDepthEvents) {
    const eventsThroughDecision = snapshotDepthEvents.filter(
      (event) =>
        event.receivedAtMs >= snapshotAnchor.requestedAtMs &&
        event.receivedAtMs <= context.observedAtMs!,
    );
    const snapshotReplay = replayCausalDepthFromRestSnapshot(
      snapshotAnchor,
      eventsThroughDecision,
      {
        exchangeAsOfMs: context.exchangeObservedAtMs!,
        exchangeLowerBoundMs: Number(context.clockReference?.contextBuiltExchangeLowerBoundMs),
        receivedAsOfMs: context.observedAtMs!,
      },
      maxAgeMs,
    );
    if (snapshotReplay.status === 'VERIFIED' && snapshotReplay.book) {
      if (sameKnownBook(snapshotReplay.book, expected)) {
        const depthEvidenceSha256 = sha256(
          canonical({
            sessionManifestSha256: session.manifestSha256,
            symbol: decision.symbol,
            fromReceivedAtMs: snapshotAnchor.requestedAtMs,
            throughReceivedAtMs: context.observedAtMs,
            exchangeAsOfMs: context.exchangeObservedAtMs,
            segments: session.segments
              .filter((segment) => segment.type === 'depth' && segment.symbol === decision.symbol)
              .map((segment) => ({ path: segment.relativePath, checksum: segment.checksum })),
          }),
        );
        const value = createVerifiedExecutionBook({
          session,
          decision,
          context: context as NonNullable<typeof context> & {
            observedAtMs: number;
            exchangeObservedAtMs: number;
          },
          replay: snapshotReplay as CausalDepthReplay & {
            status: 'VERIFIED';
            book: NonNullable<CausalDepthReplay['book']>;
          },
          checkpointAtMs: snapshotAnchor.snapshotReceivedAtMs,
          checkpointPersistedAtMs: snapshotAnchor.availableAtMs,
          checkpointSource: 'PUBLIC_REST_DEPTH_SNAPSHOT',
          checkpointEvidenceSha256: snapshotAnchor.evidenceSha256,
          depthEvidenceSha256,
          maxAgeMs,
        });
        return { status: 'VERIFIED', book: value };
      }
      snapshotFallbackReason =
        snapshotReplay.book.observedAtMs < expected.observedAtMs!
          ? 'DEPTH_NO_UPDATES_OBSERVED'
          : 'DECISION_BOOK_CONTENT_MISMATCH';
    } else snapshotFallbackReason = snapshotReplay.reason ?? 'REST_SNAPSHOT_DEPTH_UNVERIFIED';
  }

  const db = new Database(join(session.captureRoot, 'research.sqlite'), {
    readonly: true,
    fileMustExist: true,
  });
  let checkpointRow:
    | { checkpoint_json: string; event_time_ms: number; created_at_ms: number }
    | undefined;
  try {
    checkpointRow = db
      .prepare(
        `SELECT checkpoint_json, event_time_ms, created_at_ms FROM book_checkpoints
          WHERE symbol=? AND event_time_ms<=? AND created_at_ms<=?
          ORDER BY event_time_ms DESC, created_at_ms DESC LIMIT 1`,
      )
      .get(decision.symbol, context.observedAtMs, context.observedAtMs) as typeof checkpointRow;
  } finally {
    db.close();
  }
  if (!checkpointRow || checkpointRow.created_at_ms > context.observedAtMs!)
    return {
      status: 'UNKNOWN',
      reason: snapshotFallbackReason ?? 'DEPTH_CHECKPOINT_MISSING_OR_NOT_YET_AVAILABLE',
    };
  const checkpoint = JSON.parse(checkpointRow.checkpoint_json) as {
    symbol?: string;
    observedAtMs?: number;
    lastUpdateId?: number;
    bids?: { price: number; qty: number }[];
    asks?: { price: number; qty: number }[];
  };
  if (
    checkpoint.symbol !== decision.symbol ||
    checkpoint.observedAtMs !== checkpointRow.event_time_ms ||
    !Number.isFinite(checkpoint.observedAtMs) ||
    !Number.isSafeInteger(checkpoint.lastUpdateId) ||
    !Array.isArray(checkpoint.bids) ||
    !Array.isArray(checkpoint.asks) ||
    checkpoint.observedAtMs! > context.observedAtMs!
  )
    return { status: 'UNKNOWN', reason: snapshotFallbackReason ?? 'DEPTH_CHECKPOINT_INVALID' };
  if (checkpointRow.created_at_ms < checkpoint.observedAtMs!)
    return {
      status: 'UNKNOWN',
      reason: snapshotFallbackReason ?? 'DEPTH_CHECKPOINT_PERSISTENCE_CLOCK_INVALID',
    };
  const depthEvents = await readDepthEventsInReceiveWindow(
    session,
    decision.symbol,
    checkpoint.observedAtMs!,
    context.observedAtMs!,
  );
  const result = replayCausalDepth(
    {
      symbol: decision.symbol,
      receivedAtMs: checkpoint.observedAtMs!,
      availableAtMs: checkpoint.observedAtMs!,
      lastUpdateId: checkpoint.lastUpdateId!,
      bids: checkpoint.bids,
      asks: checkpoint.asks,
    },
    depthEvents,
    {
      exchangeAsOfMs: context.exchangeObservedAtMs!,
      receivedAsOfMs: context.observedAtMs!,
    },
    maxAgeMs,
  );
  if (result.status !== 'VERIFIED' || !result.book)
    return {
      status: 'UNKNOWN',
      reason: snapshotFallbackReason ?? result.reason ?? 'DEPTH_BOOK_UNVERIFIED',
    };
  if (!sameKnownBook(result.book, expected))
    return {
      status: 'UNKNOWN',
      reason:
        snapshotFallbackReason ??
        (result.book.observedAtMs < expected.observedAtMs!
          ? 'DEPTH_NO_UPDATES_OBSERVED'
          : 'DECISION_BOOK_CONTENT_MISMATCH'),
    };
  const checkpointEvidenceSha256 = sha256(
    canonical({ checkpoint, checkpointPersistedAtMs: checkpointRow.created_at_ms }),
  );
  const value = createVerifiedExecutionBook({
    session,
    decision,
    context: context as NonNullable<typeof context> & {
      observedAtMs: number;
      exchangeObservedAtMs: number;
    },
    replay: result as CausalDepthReplay & {
      status: 'VERIFIED';
      book: NonNullable<CausalDepthReplay['book']>;
    },
    checkpointAtMs: checkpointRow.event_time_ms,
    checkpointPersistedAtMs: checkpointRow.created_at_ms,
    checkpointSource: 'SQLITE_DEPTH_CHECKPOINT',
    checkpointEvidenceSha256,
    depthEvidenceSha256: sha256(canonical(depthEvents)),
    maxAgeMs,
  });
  return { status: 'VERIFIED', book: value };
}

export async function verifyVerifiedDecisionInterval(
  session: VerifiedCaptureSession,
  fromDecision: StrategyDecisionEvidenceV2,
  throughDecision: StrategyDecisionEvidenceV2,
  fromBook: VerifiedExecutionBook,
  throughBook: VerifiedExecutionBook,
): Promise<
  | { readonly status: 'VERIFIED'; readonly evidence: VerifiedIntervalCoverage }
  | { readonly status: 'UNKNOWN'; readonly reason: string }
> {
  assertVerifiedSession(session);
  assertVerifiedDecisionInSession(session, fromDecision);
  assertVerifiedDecisionInSession(session, throughDecision);
  assertVerifiedExecutionBook(fromBook);
  assertVerifiedExecutionBook(throughBook);
  const fromContext = replayContext(fromDecision);
  const throughContext = replayContext(throughDecision);
  const symbol = throughDecision.symbol;
  const fromExchangeAsOfMs = fromContext?.exchangeObservedAtMs;
  const throughExchangeAsOfMs = throughContext?.exchangeObservedAtMs;
  const fromReceivedAtMs = fromContext?.observedAtMs;
  const throughReceivedAtMs = throughContext?.observedAtMs;
  const decisionIndex = sessionDecisionIndexes.get(session)!;
  const fromInputSha256 = decisionIndex.get(fromDecision.decisionId)!.canonicalSha256;
  const throughInputSha256 = decisionIndex.get(throughDecision.decisionId)!.canonicalSha256;
  const skippedDecision = [...decisionIndex.entries()].some(
    ([decisionId, entry]) =>
      decisionId !== fromDecision.decisionId &&
      decisionId !== throughDecision.decisionId &&
      entry.symbol === symbol &&
      entry.evaluatedAtReceivedMs > fromDecision.evaluatedAtReceivedMs &&
      entry.evaluatedAtReceivedMs < throughDecision.evaluatedAtReceivedMs,
  );
  if (
    fromDecision.symbol !== symbol ||
    fromBook.decisionId !== fromDecision.decisionId ||
    throughBook.decisionId !== throughDecision.decisionId ||
    fromBook.symbol !== symbol ||
    throughBook.symbol !== symbol ||
    fromBook.decisionInputSha256 !== fromInputSha256 ||
    throughBook.decisionInputSha256 !== throughInputSha256 ||
    fromBook.sessionManifestSha256 !== session.manifestSha256 ||
    throughBook.sessionManifestSha256 !== session.manifestSha256 ||
    fromBook.exchangeAsOfMs !== fromExchangeAsOfMs ||
    throughBook.exchangeAsOfMs !== throughExchangeAsOfMs ||
    fromBook.receivedAsOfMs !== fromReceivedAtMs ||
    throughBook.receivedAsOfMs !== throughReceivedAtMs ||
    fromBook.evidenceContractSha256 !== replayEvidenceContractSha256() ||
    throughBook.evidenceContractSha256 !== replayEvidenceContractSha256() ||
    ![fromExchangeAsOfMs, throughExchangeAsOfMs, fromReceivedAtMs, throughReceivedAtMs].every(
      Number.isFinite,
    ) ||
    fromExchangeAsOfMs! >= throughExchangeAsOfMs! ||
    fromReceivedAtMs! >= throughReceivedAtMs! ||
    fromDecision.evaluatedAtReceivedMs >= throughDecision.evaluatedAtReceivedMs ||
    fromReceivedAtMs! < session.startedAtMs ||
    throughReceivedAtMs! > session.completedAtMs
  )
    return { status: 'UNKNOWN', reason: 'INTERVAL_CLOCK_OR_IDENTITY_INVALID' };
  if (
    throughReceivedAtMs! - fromReceivedAtMs! >
      MICRO_PAIRED_REPLAY_EVIDENCE_CONTRACT_V1.maxObservationGapMs ||
    throughExchangeAsOfMs! - fromExchangeAsOfMs! >
      MICRO_PAIRED_REPLAY_EVIDENCE_CONTRACT_V1.maxObservationGapMs ||
    throughDecision.evaluatedAtReceivedMs - fromDecision.evaluatedAtReceivedMs >
      MICRO_PAIRED_REPLAY_EVIDENCE_CONTRACT_V1.maxObservationGapMs
  )
    return { status: 'UNKNOWN', reason: 'FRAME_CADENCE_GAP' };
  if (skippedDecision) return { status: 'UNKNOWN', reason: 'INTERMEDIATE_DECISIONS_NOT_INCLUDED' };
  const declaredGap = session.gaps.find(
    (gap) =>
      gap.symbol === symbol &&
      (gap.feed === 'DEPTH' || gap.feed === 'AGG_TRADE' || gap.feed === null) &&
      gap.fromMs <= throughExchangeAsOfMs! &&
      gap.throughMs >= fromExchangeAsOfMs!,
  );
  if (declaredGap)
    return {
      status: 'UNKNOWN',
      reason:
        declaredGap.feed === 'DEPTH'
          ? 'DECLARED_DEPTH_GAP'
          : declaredGap.feed === 'AGG_TRADE'
            ? 'DECLARED_TRADE_GAP'
            : 'DECLARED_UNKNOWN_FEED_GAP',
    };
  if (
    fromBook.maxAgeMs !== MICRO_PAIRED_REPLAY_EVIDENCE_CONTRACT_V1.maxBookAgeMs ||
    throughBook.maxAgeMs !== MICRO_PAIRED_REPLAY_EVIDENCE_CONTRACT_V1.maxBookAgeMs ||
    fromReceivedAtMs! - fromBook.observedAtMs > fromBook.maxAgeMs ||
    throughReceivedAtMs! - throughBook.observedAtMs > throughBook.maxAgeMs
  )
    return { status: 'UNKNOWN', reason: 'BOOK_FRESHNESS_CONTRACT_FAILED' };

  // The exact, independently verified point book is the interval's starting state.
  // It carries its source depth bounds, which may be wider than the rolling top-20
  // SQLite feature checkpoint persisted near this decision.
  const checkpointInput = {
    symbol,
    receivedAtMs: fromBook.observedAtMs,
    availableAtMs: fromBook.observedAtMs,
    lastUpdateId: fromBook.lastUpdateId,
    bids: fromBook.bidDepth,
    asks: fromBook.askDepth,
    knownDepthBounds: fromBook.knownDepthBounds,
  };
  const depthEvents = await readDepthEventsInReceiveWindow(
    session,
    symbol,
    fromBook.observedAtMs,
    throughReceivedAtMs!,
  );
  const startReplay = replayCausalDepth(
    checkpointInput,
    depthEvents,
    { exchangeAsOfMs: fromExchangeAsOfMs!, receivedAsOfMs: fromReceivedAtMs! },
    MICRO_PAIRED_REPLAY_EVIDENCE_CONTRACT_V1.maxBookAgeMs,
  );
  const endReplay = replayCausalDepth(
    checkpointInput,
    depthEvents,
    { exchangeAsOfMs: throughExchangeAsOfMs!, receivedAsOfMs: throughReceivedAtMs! },
    MICRO_PAIRED_REPLAY_EVIDENCE_CONTRACT_V1.maxBookAgeMs,
    true,
  );
  if (startReplay.status !== 'VERIFIED' || !startReplay.book)
    return { status: 'UNKNOWN', reason: startReplay.reason ?? 'PRE_INTERVAL_BOOK_UNKNOWN' };
  if (endReplay.status !== 'VERIFIED' || !endReplay.book)
    return { status: 'UNKNOWN', reason: endReplay.reason ?? 'INTERVAL_BOOK_UNKNOWN' };
  if (!sameKnownBook(startReplay.book, fromContext!.executionBook!))
    return { status: 'UNKNOWN', reason: 'PRE_INTERVAL_BOOK_DECISION_MISMATCH' };
  if (!sameKnownBook(endReplay.book, throughContext!.executionBook!))
    return { status: 'UNKNOWN', reason: 'THROUGH_INTERVAL_BOOK_DECISION_MISMATCH' };
  if (endReplay.book.lastUpdateId === startReplay.book.lastUpdateId)
    return { status: 'UNKNOWN', reason: 'DEPTH_NO_UPDATES_OBSERVED' };
  if (endReplay.book.lastUpdateId < startReplay.book.lastUpdateId)
    return { status: 'UNKNOWN', reason: 'DEPTH_UPDATE_ID_REGRESSION' };

  const intervalDepthEvents = depthEvents.filter(
    (event) =>
      event.receivedAtMs <= throughReceivedAtMs! &&
      event.eventTime > fromExchangeAsOfMs! &&
      event.eventTime <= throughExchangeAsOfMs!,
  );
  if (intervalDepthEvents.length === 0)
    return { status: 'UNKNOWN', reason: 'DEPTH_INTERVAL_HAS_NO_CAUSAL_UPDATES' };
  if (
    depthEvents.some(
      (event) =>
        event.receivedAtMs === fromReceivedAtMs! &&
        Number(event.payload.u) > fromBook.lastUpdateId &&
        event.eventTime <= throughExchangeAsOfMs!,
    )
  )
    return { status: 'UNKNOWN', reason: 'DEPTH_RECEIVE_CLOCK_TIE_AT_INTERVAL_START' };
  if (
    depthEvents.some(
      (event) =>
        event.receivedAtMs > fromReceivedAtMs! &&
        event.receivedAtMs <= throughReceivedAtMs! &&
        event.eventTime <= fromExchangeAsOfMs!,
    )
  ) {
    const fromExchangeLowerBoundMs = Number(
      fromContext?.clockReference?.contextBuiltExchangeLowerBoundMs,
    );
    const crossingEvents = depthEvents.filter(
      (event) =>
        event.receivedAtMs > fromReceivedAtMs! &&
        event.receivedAtMs <= throughReceivedAtMs! &&
        event.eventTime <= fromExchangeAsOfMs!,
    );
    return {
      status: 'UNKNOWN',
      reason:
        Number.isFinite(fromExchangeLowerBoundMs) &&
        crossingEvents.some((event) => event.eventTime < fromExchangeLowerBoundMs)
          ? 'DEPTH_LATE_EVENT_CROSSES_INTERVAL_START'
          : 'DEPTH_EVENT_ORDER_AMBIGUOUS_AT_INTERVAL_START',
    };
  }
  const tradeEvidence = await readVerifiedPullbackEvidence(
    session,
    throughDecision,
    throughExchangeAsOfMs!,
    throughReceivedAtMs!,
  );
  if (
    !tradeEvidence.coverageVerified ||
    !tradeEvidence.gapFree ||
    !tradeEvidence.sequenceValid ||
    tradeEvidence.coverageStartedAtMs > fromExchangeAsOfMs!
  )
    return {
      status: 'UNKNOWN',
      reason: tradeEvidence.invalidReason ?? 'TRADE_INTERVAL_UNVERIFIED',
    };
  const depthEvidenceSha256 = sha256(
    canonical({
      checkpoint: checkpointInput,
      checkpointSource: fromBook.checkpointSource,
      checkpointEvidenceSha256: fromBook.checkpointEvidenceSha256,
      fromBookEvidenceSha256: fromBook.evidenceSha256,
      startBook: startReplay.book,
      endBook: endReplay.book,
      depthEvents,
      intervalDepthEvents,
    }),
  );
  const evidenceContractSha256 = replayEvidenceContractSha256();
  const value: VerifiedIntervalCoverage = Object.freeze({
    fromDecisionId: fromDecision.decisionId,
    fromDecisionInputSha256: fromInputSha256,
    decisionId: throughDecision.decisionId,
    symbol,
    fromExchangeAsOfMs: fromExchangeAsOfMs!,
    throughExchangeAsOfMs: throughExchangeAsOfMs!,
    fromReceivedAtMs: fromReceivedAtMs!,
    throughReceivedAtMs: throughReceivedAtMs!,
    sessionManifestSha256: session.manifestSha256,
    sourceArtifactHash: session.artifactHash,
    tradeEvidenceSha256: sha256(canonical(tradeEvidence.trades)),
    depthEvidenceSha256,
    checkpointAtMs: fromBook.checkpointAtMs,
    checkpointPersistedAtMs: fromBook.checkpointPersistedAtMs,
    checkpointSource: fromBook.checkpointSource,
    checkpointEvidenceSha256: fromBook.checkpointEvidenceSha256,
    fromBookEvidenceSha256: fromBook.evidenceSha256,
    depthFirstUpdateId: startReplay.book.lastUpdateId,
    depthLastUpdateId: endReplay.book.lastUpdateId,
    depthEventCount: intervalDepthEvents.length,
    evidenceContractSha256,
    evidenceSha256: sha256(
      canonical({
        sessionManifestSha256: session.manifestSha256,
        sourceArtifactHash: session.artifactHash,
        fromDecisionSha256: fromInputSha256,
        throughDecisionSha256: throughInputSha256,
        symbol,
        fromExchangeAsOfMs,
        throughExchangeAsOfMs,
        fromReceivedAtMs,
        throughReceivedAtMs,
        tradeEvidenceSha256: sha256(canonical(tradeEvidence.trades)),
        depthEvidenceSha256,
        evidenceContractSha256,
      }),
    ),
  });
  verifiedIntervals.add(value);
  return { status: 'VERIFIED', evidence: value };
}

/** Funding proof is optional in captured sessions; absence remains unavailable, never zero. */
export async function readVerifiedFundingEvidence(
  session: VerifiedCaptureSession,
  symbol: string,
  fromMs: number,
  throughMs: number,
): Promise<VerifiedFundingEvidence | null> {
  assertVerifiedSession(session);
  if (
    !Number.isFinite(fromMs) ||
    !Number.isFinite(throughMs) ||
    fromMs <= 0 ||
    throughMs <= 0 ||
    fromMs > throughMs
  )
    return null;
  const sources = session.decisionFiles.filter((source) =>
    /\/funding-evidence(?:\..+)?\.jsonl$/.test(source.relativePath),
  );
  const evidenceRows: Array<{
    schema: string;
    symbol: string;
    fromMs: number;
    throughMs: number;
    source: string;
    events: Array<{
      eventAtMs: number;
      fundingRate: number;
      markPrice: number;
      markObservedAtMs: number;
    }>;
    responseSha256: string;
  }> = [];
  for (const source of sources) {
    const file = resolve(session.root, source.relativePath);
    if ((await hashStableFile(file)) !== source.sha256)
      throw new Error('FUNDING_EVIDENCE_FILE_HASH_MISMATCH');
    const reader = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    try {
      for await (const line of reader) {
        if (!line.trim()) continue;
        const record = JSON.parse(line) as (typeof evidenceRows)[number];
        if (
          record.schema !== 'MICRO_FUNDING_EVIDENCE_V1' ||
          !record.symbol ||
          !Number.isFinite(record.fromMs) ||
          !Number.isFinite(record.throughMs) ||
          record.fromMs > record.throughMs ||
          !Array.isArray(record.events) ||
          !['BINANCE_FUNDING_HISTORY_WITH_MARK_PRICE', 'SYNTHETIC_TEST_FIXTURE'].includes(
            record.source,
          )
        )
          throw new Error('FUNDING_EVIDENCE_SCHEMA_INVALID');
        const raw = {
          schema: record.schema,
          symbol: record.symbol,
          fromMs: record.fromMs,
          throughMs: record.throughMs,
          source: record.source,
          events: record.events,
        };
        if (sha256(canonical(raw)) !== record.responseSha256)
          throw new Error('FUNDING_EVIDENCE_CONTENT_HASH_MISMATCH');
        evidenceRows.push(record);
      }
    } finally {
      reader.close();
    }
  }
  const matching = evidenceRows.filter(
    (row) => row.symbol === symbol && row.fromMs <= fromMs && row.throughMs >= throughMs,
  );
  if (matching.length !== 1) return null;
  const row = matching[0];
  let previousAt = -Infinity;
  for (const event of row.events) {
    if (
      !Number.isFinite(event.eventAtMs) ||
      !Number.isFinite(event.fundingRate) ||
      !Number.isFinite(event.markPrice) ||
      event.markPrice <= 0 ||
      !Number.isFinite(event.markObservedAtMs) ||
      event.markObservedAtMs > event.eventAtMs ||
      event.eventAtMs < row.fromMs ||
      event.eventAtMs > row.throughMs ||
      event.eventAtMs < previousAt
    )
      throw new Error('FUNDING_EVIDENCE_EVENT_INVALID');
    previousAt = event.eventAtMs;
  }
  const verified: VerifiedFundingEvidence = Object.freeze({
    symbol,
    sessionManifestSha256: session.manifestSha256,
    fromMs: row.fromMs,
    throughMs: row.throughMs,
    source: row.source,
    evidenceSha256: row.responseSha256,
    events: Object.freeze(row.events.map((event) => Object.freeze({ ...event }))),
  });
  verifiedFundingEvidence.add(verified);
  return verified;
}

export function assertVerifiedExecutionBook(
  value: unknown,
): asserts value is VerifiedExecutionBook {
  if (!value || typeof value !== 'object' || !verifiedExecutionBooks.has(value))
    throw new Error('REPLAY_BOOK_NOT_ARCHIVE_VERIFIED');
}

export function assertVerifiedIntervalCoverage(
  value: unknown,
): asserts value is VerifiedIntervalCoverage {
  if (!value || typeof value !== 'object' || !verifiedIntervals.has(value))
    throw new Error('REPLAY_INTERVAL_NOT_ARCHIVE_VERIFIED');
}

function readJson(file: string): any {
  return JSON.parse(readFileSync(file, 'utf8'));
}

async function hashStableFile(file: string): Promise<string> {
  const before = statSync(file);
  const digest = createHash('sha256');
  const input = createReadStream(file);
  for await (const chunk of input) digest.update(chunk as Buffer);
  const after = statSync(file);
  if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs)
    throw new Error(`CAPTURE_SOURCE_CHANGED:${file}`);
  return digest.digest('hex');
}

function collectCaptureFiles(directory: string): string[] {
  const output: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const file = join(current, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(`CAPTURE_SYMLINK_PROHIBITED:${relative(directory, file)}`);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) output.push(resolve(file));
    }
  };
  walk(directory);
  return output;
}

function isWithin(root: string, file: string): boolean {
  const child = relative(root, file);
  return child !== '' && !isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`);
}

function isDecisionEvidenceFile(file: string): boolean {
  return (
    /\/(decisions|snapshots|rest-inputs|events)(?:\..+)?\.jsonl(?:\.gz)?$/.test(file) ||
    /\/signals\/.+\.jsonl$/.test(file) ||
    /\/funding-evidence(?:\..+)?\.jsonl$/.test(file) ||
    file.includes(`${sep}episode-capture${sep}`)
  );
}

function runtimeStorageHealthy(health: Record<string, any>): boolean {
  const runtime = health.runtime;
  const writers = [
    health.decisionWriter,
    health.restWriter,
    health.eventWriter,
    health.snapshotWriter,
  ];
  return Boolean(
    runtime &&
      runtime.running === false &&
      runtime.paperTradingEnabled === false &&
      runtime.paperTrading?.openPositions === 0 &&
      runtime.paperTrading?.completedManagedTrades === 0 &&
      runtime.marketArchiveHealthy === true &&
      runtime.archiveQueueDepth === 0 &&
      runtime.archiveOverflowRecords === 0 &&
      runtime.storageErrors === 0 &&
      runtime.uncleanDeferredWriteMarker === false &&
      runtime.mutationAttempts === 0 &&
      runtime.forwardedMutations === 0 &&
      writers.every(
        (writer) =>
          writer &&
          writer.pendingWrites === 0 &&
          writer.writeFailures === 0 &&
          writer.overloadRejected === 0,
      ) &&
      (health.auxiliaryWriteFailures ?? 0) === 0,
  );
}

/** Verify bytes, envelopes and indexed event bounds without holding a segment in memory. */
async function verifyArchiveSegment(
  segment: ArchiveSegment & {
    readonly expectedType: 'trades' | 'depth';
    readonly expectedSymbol: string;
    readonly expectedFirstEventTimeMs: number;
    readonly expectedLastEventTimeMs: number;
  },
): Promise<DepthSegmentStats> {
  const before = statSync(segment.filePath);
  const digest = createHash('sha256');
  const input = createReadStream(segment.filePath);
  const decoded = input.pipe(createGunzip());
  const decoder = new StringDecoder('utf8');
  let remainder = '';
  let records = 0;
  let minEventTimeMs = Infinity;
  let maxEventTimeMs = -Infinity;
  let minReceivedAtMs = Infinity;
  let maxReceivedAtMs = -Infinity;
  const consume = (line: string): void => {
    if (!line) throw new Error('ARCHIVE_EMPTY_RECORD');
    const row = JSON.parse(line) as ArchiveEvent;
    if (
      !row.symbol ||
      !['trades', 'depth'].includes(row.type) ||
      ![row.eventTime, row.receivedAtMs].every((n) => Number.isFinite(n) && n > 0) ||
      !row.payload ||
      row.payload.eventTime !== row.eventTime ||
      row.payload.receivedAtMs !== row.receivedAtMs ||
      row.payload.symbol !== row.symbol ||
      row.type !== segment.expectedType ||
      row.symbol !== segment.expectedSymbol
    )
      throw new Error('ARCHIVE_ENVELOPE_INVALID');
    minEventTimeMs = Math.min(minEventTimeMs, row.eventTime);
    maxEventTimeMs = Math.max(maxEventTimeMs, row.eventTime);
    minReceivedAtMs = Math.min(minReceivedAtMs, row.receivedAtMs);
    maxReceivedAtMs = Math.max(maxReceivedAtMs, row.receivedAtMs);
    records++;
  };
  for await (const chunk of decoded) {
    digest.update(chunk as Buffer);
    const lines = (remainder + decoder.write(chunk as Buffer)).split('\n');
    remainder = lines.pop() ?? '';
    for (const line of lines) consume(line);
  }
  if ((remainder + decoder.end()).length !== 0)
    throw new Error('ARCHIVE_CHECKSUM_OR_TERMINATION_INVALID');
  const after = statSync(segment.filePath);
  if (
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    records !== segment.recordCount ||
    minEventTimeMs !== segment.expectedFirstEventTimeMs ||
    maxEventTimeMs !== segment.expectedLastEventTimeMs ||
    digest.digest('hex') !== segment.checksum
  )
    throw new Error('ARCHIVE_CHECKSUM_OR_METADATA_INVALID');
  return { minEventTimeMs, maxEventTimeMs, minReceivedAtMs, maxReceivedAtMs };
}

function assertVerifiedSession(session: unknown): asserts session is VerifiedCaptureSession {
  if (!isVerifiedCaptureSession(session))
    throw new Error('CAPTURE_SESSION_NOT_VERIFIED_IN_PROCESS');
}

async function buildDecisionIndex(
  session: VerifiedCaptureSession,
): Promise<{ index: ReadonlyMap<string, VerifiedDecisionIndexEntry>; recordCount: number }> {
  const index = new Map<string, VerifiedDecisionIndexEntry>();
  let recordCount = 0;
  for (const source of session.decisionFiles) {
    const file = resolve(session.root, source.relativePath);
    const names = source.relativePath.split(/[\\/]/);
    const name = names[names.length - 1] ?? '';
    if (!/^decisions(?:\..+)?\.jsonl(?:\.gz)?$/.test(name) || name.includes('.timing.')) continue;
    if ((await hashStableFile(file)) !== source.sha256)
      throw new Error('CAPTURE_SESSION_DECISION_SOURCE_HASH_MISMATCH');
    const stream = createReadStream(file);
    const input = file.endsWith('.gz') ? stream.pipe(createGunzip()) : stream;
    const reader = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of reader) {
        if (!line.trim()) continue;
        const record = JSON.parse(line) as StrategyDecisionEvidenceV2;
        assertStrategyDecisionEvidenceV2(record);
        if (record.strategy.strategyId !== 'MICRO_BURST')
          throw new Error(`CAPTURED_DECISION_STRATEGY_MISMATCH:${record.decisionId}`);
        recordCount++;
        if (
          record.strategy.configHash !== `sha256:${session.configHash}` ||
          record.strategy.codeCommitSha !== session.producerCommit
        )
          throw new Error(`CAPTURED_DECISION_PROVENANCE_MISMATCH:${record.decisionId}`);
        const row = {
          symbol: record.symbol,
          evaluatedAtReceivedMs: record.evaluatedAtReceivedMs,
          canonicalSha256: sha256(canonical(record)),
          strategyConfigHash: record.strategy.configHash,
          codeCommitSha: record.strategy.codeCommitSha,
        };
        const previous = index.get(record.decisionId);
        if (previous && canonical(previous) !== canonical(row))
          throw new Error(`CAPTURED_DECISION_CONFLICT:${record.decisionId}`);
        index.set(record.decisionId, row);
      }
    } finally {
      reader.close();
    }
  }
  return { index, recordCount };
}

async function countDecisionEvidenceRows(
  collectorRoot: string,
  files: readonly CaptureSessionBody['decisionFiles'][number][],
): Promise<number> {
  let count = 0;
  for (const source of files) {
    const names = source.relativePath.split(/[\\/]/);
    const name = names[names.length - 1] ?? '';
    if (!/^decisions(?:\..+)?\.jsonl(?:\.gz)?$/.test(name) || name.includes('.timing.')) continue;
    const file = resolve(collectorRoot, source.relativePath);
    const stream = createReadStream(file);
    const input = file.endsWith('.gz') ? stream.pipe(createGunzip()) : stream;
    const reader = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of reader) {
        if (!line.trim()) continue;
        const record = JSON.parse(line) as StrategyDecisionEvidenceV2;
        assertStrategyDecisionEvidenceV2(record);
        if (record.strategy.strategyId !== 'MICRO_BURST')
          throw new Error(`CAPTURED_DECISION_STRATEGY_MISMATCH:${record.decisionId}`);
        count++;
      }
    } finally {
      reader.close();
    }
  }
  return count;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}
