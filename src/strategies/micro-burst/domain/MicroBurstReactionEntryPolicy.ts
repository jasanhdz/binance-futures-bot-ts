import type { Side } from '../../../core/types';
import { hasBtcConflict } from './MicroBurstBtcContext';
import { evaluateMicroBurstEntry } from './MicroBurstEntryPolicy';
import { createMicroBurstEpisodeId } from './MicroBurstIdentity';
import { priceDistanceToBps } from './MicroBurstUnits';
import type {
  MicroBurstConfig,
  MicroBurstContext,
  MicroBurstEntryDecision,
  OrderBookSnapshot,
} from './MicroBurstTypes';

export const MICRO_REACTION_CANDIDATE_VERSION = 'reaction-entry-1-shadow';

/** Observational candidate only. Never routed to the execution port. */
export function evaluateMicroBurstReactionEntry(
  ctx: MicroBurstContext,
  config: MicroBurstConfig,
  book: OrderBookSnapshot | undefined,
  observedAtMs: number,
): MicroBurstEntryDecision {
  const reject = (
    reason: string,
    diagnostics: Record<string, unknown> = {},
  ): MicroBurstEntryDecision => ({
    action: 'NO_TRADE',
    reason,
    confirmationStrength: ctx.momentum.strength,
    diagnostics,
  });
  if (!ctx.dataQuality.contextValid) return reject('REACTION_CONTEXT_INVALID');
  if (
    !Number.isFinite(observedAtMs) ||
    observedAtMs < ctx.timestamp ||
    observedAtMs - ctx.timestamp > config.bookFreshnessMaxMs
  )
    return reject('REACTION_SNAPSHOT_EXPIRED');
  if (
    !book ||
    book.status !== 'HEALTHY' ||
    !Number.isFinite(book.observedAtMs) ||
    book.observedAtMs > observedAtMs ||
    observedAtMs - book.observedAtMs > config.bookFreshnessMaxMs
  )
    return reject('REACTION_BOOK_NOT_FRESH');
  const bid = book.bidDepth[0]?.price;
  const ask = book.askDepth[0]?.price;
  if (
    ![bid, ask].every(Number.isFinite) ||
    !(bid > 0 && ask >= bid) ||
    !(book.bidDepth[0]?.qty > 0 && book.askDepth[0]?.qty > 0) ||
    priceDistanceToBps(bid, ask) > config.bookAnomalySpreadBps
  )
    return reject('REACTION_SPREAD_INVALID');
  const flow = ctx.aggTradeFlow;
  if (
    !flow ||
    !flow.windowComplete ||
    !flow.gapFree ||
    flow.capacityTruncated ||
    !Number.isFinite(flow.netTakerFlow) ||
    flow.tradeCount <= 0 ||
    flow.eventWatermarkMs === null ||
    flow.eventWatermarkMs > observedAtMs ||
    observedAtMs - flow.eventWatermarkMs > config.bookFreshnessMaxMs
  )
    return reject('REACTION_FLOW_UNAVAILABLE');

  const candles = ctx.candles.candles1m.filter((c) => c.closeTime <= ctx.timestamp);
  const latest = candles[candles.length - 1];
  if (!latest || ctx.timestamp - latest.closeTime > config.candleFreshness1mMaxMs)
    return reject('REACTION_CANDLE_UNAVAILABLE');
  const sides: Record<string, unknown> = {};
  const accepted: MicroBurstEntryDecision[] = [];
  for (const side of ['LONG', 'SHORT'] as Side[]) {
    const sign = side === 'LONG' ? 1 : -1;
    const price = side === 'LONG' ? ask : bid;
    const defended = side === 'LONG' ? ctx.levels.nearest.support : ctx.levels.nearest.resistance;
    // Role reversal requires a closed break AFTER the level became available,
    // followed by a different retest candle. Never label the break candle a retest.
    const brokenLevels = ctx.levels.levels.filter(
      (level) =>
        level.type === (side === 'LONG' ? 'resistance' : 'support') &&
        sign * (price - level.price) > 0 &&
        candles.some(
          (c) =>
            c.openTime >= level.availableAtMs &&
            c.closeTime < latest.openTime &&
            sign * (c.open - level.price) <= 0 &&
            sign * (c.close - level.price) > (level.price * config.srClusterToleranceBps) / 10_000,
        ),
    );
    const level = [defended, ...brokenLevels]
      .filter((l): l is NonNullable<typeof l> => !!l)
      .sort((a, b) => Math.abs(price - a.price) - Math.abs(price - b.price))[0];
    const target = side === 'LONG' ? ctx.levels.nearest.resistance : ctx.levels.nearest.support;
    const fail = (reason: string) => {
      sides[side] = { reason };
    };
    if (
      !level ||
      !target ||
      level.availableAtMs > latest.openTime ||
      target.availableAtMs > latest.openTime
    ) {
      fail('REACTION_LEVEL_NOT_CONFIRMED_BEFORE_TRIGGER');
      continue;
    }
    if (
      sign * (price - level.price) <= 0 ||
      priceDistanceToBps(price, level.price) > config.nearLevelThresholdBps
    ) {
      fail('REACTION_NOT_NEAR_LEVEL');
      continue;
    }
    if (ctx.momentum.direction !== side || sign * flow.netTakerFlow <= 0) {
      fail('REACTION_DIRECTION_NOT_CONFIRMED');
      continue;
    }
    const tolerance = (level.price * config.srClusterToleranceBps) / 10_000;
    const visits: { at: number; rejection: number; volume: number }[] = [];
    let visiting = false;
    let broken = false;
    const roleReversed = !!level && brokenLevels.includes(level);
    const breakAt = roleReversed
      ? candles.find(
          (c) =>
            c.openTime >= level.availableAtMs &&
            c.closeTime < latest.openTime &&
            sign * (c.open - level.price) <= 0 &&
            sign * (c.close - level.price) > tolerance,
        )!.closeTime
      : level.availableAtMs;
    for (const candle of candles.filter((c) => c.openTime >= breakAt)) {
      const touches =
        candle.low <= level.price + tolerance && candle.high >= level.price - tolerance;
      const adverseClose = sign * (candle.close - level.price) < -tolerance;
      broken ||= adverseClose;
      if (touches) {
        const rejection = Math.max(
          0,
          ((sign * (candle.close - level.price)) / level.price) * 10_000,
        );
        if (!visiting) visits.push({ at: candle.openTime, rejection, volume: candle.volume });
        else {
          const visit = visits[visits.length - 1];
          visit.rejection = Math.max(visit.rejection, rejection);
          visit.volume += candle.volume;
        }
        visiting = true;
      } else if (sign * (candle.close - level.price) > tolerance) visiting = false;
    }
    const lastVisit = visits[visits.length - 1];
    const touchesNow =
      latest.low <= level.price + tolerance && latest.high >= level.price - tolerance;
    const extreme = side === 'LONG' ? latest.low : latest.high;
    const reclaim = sign * (extreme - level.price) < 0 && sign * (latest.close - level.price) > 0;
    const trend = ctx.microRegime === (side === 'LONG' ? 'TRENDING_UP' : 'TRENDING_DOWN');
    const previous = candles[candles.length - 2];
    const retest =
      trend &&
      !broken &&
      previous &&
      previous.closeTime >= level.availableAtMs &&
      sign * (previous.close - level.price) > tolerance;
    if (
      !touchesNow ||
      sign * (latest.close - latest.open) <= 0 ||
      !lastVisit ||
      (!reclaim && !retest)
    ) {
      fail('REACTION_TRIGGER_MISSING');
      continue;
    }
    const priorVisit = visits[visits.length - 2];
    if (priorVisit && lastVisit.rejection < priorVisit.rejection) {
      fail('REACTION_DEFENSE_DEGRADING');
      continue;
    }
    const setup =
      roleReversed && retest
        ? 'BREAKOUT_RETEST_CONTINUATION'
        : reclaim
          ? 'RECLAIM_REVERSAL'
          : 'TREND_RETEST_CONTINUATION';
    const evaluated = evaluateMicroBurstEntry(
      {
        ...ctx,
        currentPrice: price,
        btcContext: ctx.btcContext
          ? {
              ...ctx.btcContext,
              conflictFlag: hasBtcConflict(side, ctx.btcContext, config.btcConflictThresholdBps),
            }
          : null,
        levels: {
          ...ctx.levels,
          nearest: {
            ...ctx.levels.nearest,
            ...(side === 'LONG' ? { support: level } : { resistance: level }),
            structuralPosition: side === 'LONG' ? 'near_support' : 'near_resistance',
          },
        },
      },
      config,
    );
    if (evaluated.action !== 'ENTRY_INTENT') {
      fail(evaluated.reason);
      continue;
    }
    // The existing 14 bps exit budget is residual round-trip friction after the executable
    // entry quote. Do not add spread again. This is a stress assumption, not paid fees.
    const costs = config.exitEstimatedRoundTripCostBps;
    const boundedTarget = target.price * (1 - (sign * config.exitCostCoverBufferBps) / 10_000);
    const netRoom = ((sign * (boundedTarget - price)) / price) * 10_000 - costs;
    const netRisk = (evaluated.riskToInvalidationBps ?? Infinity) + costs;
    const netRR = netRoom / netRisk;
    const averageVolume = candles.reduce((sum, c) => sum + c.volume, 0) / candles.length;
    const diagnostics = {
      setup,
      independentVisits: visits.length,
      rejectionBps: lastVisit.rejection,
      relativeVisitVolume: averageVolume > 0 ? lastVisit.volume / averageVolume : null,
      netRoomBps: netRoom,
      netRewardRisk: netRR,
      residualCostBps: costs,
      stressedNetRewardRisk: (netRoom - costs) / (netRisk + costs),
      executablePrice: price,
      quantityCoverage: 'TOP_OF_BOOK_ONLY',
      episodeId: createMicroBurstEpisodeId(
        ctx.symbol,
        side,
        lastVisit.at,
        MICRO_REACTION_CANDIDATE_VERSION,
      ),
    };
    if (
      !Number.isFinite(costs) ||
      costs < 0 ||
      !Number.isFinite(netRR) ||
      netRoom < config.minRoomBps ||
      netRR < config.minRewardRisk
    ) {
      sides[side] = { reason: 'REACTION_NET_ROOM_INSUFFICIENT', ...diagnostics };
      continue;
    }
    sides[side] = { reason: 'REACTION_CONFIRMED', ...diagnostics };
    accepted.push({
      ...evaluated,
      targetPrice: boundedTarget,
      reason: 'REACTION_CONFIRMED',
      diagnostics,
    });
  }
  accepted.sort(
    (a, b) => Number(b.diagnostics.netRewardRisk) - Number(a.diagnostics.netRewardRisk),
  );
  return accepted[0]
    ? { ...accepted[0], diagnostics: { ...accepted[0].diagnostics, sides } }
    : reject('REACTION_NO_QUALIFIED_SIDE', { sides });
}
