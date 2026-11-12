import { createHash } from 'node:crypto';
import type { StrategyDecisionEvidenceV2 } from '../../core/blackbox/StrategyDecisionBlackBox';
import type {
  MicroBurstConfig,
  MicroBurstExitContext,
} from '../../strategies/micro-burst/domain/MicroBurstTypes';
import {
  isVerifiedCaptureSession,
  isVerifiedDecisionRecord,
  readVerifiedExecutionBookForDecision,
  verifyVerifiedDecisionInterval,
  type VerifiedCaptureSession,
  type VerifiedExecutionBook,
  type VerifiedIntervalCoverage,
} from './MicroBurstCaptureSession';
import {
  isVerifiedPullbackObservation,
  type PullbackObservation,
} from './MicroBurstPullbackCandidate';
import {
  MICRO_PAIRED_REPLAY_EVIDENCE_CONTRACT_SHA256,
  PULLBACK_EXPERIMENT_V1_SHA256,
} from './MicroBurstReplayEvidenceContract';
import {
  decodeValidatedPatternReplay,
  historicalDecisionAgrees,
} from './MicroBurstPatternComparison';

export type ReplayFrameVerificationStatus = 'VERIFIED_POINT' | 'VERIFIED_INTERVAL' | 'UNKNOWN';
export type ReplayFrameIntervalStatus = 'NOT_EVALUATED' | 'UNKNOWN' | 'VERIFIED';

export interface VerifiedReplayFrame {
  readonly schema: 'MICRO_VERIFIED_REPLAY_FRAME_V1';
  readonly verificationStatus: ReplayFrameVerificationStatus;
  /** A point can be verified even when continuity to the preceding decision is not. */
  readonly intervalStatus: ReplayFrameIntervalStatus;
  readonly intervalReason: string | null;
  readonly intervalFromDecisionId: string | null;
  readonly reason?: string;
  readonly decision: StrategyDecisionEvidenceV2;
  readonly observation: PullbackObservation;
  readonly decisionId: string;
  readonly symbol: string;
  readonly atMs: number;
  readonly decisionAvailableAtMs: number;
  readonly exchangeAsOfMs: number;
  readonly sourceArtifactHash: string;
  readonly sessionManifestSha256: string;
  readonly decisionInputSha256: string;
  readonly evidenceContractSha256: string;
  readonly exitPolicyConfig: MicroBurstConfig;
  readonly exitPolicyConfigSha256: string;
  readonly book: VerifiedExecutionBook | null;
  readonly intervalCoverage: VerifiedIntervalCoverage | null;
  readonly exitEvidence: Pick<
    MicroBurstExitContext,
    'currentBookPressure' | 'currentBtcContext' | 'marketEvidence'
  >;
  readonly evidenceSha256: string;
}

const verifiedFrames = new WeakSet<object>();
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
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

export function isVerifiedReplayFrame(value: unknown): value is VerifiedReplayFrame {
  return Boolean(value && typeof value === 'object' && verifiedFrames.has(value));
}

export function assertVerifiedReplayFrame(value: unknown): asserts value is VerifiedReplayFrame {
  if (!isVerifiedReplayFrame(value)) throw new Error('REPLAY_FRAME_NOT_CAPTURE_VERIFIED');
}

/**
 * The only frame constructor used by paired replay. Source clocks are decoded from
 * the hash-checked decision; callers cannot supply timestamps, coverage flags,
 * decision IDs, expected books, or freshness allowances.
 */
export async function buildVerifiedReplayFrame(
  session: VerifiedCaptureSession,
  decision: StrategyDecisionEvidenceV2,
  observation: PullbackObservation,
  previous?: VerifiedReplayFrame,
): Promise<VerifiedReplayFrame> {
  if (!isVerifiedCaptureSession(session) || !isVerifiedDecisionRecord(decision))
    throw new Error('REPLAY_FRAME_REQUIRES_VERIFIED_SESSION_DECISION');
  if (!isVerifiedPullbackObservation(observation))
    throw new Error('REPLAY_FRAME_REQUIRES_VERIFIED_PULLBACK_OBSERVATION');
  if (previous) assertVerifiedReplayFrame(previous);

  if (
    observation.sourceDecisionId !== decision.decisionId ||
    observation.symbol !== decision.symbol
  )
    throw new Error(`REPLAY_FRAME_DECISION_IDENTITY_OR_CLOCK_MISMATCH:${decision.decisionId}`);

  deepFreeze(decision);
  deepFreeze(observation);
  if (previous) deepFreeze(previous);

  const replayResult = decodeValidatedPatternReplay(
    decision.diagnostics?.strategyInputReplay,
    decision.strategy.codeCommitSha,
  );
  if (
    !historicalDecisionAgrees(decision, replayResult.current) ||
    !historicalDecisionAgrees(decision, observation.baseline)
  )
    throw new Error(`REPLAY_FRAME_CURRENT_DECISION_MISMATCH:${decision.decisionId}`);
  const replay = replayResult.replay;
  const observedAtMs = replay.context.observedAtMs;
  const exchangeAsOfMs = replay.context.exchangeObservedAtMs;
  const decisionAvailableAtMs = decision.evaluatedAtReceivedMs;
  const decisionInputSha256 = sha256(canonical(decision));
  const evidenceContractSha256 = MICRO_PAIRED_REPLAY_EVIDENCE_CONTRACT_SHA256;
  const exitPolicyConfig = deepFreeze(replayResult.replay.config);
  const exitPolicyConfigSha256 = sha256(canonical(exitPolicyConfig));
  if (
    !Number.isFinite(observedAtMs) ||
    !Number.isFinite(exchangeAsOfMs) ||
    !Number.isFinite(decisionAvailableAtMs) ||
    decisionAvailableAtMs! < observedAtMs! ||
    decisionAvailableAtMs! > session.completedAtMs ||
    observation.sourceDecisionId !== decision.decisionId ||
    observation.symbol !== decision.symbol ||
    observation.observedAtMs !== observedAtMs ||
    observation.exchangeAsOfMs !== exchangeAsOfMs ||
    observation.sourceArtifactHash !== session.artifactHash ||
    observation.sessionManifestSha256 !== session.manifestSha256 ||
    observation.decisionInputSha256 !== decisionInputSha256
  )
    throw new Error(`REPLAY_FRAME_DECISION_IDENTITY_OR_CLOCK_MISMATCH:${decision.decisionId}`);
  if (observation.experimentConfigSha256 !== PULLBACK_EXPERIMENT_V1_SHA256)
    throw new Error('PULLBACK_EXPERIMENT_CONFIG_NOT_PREREGISTERED');
  if (
    previous &&
    (previous.sourceArtifactHash !== session.artifactHash ||
      previous.sessionManifestSha256 !== session.manifestSha256 ||
      previous.symbol !== decision.symbol)
  )
    throw new Error('REPLAY_FRAME_PREVIOUS_IDENTITY_MISMATCH');

  const previousClockRegression = previous
    ? previous.atMs >= observedAtMs!
      ? 'PREVIOUS_FRAME_RECEIVE_CLOCK_REGRESSION'
      : previous.decisionAvailableAtMs >= decisionAvailableAtMs!
        ? 'PREVIOUS_FRAME_AVAILABILITY_CLOCK_REGRESSION'
        : previous.exchangeAsOfMs >= exchangeAsOfMs!
          ? 'PREVIOUS_FRAME_EXCHANGE_CLOCK_REGRESSION'
          : null
    : null;

  const bookAssessment = await readVerifiedExecutionBookForDecision(session, decision);
  const book = bookAssessment.status === 'VERIFIED' ? bookAssessment.book : null;
  let verificationStatus: ReplayFrameVerificationStatus = 'VERIFIED_POINT';
  let reason: string | undefined =
    bookAssessment.status === 'UNKNOWN' ? bookAssessment.reason : undefined;
  let intervalStatus: ReplayFrameIntervalStatus = previous ? 'UNKNOWN' : 'NOT_EVALUATED';
  let intervalReason: string | null = null;
  let intervalCoverage: VerifiedIntervalCoverage | null = null;
  if (!book) {
    verificationStatus = 'UNKNOWN';
    reason ??= 'DECISION_BOOK_UNVERIFIED';
    intervalStatus = 'NOT_EVALUATED';
  } else if (previous) {
    if (previousClockRegression) {
      intervalReason = previousClockRegression;
    } else if (!previous.book) {
      intervalReason = 'PREVIOUS_FRAME_BOOK_UNAVAILABLE';
    } else {
      const interval = await verifyVerifiedDecisionInterval(
        session,
        previous.decision,
        decision,
        previous.book,
        book,
      );
      if (interval.status === 'VERIFIED') {
        verificationStatus = 'VERIFIED_INTERVAL';
        intervalStatus = 'VERIFIED';
        intervalCoverage = interval.evidence;
      } else {
        intervalReason = interval.reason;
      }
    }
  }
  const frame = Object.freeze({
    schema: 'MICRO_VERIFIED_REPLAY_FRAME_V1' as const,
    verificationStatus,
    intervalStatus,
    intervalReason,
    intervalFromDecisionId: previous?.decisionId ?? null,
    ...(reason ? { reason } : {}),
    decision,
    observation,
    decisionId: decision.decisionId,
    symbol: decision.symbol,
    atMs: observedAtMs!,
    decisionAvailableAtMs: decisionAvailableAtMs!,
    exchangeAsOfMs: exchangeAsOfMs!,
    sourceArtifactHash: session.artifactHash,
    sessionManifestSha256: session.manifestSha256,
    decisionInputSha256,
    evidenceContractSha256,
    exitPolicyConfig,
    exitPolicyConfigSha256,
    book,
    intervalCoverage,
    exitEvidence: deepFreeze({
      currentBookPressure: replay.context.bookPressure,
      currentBtcContext: replay.context.btcContext,
      marketEvidence: null,
    }),
    evidenceSha256: sha256(
      canonical({
        schema: 'MICRO_VERIFIED_REPLAY_FRAME_V1',
        verificationStatus,
        intervalStatus,
        intervalReason,
        intervalFromDecisionId: previous?.decisionId ?? null,
        reason,
        decisionId: decision.decisionId,
        symbol: decision.symbol,
        atMs: observedAtMs,
        decisionAvailableAtMs,
        exchangeAsOfMs,
        sourceArtifactHash: session.artifactHash,
        sessionManifestSha256: session.manifestSha256,
        decisionInputSha256,
        exitPolicyConfigSha256,
        pullbackObservationSha256: observation.evidenceSha256,
        evidenceContractSha256,
        bookSha256: book?.evidenceSha256 ?? null,
        intervalCoverageSha256: intervalCoverage?.evidenceSha256 ?? null,
      }),
    ),
  });
  verifiedFrames.add(frame);
  return frame;
}

function deepFreeze<T>(value: T, visited = new WeakSet<object>()): T {
  if (!value || typeof value !== 'object' || visited.has(value as object)) return value;
  visited.add(value as object);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, visited);
  return Object.freeze(value);
}
