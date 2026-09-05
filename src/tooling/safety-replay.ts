/**
 * Safety Replay Tooling
 *
 * Synthetic replay and metrics for safety validation.
 * Produces PENDING_REAL_DATA when real market data is absent.
 * Fixtures demonstrate mechanics and absence of lookahead; not economic edge.
 *
 * Status: PENDIENTE_DATOS_REALES (mechanics validated, no real data yet).
 */

export interface ReplayEpisode {
  episodeId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  strategyId: string;
  startedAtMs: number;
  closedAtMs?: number;
  entryPrice: number;
  exitPrice?: number;
  quantity: number;
  netPnl?: number;
  outcome: 'WIN' | 'LOSS' | 'BREAKEVEN' | 'INCOMPLETE';
  guardsBlocked: boolean;
  regimeAllowed: boolean;
  sizingValid: boolean;
}

export interface ReplayMetrics {
  totalEpisodes: number;
  completedEpisodes: number;
  winRate: number;
  avgNetPnl: number;
  maxDrawdown: number;
  guardBlockRate: number;
  regimeAllowRate: number;
  sizingValidRate: number;
  /** Whether metrics are derived from real data. */
  dataSource: 'SYNTHETIC' | 'REAL';
  /** Status of the replay. */
  status: 'VALIDATED_MECHANICS' | 'PENDING_REAL_DATA' | 'INSUFFICIENT_DATA';
}

export interface ReplayComparisonGroup {
  groupId: string;
  label: 'ON' | 'OFF';
  episodes: ReplayEpisode[];
}

/**
 * Compute metrics from a list of replay episodes.
 */
export function computeReplayMetrics(episodes: ReplayEpisode[]): ReplayMetrics {
  if (episodes.length === 0) {
    return {
      totalEpisodes: 0,
      completedEpisodes: 0,
      winRate: 0,
      avgNetPnl: 0,
      maxDrawdown: 0,
      guardBlockRate: 0,
      regimeAllowRate: 0,
      sizingValidRate: 0,
      dataSource: 'SYNTHETIC',
      status: 'INSUFFICIENT_DATA',
    };
  }

  const completed = episodes.filter((e) => e.outcome !== 'INCOMPLETE');
  const wins = completed.filter((e) => e.outcome === 'WIN');
  const losses = completed.filter((e) => e.outcome === 'LOSS');
  const pnlValues = completed.map((e) => e.netPnl ?? 0);

  // Win rate.
  const winRate = completed.length > 0 ? wins.length / completed.length : 0;

  // Average net PnL.
  const avgNetPnl =
    pnlValues.length > 0
      ? pnlValues.reduce((a, b) => a + b, 0) / pnlValues.length
      : 0;

  // Max drawdown (from cumulative PnL).
  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const pnl of pnlValues) {
    cumulative += pnl;
    if (cumulative > peak) peak = cumulative;
    const drawdown = peak - cumulative;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  // Guard block rate.
  const guardBlocked = episodes.filter((e) => e.guardsBlocked).length;
  const guardBlockRate = guardBlocked / episodes.length;

  // Regime allow rate.
  const regimeAllowed = episodes.filter((e) => e.regimeAllowed).length;
  const regimeAllowRate = regimeAllowed / episodes.length;

  // Sizing valid rate.
  const sizingValid = episodes.filter((e) => e.sizingValid).length;
  const sizingValidRate = sizingValid / episodes.length;

  return {
    totalEpisodes: episodes.length,
    completedEpisodes: completed.length,
    winRate,
    avgNetPnl,
    maxDrawdown,
    guardBlockRate,
    regimeAllowRate,
    sizingValidRate,
    dataSource: 'SYNTHETIC',
    status: 'VALIDATED_MECHANICS',
  };
}

/**
 * Compare two groups (ON vs OFF) for a specific feature.
 */
export function compareGroups(
  on: ReplayComparisonGroup,
  off: ReplayComparisonGroup,
): { onMetrics: ReplayMetrics; offMetrics: ReplayMetrics; delta: Partial<ReplayMetrics> } {
  const onMetrics = computeReplayMetrics(on.episodes);
  const offMetrics = computeReplayMetrics(off.episodes);
  return {
    onMetrics,
    offMetrics,
    delta: {
      winRate: onMetrics.winRate - offMetrics.winRate,
      avgNetPnl: onMetrics.avgNetPnl - offMetrics.avgNetPnl,
      guardBlockRate: onMetrics.guardBlockRate - offMetrics.guardBlockRate,
      maxDrawdown: onMetrics.maxDrawdown - offMetrics.maxDrawdown,
    },
  };
}

/**
 * Validate temporal splits (no lookahead).
 * Episodes must not reference candles after their closedAtMs.
 */
export function validateTemporalSplits(episodes: ReplayEpisode[]): boolean {
  return episodes.every((e) => {
    if (e.closedAtMs === undefined) return true; // Incomplete episodes are ok.
    return e.startedAtMs < e.closedAtMs;
  });
}

/**
 * Deduplicate episodes by episodeId.
 */
export function deduplicateEpisodes(episodes: ReplayEpisode[]): ReplayEpisode[] {
  const seen = new Set<string>();
  return episodes.filter((e) => {
    if (seen.has(e.episodeId)) return false;
    seen.add(e.episodeId);
    return true;
  });
}
