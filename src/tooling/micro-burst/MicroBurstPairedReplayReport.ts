import type { EpisodeExecution, PairedReplayFrame } from './MicroBurstPairedExecutionReplay';

export interface PairedReplayReport {
  authority: 'DESCRIPTIVE_RESEARCH_ONLY';
  resultKind: 'MODELLED_BOOK_VWAP_NOT_REAL_FILL';
  selection: { accepted: Group; rejected: Group };
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
    executionKind: 'MODELLED_BOOK_VWAP_NOT_REAL_FILL';
  }[];
}
interface Group {
  episodes: number;
  closed: number;
  unknown: number;
  unfilled: number;
  noExecutionRecord: number;
  meanNetUsdt: number | null;
}

/** Selection buckets use CURRENT outcomes in both groups; execution comparison uses own fills.
 * Descriptive conditioning on eventual qualification is not an implementable early selection rule.
 */
export function summarizePairedReplay(
  frames: readonly PairedReplayFrame[],
  results: readonly EpisodeExecution[],
): PairedReplayReport {
  const episodes = new Set<string>();
  const accepted = new Set<string>();
  let baselineRejectedObservations = 0;
  for (const frame of frames) {
    const baseline = frame.observation.baseline;
    if (baseline.action !== 'ENTRY_INTENT') {
      baselineRejectedObservations++;
      continue;
    }
    const id = baseline.diagnostics.episodeId;
    if (typeof id !== 'string') continue;
    episodes.add(id);
    if (frame.observation.candidate === 'QUALIFIED') accepted.add(id);
  }
  const records = new Map<string, EpisodeExecution>();
  for (const result of results) {
    const key = `${result.variant}:${result.episodeId}`;
    if (records.has(key)) throw new Error('DUPLICATE_EPISODE_EXECUTION');
    if (result.status === 'CLOSED' && !Number.isFinite(result.netPnlUsdt))
      throw new Error('INVALID_CLOSED_PNL');
    records.set(key, result);
  }
  const summarize = (ids: readonly string[], variant: EpisodeExecution['variant']): Group => {
    const rows = ids.map((id) => records.get(`${variant}:${id}`));
    const closed = rows.filter((r) => r?.status === 'CLOSED');
    return {
      episodes: ids.length,
      closed: closed.length,
      unknown: rows.filter((r) => r && ['UNKNOWN', 'OPEN', 'PENDING'].includes(r.status)).length,
      unfilled: rows.filter((r) => r?.status === 'UNFILLED').length,
      noExecutionRecord: rows.filter((r) => !r).length,
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
  const terminal = (row: EpisodeExecution | undefined): string => {
    if (!row) return 'INCOMPLETE_NO_EXECUTION_RECORD';
    if (row.executionKind !== 'MODELLED_BOOK_VWAP_NOT_REAL_FILL')
      throw new Error('NON_MODELLED_EXECUTION_IN_RESEARCH_REPORT');
    if (row.status === 'CLOSED') return 'MODELLED_CLOSED';
    if (row.status === 'UNFILLED') return 'UNFILLED';
    return 'UNKNOWN_OR_INCOMPLETE';
  };
  return {
    authority: 'DESCRIPTIVE_RESEARCH_ONLY',
    resultKind: 'MODELLED_BOOK_VWAP_NOT_REAL_FILL',
    baselineRejectedObservations,
    independentBaselineEpisodes: episodes.size,
    terminalOutcomes: [...episodes].map((episodeId) => ({
      episodeId,
      current: terminal(records.get(`CURRENT:${episodeId}`)),
      pullback: terminal(records.get(`PULLBACK:${episodeId}`)),
      executionKind: 'MODELLED_BOOK_VWAP_NOT_REAL_FILL',
    })),
    selection: {
      accepted: summarize([...accepted], 'CURRENT'),
      rejected: summarize(
        [...episodes].filter((id) => !accepted.has(id)),
        'CURRENT',
      ),
    },
    operable: {
      current: summarize([...episodes], 'CURRENT'),
      pullback: summarize([...accepted], 'PULLBACK'),
      pairedClosedEpisodes: deltas.length,
      meanPairedDeltaUsdt: deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : null,
    },
  };
}
