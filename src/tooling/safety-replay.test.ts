import { describe, expect, it } from 'vitest';
import {
  computeReplayMetrics,
  compareGroups,
  validateTemporalSplits,
  deduplicateEpisodes,
  ReplayEpisode,
} from './safety-replay';

function makeEpisode(overrides: Partial<ReplayEpisode> = {}): ReplayEpisode {
  return {
    episodeId: 'EP-1',
    symbol: 'XRPUSDT',
    side: 'LONG',
    strategyId: 'MICRO_BURST_V1',
    startedAtMs: 1_700_000_000_000,
    closedAtMs: 1_700_001_000_000,
    entryPrice: 1.0,
    exitPrice: 1.1,
    quantity: 100,
    netPnl: 10,
    outcome: 'WIN',
    guardsBlocked: false,
    regimeAllowed: true,
    sizingValid: true,
    ...overrides,
  };
}

describe('computeReplayMetrics', () => {
  it('returns INSUFFICIENT_DATA for empty episodes', () => {
    const metrics = computeReplayMetrics([]);
    expect(metrics.status).toBe('INSUFFICIENT_DATA');
    expect(metrics.totalEpisodes).toBe(0);
  });

  it('computes win rate and avgNetPnl', () => {
    const episodes = [
      makeEpisode({ episodeId: 'EP-1', outcome: 'WIN', netPnl: 10 }),
      makeEpisode({ episodeId: 'EP-2', outcome: 'LOSS', netPnl: -5 }),
      makeEpisode({ episodeId: 'EP-3', outcome: 'WIN', netPnl: 8 }),
    ];
    const metrics = computeReplayMetrics(episodes);
    expect(metrics.totalEpisodes).toBe(3);
    expect(metrics.completedEpisodes).toBe(3);
    expect(metrics.winRate).toBeCloseTo(2 / 3);
    expect(metrics.avgNetPnl).toBeCloseTo((10 - 5 + 8) / 3);
    expect(metrics.dataSource).toBe('SYNTHETIC');
    expect(metrics.status).toBe('VALIDATED_MECHANICS');
  });

  it('computes max drawdown from cumulative PnL', () => {
    const episodes = [
      makeEpisode({ episodeId: 'EP-1', outcome: 'WIN', netPnl: 10 }),
      makeEpisode({ episodeId: 'EP-2', outcome: 'LOSS', netPnl: -15 }),
      makeEpisode({ episodeId: 'EP-3', outcome: 'WIN', netPnl: 20 }),
    ];
    const metrics = computeReplayMetrics(episodes);
    // Cumulative: 10, -5, 15. Peak: 10, then 15.
    // Drawdowns: 0, 15, 0. Max = 15.
    expect(metrics.maxDrawdown).toBeCloseTo(15);
  });

  it('computes guard block rate', () => {
    const episodes = [
      makeEpisode({ episodeId: 'EP-1', guardsBlocked: true }),
      makeEpisode({ episodeId: 'EP-2', guardsBlocked: false }),
      makeEpisode({ episodeId: 'EP-3', guardsBlocked: true }),
    ];
    const metrics = computeReplayMetrics(episodes);
    expect(metrics.guardBlockRate).toBeCloseTo(2 / 3);
  });

  it('computes regime allow rate', () => {
    const episodes = [
      makeEpisode({ episodeId: 'EP-1', regimeAllowed: true }),
      makeEpisode({ episodeId: 'EP-2', regimeAllowed: false }),
    ];
    const metrics = computeReplayMetrics(episodes);
    expect(metrics.regimeAllowRate).toBe(0.5);
  });

  it('computes sizing valid rate', () => {
    const episodes = [
      makeEpisode({ episodeId: 'EP-1', sizingValid: true }),
      makeEpisode({ episodeId: 'EP-2', sizingValid: false }),
    ];
    const metrics = computeReplayMetrics(episodes);
    expect(metrics.sizingValidRate).toBe(0.5);
  });

  it('excludes INCOMPLETE episodes from completed count', () => {
    const episodes = [
      makeEpisode({ episodeId: 'EP-1', outcome: 'WIN', netPnl: 10 }),
      makeEpisode({ episodeId: 'EP-2', outcome: 'INCOMPLETE', closedAtMs: undefined, netPnl: undefined }),
    ];
    const metrics = computeReplayMetrics(episodes);
    expect(metrics.totalEpisodes).toBe(2);
    expect(metrics.completedEpisodes).toBe(1);
  });

  it('handles all BREAKEVEN episodes', () => {
    const episodes = [
      makeEpisode({ episodeId: 'EP-1', outcome: 'BREAKEVEN', netPnl: 0 }),
      makeEpisode({ episodeId: 'EP-2', outcome: 'BREAKEVEN', netPnl: 0 }),
    ];
    const metrics = computeReplayMetrics(episodes);
    expect(metrics.winRate).toBe(0);
    expect(metrics.avgNetPnl).toBeCloseTo(0);
  });
});

describe('compareGroups', () => {
  it('compares ON vs OFF groups', () => {
    const on = {
      groupId: 'ON',
      label: 'ON' as const,
      episodes: [
        makeEpisode({ episodeId: 'ON-1', outcome: 'WIN', netPnl: 15, guardsBlocked: false }),
        makeEpisode({ episodeId: 'ON-2', outcome: 'WIN', netPnl: 10, guardsBlocked: false }),
      ],
    };
    const off = {
      groupId: 'OFF',
      label: 'OFF' as const,
      episodes: [
        makeEpisode({ episodeId: 'OFF-1', outcome: 'WIN', netPnl: 8, guardsBlocked: false }),
        makeEpisode({ episodeId: 'OFF-2', outcome: 'LOSS', netPnl: -5, guardsBlocked: false }),
      ],
    };
    const result = compareGroups(on, off);
    expect(result.onMetrics.winRate).toBe(1);
    expect(result.offMetrics.winRate).toBe(0.5);
    expect(result.delta.winRate).toBeCloseTo(0.5);
    expect(result.delta.avgNetPnl).toBeCloseTo(12.5 - 1.5); // (15+10)/2 - (8-5)/2
  });
});

describe('validateTemporalSplits', () => {
  it('returns true for valid temporal splits', () => {
    const episodes = [
      makeEpisode({ episodeId: 'EP-1', startedAtMs: 100, closedAtMs: 200 }),
      makeEpisode({ episodeId: 'EP-2', startedAtMs: 300, closedAtMs: 400 }),
    ];
    expect(validateTemporalSplits(episodes)).toBe(true);
  });

  it('returns false when startedAtMs >= closedAtMs', () => {
    const episodes = [
      makeEpisode({ episodeId: 'EP-1', startedAtMs: 200, closedAtMs: 100 }),
    ];
    expect(validateTemporalSplits(episodes)).toBe(false);
  });

  it('allows incomplete episodes (no closedAtMs)', () => {
    const episodes = [
      makeEpisode({ episodeId: 'EP-1', closedAtMs: undefined }),
    ];
    expect(validateTemporalSplits(episodes)).toBe(true);
  });
});

describe('deduplicateEpisodes', () => {
  it('deduplicates by episodeId', () => {
    const episodes = [
      makeEpisode({ episodeId: 'EP-1' }),
      makeEpisode({ episodeId: 'EP-2' }),
      makeEpisode({ episodeId: 'EP-1' }),
    ];
    const result = deduplicateEpisodes(episodes);
    expect(result).toHaveLength(2);
    expect(result.map((e) => e.episodeId)).toEqual(['EP-1', 'EP-2']);
  });

  it('returns empty array for empty input', () => {
    expect(deduplicateEpisodes([])).toEqual([]);
  });

  it('preserves order of first occurrence', () => {
    const episodes = [
      makeEpisode({ episodeId: 'B' }),
      makeEpisode({ episodeId: 'A' }),
      makeEpisode({ episodeId: 'B' }),
    ];
    const result = deduplicateEpisodes(episodes);
    expect(result.map((e) => e.episodeId)).toEqual(['B', 'A']);
  });
});
