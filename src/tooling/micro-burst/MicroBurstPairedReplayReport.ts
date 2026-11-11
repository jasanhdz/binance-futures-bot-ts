import {
  assertVerifiedEpisodeExecution,
  type EpisodeExecution,
} from './MicroBurstPairedExecutionReplay';
import type { VerifiedReplayFrame } from './MicroBurstVerifiedReplayFrame';
import type { PullbackObservation } from './MicroBurstPullbackCandidate';
import { assertVerifiedReplayFrame } from './MicroBurstVerifiedReplayFrame';
import { MICRO_PAIRED_REPLAY_EVIDENCE_CONTRACT_SHA256 } from './MicroBurstReplayEvidenceContract';

export interface PairedReplayReport {
  authority: 'DESCRIPTIVE_RESEARCH_ONLY';
  resultKind: 'MODELLED_BOOK_VWAP_NOT_REAL_FILL';
  evidenceContractSha256: string;
  selection: { accepted: Group; rejected: Group; unresolved: Group };
  operable: {
    current: Group;
    pullback: Group;
    pairedClosedEpisodes: number;
    meanPairedDeltaUsdt: number | null;
  };
  baselineRejectedObservations: number;
  independentBaselineEpisodes: number;
  terminalOutcomes: readonly {
    episodeId: string;
    current: string;
    pullback: string;
    pullbackSelection: string;
    executionKind: 'MODELLED_BOOK_VWAP_NOT_REAL_FILL';
  }[];
}
interface Group {
  episodes: number;
  closed: number;
  unknown: number;
  unfilled: number;
  rejected: number;
  waiting: number;
  noExecutionRecord: number;
  meanNetUsdt: number | null;
}

/** Selection buckets use CURRENT outcomes in both groups; execution comparison uses own fills.
 * Descriptive conditioning on eventual qualification is not an implementable early selection rule.
 */
export function summarizePairedReplay(
  frames: readonly VerifiedReplayFrame[],
  results: readonly EpisodeExecution[],
): PairedReplayReport {
  const episodes = new Set<string>();
  const accepted = new Set<string>();
  const lastSelection = new Map<string, PullbackObservation['disposition']>();
  const verifiedFrameHashes = new Map<string, VerifiedReplayFrame>();
  const verifiedIntervalHashes = new Set<string>();
  let baselineRejectedObservations = 0;
  for (const frame of frames) {
    assertVerifiedReplayFrame(frame);
    if (verifiedFrameHashes.has(frame.evidenceSha256))
      throw new Error('DUPLICATE_VERIFIED_REPLAY_FRAME');
    verifiedFrameHashes.set(frame.evidenceSha256, frame);
    if (frame.intervalCoverage) verifiedIntervalHashes.add(frame.intervalCoverage.evidenceSha256);
    const baseline = frame.observation.baseline;
    if (baseline.action !== 'ENTRY_INTENT') {
      baselineRejectedObservations++;
      continue;
    }
    const id = baseline.diagnostics.episodeId;
    if (typeof id !== 'string') continue;
    episodes.add(id);
    lastSelection.set(id, frame.observation.disposition);
    if (frame.observation.disposition === 'QUALIFIED') accepted.add(id);
  }
  const records = new Map<string, EpisodeExecution>();
  for (const result of results) {
    assertVerifiedEpisodeExecution(result);
    const key = `${result.variant}:${result.episodeId}`;
    if (records.has(key)) throw new Error('DUPLICATE_EPISODE_EXECUTION');
    const sourceFrame = verifiedFrameHashes.get(result.sourceReplayFrameSha256);
    if (
      !sourceFrame ||
      sourceFrame.decisionId !== result.sourceDecisionId ||
      sourceFrame.decisionInputSha256 !== result.sourceDecisionInputSha256 ||
      sourceFrame.observation.evidenceSha256 !== result.sourcePullbackObservationSha256 ||
      sourceFrame.evidenceContractSha256 !== result.evidenceContractSha256
    )
      throw new Error('EPISODE_RESULT_SOURCE_FRAME_MISMATCH');
    for (const audit of [result.entryAudit, result.exitAudit].filter(Boolean)) {
      if (
        !verifiedFrameHashes.has(audit!.replayFrameSha256) ||
        audit!.evidenceContractSha256 !== result.evidenceContractSha256 ||
        audit!.intervalCoverageCount !== audit!.intervalCoverageEvidenceSha256s.length ||
        audit!.intervalCoverageEvidenceSha256s.some((hash) => !verifiedIntervalHashes.has(hash))
      )
        throw new Error('EXECUTION_AUDIT_FRAME_OR_INTERVAL_MISMATCH');
    }
    if (result.status === 'CLOSED' && !Number.isFinite(result.netPnlUsdt))
      throw new Error('INVALID_CLOSED_PNL');
    records.set(key, result);
  }
  const summarize = (ids: readonly string[], variant: EpisodeExecution['variant']): Group => {
    const rows = ids.map((id) => records.get(`${variant}:${id}`));
    const closed = rows.filter((r) => r?.status === 'CLOSED');
    const selectionOnly = rows.map((row, index) => ({ row, id: ids[index] }));
    return {
      episodes: ids.length,
      closed: closed.length,
      unknown:
        rows.filter((r) => r && ['UNKNOWN', 'OPEN', 'PENDING'].includes(r.status)).length +
        (variant === 'PULLBACK'
          ? selectionOnly.filter(
              ({ row, id }) => !row && lastSelection.get(id) === 'DATA_UNAVAILABLE',
            ).length
          : 0),
      unfilled: rows.filter((r) => r?.status === 'UNFILLED').length,
      rejected:
        variant === 'PULLBACK'
          ? selectionOnly.filter(
              ({ row, id }) => !row && lastSelection.get(id) === 'STRATEGY_REJECTED',
            ).length
          : 0,
      waiting:
        variant === 'PULLBACK'
          ? selectionOnly.filter(({ row, id }) => !row && lastSelection.get(id) === 'WAITING')
              .length
          : 0,
      noExecutionRecord: selectionOnly.filter(({ row, id }) => {
        if (row) return false;
        if (variant !== 'PULLBACK') return true;
        return !['STRATEGY_REJECTED', 'WAITING', 'DATA_UNAVAILABLE'].includes(
          lastSelection.get(id) ?? 'DATA_UNAVAILABLE',
        );
      }).length,
      meanNetUsdt: closed.length
        ? closed.reduce((sum, r) => sum + r!.netPnlUsdt!, 0) / closed.length
        : null,
    };
  };
  const deltas = [...episodes].flatMap((id) => {
    const current = records.get(`CURRENT:${id}`),
      pullback = records.get(`PULLBACK:${id}`);
    return current?.status === 'CLOSED' && pullback?.status === 'CLOSED'
      ? [pullback.netPnlUsdt! - current.netPnlUsdt!]
      : [];
  });
  const acceptedEpisodes = [...accepted];
  const rejectedEpisodes = [...episodes].filter(
    (id) => !accepted.has(id) && lastSelection.get(id) === 'STRATEGY_REJECTED',
  );
  const unresolvedEpisodes = [...episodes].filter(
    (id) =>
      !accepted.has(id) && ['WAITING', 'DATA_UNAVAILABLE'].includes(lastSelection.get(id) ?? ''),
  );
  const terminal = (
    row: EpisodeExecution | undefined,
    selection?: PullbackObservation['disposition'],
  ): string => {
    if (!row) {
      if (selection === 'STRATEGY_REJECTED') return 'REJECTED_BY_SELECTOR';
      if (selection === 'WAITING') return 'WAITING_AT_END_OF_CAPTURE';
      if (selection === 'DATA_UNAVAILABLE') return 'UNKNOWN_REQUIRED_EVIDENCE';
      if (selection === 'QUALIFIED') return 'INCOMPLETE_NO_EXECUTION_RECORD_AFTER_QUALIFICATION';
      return 'INCOMPLETE_NO_EXECUTION_RECORD';
    }
    if (row.executionKind !== 'MODELLED_BOOK_VWAP_NOT_REAL_FILL')
      throw new Error('NON_MODELLED_EXECUTION_IN_RESEARCH_REPORT');
    if (row.status === 'CLOSED') return 'MODELLED_CLOSED';
    if (row.status === 'UNFILLED') return 'UNFILLED';
    return 'UNKNOWN_OR_INCOMPLETE';
  };
  return {
    authority: 'DESCRIPTIVE_RESEARCH_ONLY',
    resultKind: 'MODELLED_BOOK_VWAP_NOT_REAL_FILL',
    evidenceContractSha256: MICRO_PAIRED_REPLAY_EVIDENCE_CONTRACT_SHA256,
    baselineRejectedObservations,
    independentBaselineEpisodes: episodes.size,
    terminalOutcomes: [...episodes].map((episodeId) => ({
      episodeId,
      current: terminal(records.get(`CURRENT:${episodeId}`)),
      pullback: terminal(records.get(`PULLBACK:${episodeId}`), lastSelection.get(episodeId)),
      pullbackSelection: lastSelection.get(episodeId) ?? 'NO_OBSERVATION',
      executionKind: 'MODELLED_BOOK_VWAP_NOT_REAL_FILL',
    })),
    selection: {
      accepted: summarize(acceptedEpisodes, 'CURRENT'),
      rejected: summarize(rejectedEpisodes, 'CURRENT'),
      unresolved: summarize(unresolvedEpisodes, 'CURRENT'),
    },
    operable: {
      current: summarize([...episodes], 'CURRENT'),
      pullback: summarize([...episodes], 'PULLBACK'),
      pairedClosedEpisodes: deltas.length,
      meanPairedDeltaUsdt: deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : null,
    },
  };
}
