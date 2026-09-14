import type { Candle, Side } from '../../core/types';
import type {
  MicroBurstContext,
  SupportResistanceLevel,
} from '../../strategies/micro-burst/domain/MicroBurstTypes';

export const MICRO_RESEARCH_PATTERNS = ['MULTI_CANDLE_RECLAIM', 'CONFIRMED_ZONE_DEFENSE'] as const;
export type MicroResearchPattern = (typeof MICRO_RESEARCH_PATTERNS)[number];
export type EpisodeStatus = 'STARTED' | 'CONFIRMED' | 'INVALIDATED' | 'EXPIRED';
export interface PatternEpisode {
  id: string;
  pattern: MicroResearchPattern;
  symbol: string;
  side: Side;
  level: Readonly<SupportResistanceLevel>;
  levelVersionAsOfMs: number;
  tolerancePrice: number;
  startedAtMs: number;
  initiationClosedAtMs: number;
  recoveryAtMs: number | null;
  recoveryClose: number | null;
  confirmedAtMs: number | null;
  invalidatedAtMs: number | null;
  expiredAtMs: number | null;
  status: EpisodeStatus;
  events: { status: EpisodeStatus; atMs: number; observedAtMs: number; reason: string }[];
}

interface Lane {
  last?: Candle;
  episode?: PatternEpisode;
  outsideAtMs?: number;
}

/** Closed-candle price patterns only. They make no claim about order-book absorption.
 * One active episode per symbol/side/pattern. Versions cannot renew a spent episode.
 * Warm-up consumes causal candle/level history; only a newly observed latest close can
 * emit a confirmation for evaluation, never a historical close's executable price.
 */
export class MicroBurstPatternEpisodes {
  readonly episodes: PatternEpisode[] = [];
  private readonly lanes = new Map<string, Lane>();
  private readonly clocks = new Map<string, number>();
  private readonly candleEvidence = new Map<string, Map<number, Candle>>();

  advance(
    ctx: MicroBurstContext,
    toleranceBps: number,
    observedAtMs: number,
    exchangeObservedAtMs: number,
  ): PatternEpisode[] {
    if (
      ![ctx.timestamp, observedAtMs, exchangeObservedAtMs, toleranceBps].every(Number.isFinite) ||
      toleranceBps < 0 ||
      ctx.timestamp > exchangeObservedAtMs ||
      ctx.timestamp < (this.clocks.get(ctx.symbol) ?? -Infinity)
    )
      throw new Error('PATTERN_INVALID_OR_NONMONOTONIC_CLOCK');
    if (!ctx.levels.history) throw new Error('PATTERN_TEMPORAL_LEVEL_HISTORY_REQUIRED');
    if (ctx.candles.candles1m.some((c) => !Number.isFinite(c.closeTime)))
      throw new Error('PATTERN_INVALID_CANDLES');
    const candles = ctx.candles.candles1m.filter((c) => c.closeTime <= ctx.timestamp);
    if (
      candles.some(
        (c, i) =>
          ![c.openTime, c.closeTime, c.open, c.high, c.low, c.close, c.volume].every(
            Number.isFinite,
          ) ||
          ![59_999, 60_000].includes(c.closeTime - c.openTime) ||
          c.low <= 0 ||
          c.volume < 0 ||
          c.high < Math.max(c.open, c.close) ||
          c.low > Math.min(c.open, c.close) ||
          (i > 0 && c.openTime <= candles[i - 1].openTime),
      )
    )
      throw new Error('PATTERN_INVALID_CANDLES');
    if (
      ctx.levels.history?.some(
        (v, i, all) =>
          !Number.isFinite(v.asOfMs) ||
          v.asOfMs > ctx.timestamp ||
          (i > 0 && v.asOfMs <= all[i - 1].asOfMs),
      )
    )
      throw new Error('PATTERN_INVALID_LEVEL_HISTORY');
    const evidence = this.candleEvidence.get(ctx.symbol) ?? new Map<number, Candle>();
    for (const candle of candles) {
      const previous = evidence.get(candle.openTime);
      if (
        previous &&
        ['open', 'high', 'low', 'close', 'closeTime', 'volume'].some(
          (field) => candle[field as keyof Candle] !== previous[field as keyof Candle],
        )
      )
        throw Object.assign(new Error('PATTERN_CLOSED_CANDLE_REVISION'), {
          evidence: { symbol: ctx.symbol, previous, revised: candle },
        });
    }
    for (const candle of candles) evidence.set(candle.openTime, { ...candle });
    this.candleEvidence.set(ctx.symbol, evidence);
    this.clocks.set(ctx.symbol, ctx.timestamp);
    const confirmations: PatternEpisode[] = [];
    for (const pattern of MICRO_RESEARCH_PATTERNS) {
      for (const side of ['LONG', 'SHORT'] as const) {
        const key = `${ctx.symbol}|${side}|${pattern}`;
        const lane = this.lanes.get(key) ?? {};
        this.lanes.set(key, lane);
        const sign = side === 'LONG' ? 1 : -1;
        for (const c of candles) {
          if (lane.last && c.openTime <= lane.last.openTime) continue;
          const gap =
            lane.last !== undefined &&
            (c.openTime !== lane.last.openTime + 60_000 ||
              c.closeTime - c.openTime !== lane.last.closeTime - lane.last.openTime);
          lane.last = { ...c };
          const previous = lane.episode;
          const finish = (
            episode: PatternEpisode,
            status: Exclude<EpisodeStatus, 'STARTED'>,
            atMs: number,
            reason: string,
          ): void => {
            episode.status = status;
            if (status === 'CONFIRMED') episode.confirmedAtMs = atMs;
            if (status === 'INVALIDATED') episode.invalidatedAtMs = atMs;
            if (status === 'EXPIRED') episode.expiredAtMs = atMs;
            episode.events.push({ status, atMs, observedAtMs, reason });
            lane.outsideAtMs = undefined;
          };
          if (previous?.status === 'STARTED') {
            const distance = sign * (c.close - previous.level.price);
            const deadline = previous.initiationClosedAtMs + 180_000;
            // Within the window invalidation precedes all other transitions. A candle
            // after close3 cannot change an episode that already expired at close3.
            if (c.closeTime > deadline) {
              finish(previous, 'EXPIRED', deadline, 'CONFIRMATION_WINDOW_ELAPSED');
            } else if (sign * c.close <= sign * previous.level.price - previous.tolerancePrice) {
              finish(previous, 'INVALIDATED', c.closeTime, 'ADVERSE_EDGE_CLOSE');
            } else if (gap) {
              finish(previous, 'INVALIDATED', c.closeTime, 'MISSING_CANDLE_CONTINUITY');
            } else {
              const confirm =
                pattern === 'CONFIRMED_ZONE_DEFENSE'
                  ? sign * c.close > sign * previous.level.price + previous.tolerancePrice
                  : previous.recoveryAtMs !== null &&
                    c.closeTime > previous.recoveryAtMs &&
                    distance > 0 &&
                    sign * (c.close - previous.recoveryClose!) > 0;
              if (confirm) {
                finish(
                  previous,
                  'CONFIRMED',
                  c.closeTime,
                  pattern === 'CONFIRMED_ZONE_DEFENSE'
                    ? 'LATER_CLOSE_BEYOND_FAVORABLE_EDGE'
                    : 'DISTINCT_LATER_CLOSE_IMPROVES_RECOVERY_AND_HOLDS_CENTER',
                );
                if (c.closeTime === candles[candles.length - 1]?.closeTime)
                  confirmations.push(previous);
              } else if (c.closeTime === deadline) {
                finish(previous, 'EXPIRED', deadline, 'NO_CONFIRMATION_BY_CLOSE_3');
              } else if (
                pattern === 'MULTI_CANDLE_RECLAIM' &&
                previous.recoveryAtMs === null &&
                distance > 0
              ) {
                previous.recoveryAtMs = c.closeTime;
                previous.recoveryClose = c.close;
              }
            }
            // Restart requires an outside close strictly AFTER the terminal candle.
            continue;
          }
          if (previous) {
            const endedAtMs =
              previous.confirmedAtMs ?? previous.invalidatedAtMs ?? previous.expiredAtMs!;
            if (c.closeTime <= endedAtMs) continue;
            if (gap) lane.outsideAtMs = undefined;
            if (lane.outsideAtMs === undefined) {
              if (sign * c.close > sign * previous.level.price + previous.tolerancePrice)
                lane.outsideAtMs = c.closeTime;
              continue;
            }
            if (c.openTime < lane.outsideAtMs) continue;
          }
          const history = ctx.levels.history?.filter((v) => v.asOfMs <= c.openTime);
          const version = history?.[history.length - 1];
          const pool = version?.levels ?? [];
          const candidates = pool
            .filter((l) => {
              const tolerance = (l.price * toleranceBps) / 10_000;
              return (
                l.type === (side === 'LONG' ? 'support' : 'resistance') &&
                Number.isFinite(l.price) &&
                l.price > 0 &&
                Number.isFinite(l.availableAtMs) &&
                l.availableAtMs > 0 &&
                l.availableAtMs <= version!.asOfMs &&
                l.availableAtMs <= c.openTime &&
                c.low <= l.price + tolerance &&
                c.high >= l.price - tolerance &&
                (pattern !== 'MULTI_CANDLE_RECLAIM' ||
                  sign * ((side === 'LONG' ? c.low : c.high) - l.price) < 0)
              );
            })
            .sort(
              (a, b) =>
                Math.abs(c.close - a.price) - Math.abs(c.close - b.price) ||
                a.availableAtMs - b.availableAtMs ||
                a.price - b.price,
            );
          const level = candidates[0];
          if (!level) continue;
          const episode: PatternEpisode = {
            id: [
              ctx.symbol,
              side,
              pattern,
              level.type,
              level.price,
              level.availableAtMs,
              version!.asOfMs,
              c.openTime,
            ].join('|'),
            symbol: ctx.symbol,
            side,
            pattern,
            level: Object.freeze({ ...level }),
            levelVersionAsOfMs: version!.asOfMs,
            tolerancePrice: (level.price * toleranceBps) / 10_000,
            startedAtMs: c.openTime,
            initiationClosedAtMs: c.closeTime,
            recoveryAtMs: null,
            recoveryClose: null,
            confirmedAtMs: null,
            invalidatedAtMs: null,
            expiredAtMs: null,
            status: 'STARTED',
            events: [
              {
                status: 'STARTED',
                atMs: c.openTime,
                observedAtMs,
                reason: pattern === 'MULTI_CANDLE_RECLAIM' ? 'CENTRAL_PENETRATION' : 'ZONE_TOUCH',
              },
            ],
          };
          lane.episode = episode;
          lane.outsideAtMs = undefined;
          this.episodes.push(episode);
          if (sign * c.close <= sign * level.price - episode.tolerancePrice)
            finish(episode, 'INVALIDATED', c.closeTime, 'ADVERSE_EDGE_CLOSE');
        }
        const active = lane.episode;
        if (
          active?.status === 'STARTED' &&
          ctx.timestamp >= active.initiationClosedAtMs + 180_000
        ) {
          active.status = 'EXPIRED';
          active.expiredAtMs = active.initiationClosedAtMs + 180_000;
          active.events.push({
            status: 'EXPIRED',
            atMs: active.expiredAtMs,
            observedAtMs,
            reason: 'DEADLINE_REACHED_WITH_MISSING_CLOSED_CANDLES',
          });
          lane.outsideAtMs = undefined;
        }
      }
    }
    return confirmations;
  }
}
