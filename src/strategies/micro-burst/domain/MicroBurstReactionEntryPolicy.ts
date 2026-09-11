import type { Side } from '../../../core/types';
import { hasBtcConflict } from './MicroBurstBtcContext';
import { evaluateMicroBurstStructuralEntry } from './MicroBurstEntryPolicy';
import { createMicroBurstEpisodeId } from './MicroBurstIdentity';
import { priceDistanceToBps } from './MicroBurstUnits';
import { validMicroBurstContextualConfig } from './MicroBurstTypes';
import type {
  MicroBurstConfig,
  MicroBurstContext,
  MicroBurstEntryDecision,
  OrderBookSnapshot,
} from './MicroBurstTypes';

/** The current Micro entry algorithm; execution admission remains separate. */
export function evaluateMicroBurstReactionEntry(
  ctx: MicroBurstContext,
  config: MicroBurstConfig,
  book: OrderBookSnapshot | undefined,
  observedAtMs: number,
  exchangeObservedAtMs: number = observedAtMs,
): MicroBurstEntryDecision {
  const commonStagesVisited: string[] = [];
  config = {
    ...config,
    maxLeverageHardCap: Math.min(config.maxLeverageHardCap, 30),
    leverageTiers: {
      high: { ...config.leverageTiers.high, leverage: 30 },
      medium: { ...config.leverageTiers.medium, leverage: 20 },
    },
  };
  const reject = (
    reason: string,
    diagnostics: Record<string, unknown> = {},
  ): MicroBurstEntryDecision => ({
    action: 'NO_TRADE',
    reason,
    confirmationStrength: ctx.momentum.strength,
    diagnostics: {
      commonStagesVisited: commonStagesVisited.slice(),
      sides: { LONG: { reason, commonGuard: true }, SHORT: { reason, commonGuard: true } },
      ...diagnostics,
    },
  });
  commonStagesVisited.push('CONFIG');
  if (!validMicroBurstContextualConfig(config)) return reject('REACTION_CONFIG_INVALID');
  commonStagesVisited.push('CONTEXT_QUALITY');
  if (!ctx.dataQuality.contextValid)
    return reject('REACTION_CONTEXT_INVALID', {
      invalidReasons: ctx.dataQuality.invalidReasons.slice(0, 20),
    });
  commonStagesVisited.push('BOOK_HEALTH');
  if (ctx.bookPressure.status !== 'HEALTHY' || ctx.bookPressure.anomalyFlag)
    return reject('BOOK_NOT_HEALTHY');
  commonStagesVisited.push('BTC_EVENT_FRESHNESS');
  if (
    !ctx.btcContext ||
    !Number.isFinite(ctx.btcContext.observedAtMs) ||
    !Number.isFinite(exchangeObservedAtMs) ||
    ctx.btcContext.observedAtMs > exchangeObservedAtMs ||
    exchangeObservedAtMs - ctx.btcContext.observedAtMs > config.btcFreshnessMaxMs
  )
    return reject('BTC_UNAVAILABLE');
  commonStagesVisited.push('SNAPSHOT_FRESHNESS');
  if (
    !Number.isFinite(observedAtMs) ||
    exchangeObservedAtMs < ctx.timestamp ||
    exchangeObservedAtMs - ctx.timestamp > config.bookFreshnessMaxMs
  )
    return reject('REACTION_SNAPSHOT_EXPIRED');
  commonStagesVisited.push('EXECUTION_BOOK_FRESHNESS');
  if (
    !book ||
    book.status !== 'HEALTHY' ||
    !Number.isFinite(book.observedAtMs) ||
    book.observedAtMs > observedAtMs ||
    observedAtMs - book.observedAtMs > config.bookFreshnessMaxMs
  )
    return reject('REACTION_BOOK_NOT_FRESH');
  commonStagesVisited.push('EXECUTABLE_SPREAD');
  const bid = book.bidDepth[0]?.price;
  const ask = book.askDepth[0]?.price;
  if (
    ![bid, ask].every(Number.isFinite) ||
    !(bid > 0 && ask >= bid) ||
    !(book.bidDepth[0]?.qty > 0 && book.askDepth[0]?.qty > 0) ||
    priceDistanceToBps(bid, ask) > config.bookAnomalySpreadBps
  )
    return reject('REACTION_SPREAD_INVALID');
  commonStagesVisited.push('FLOW');
  const flow = ctx.aggTradeFlow;
  if (
    !flow ||
    !flow.windowComplete ||
    !flow.gapFree ||
    flow.capacityTruncated ||
    !Number.isFinite(flow.netTakerFlow) ||
    ![flow.tradeCount, flow.eventWatermarkMs, flow.buyTakerVolume, flow.sellTakerVolume].every(
      (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0,
    ) ||
    flow.tradeCount <= 0 ||
    flow.eventWatermarkMs === null ||
    flow.eventWatermarkMs > exchangeObservedAtMs ||
    exchangeObservedAtMs - flow.eventWatermarkMs > config.bookFreshnessMaxMs
  )
    return reject('REACTION_FLOW_UNAVAILABLE');

  commonStagesVisited.push('CANDLE_INTEGRITY');
  const candles = ctx.candles.candles1m.filter((c) => c.closeTime <= ctx.timestamp);
  if (
    candles.some(
      (c, i) =>
        ![c.openTime, c.closeTime, c.open, c.high, c.low, c.close, c.volume].every(
          Number.isFinite,
        ) ||
        c.openTime >= c.closeTime ||
        c.volume < 0 ||
        c.low <= 0 ||
        c.high < Math.max(c.open, c.close) ||
        c.low > Math.min(c.open, c.close) ||
        (i > 0 && c.openTime < candles[i - 1].closeTime),
    )
  )
    return reject('REACTION_CANDLE_INVALID');
  commonStagesVisited.push('CANDLE_FRESHNESS');
  const latest = candles[candles.length - 1];
  if (!latest || ctx.timestamp - latest.closeTime > config.candleFreshness1mMaxMs)
    return reject('REACTION_CANDLE_UNAVAILABLE');
  commonStagesVisited.push('LEVEL_INPUT_BOUND');
  if (
    ctx.levels.levels.length > config.srLookbackBars * 2 ||
    (ctx.levels.history?.length ?? 0) > config.srLookbackBars ||
    ctx.levels.history?.some((version) => version.levels.length > config.srLookbackBars * 2)
  )
    return reject('REACTION_LEVEL_INPUT_LIMIT');
  const sides: Record<string, unknown> = {};
  const accepted: MicroBurstEntryDecision[] = [];
  sideLoop: for (const side of ['LONG', 'SHORT'] as Side[]) {
    const sign = side === 'LONG' ? 1 : -1;
    const price = side === 'LONG' ? ask : bid;
    const history = ctx.levels.history?.filter((version) => version.asOfMs <= latest.openTime);
    const defenseLevels = history?.length ? history[history.length - 1].levels : ctx.levels.levels;
    const defendedType = side === 'LONG' ? 'support' : 'resistance';
    const targetType = side === 'LONG' ? 'resistance' : 'support';
    // Legacy nearest values are included for old callers; live contexts supply the full list.
    const allLevels = [
      ...ctx.levels.levels,
      ctx.levels.nearest.support,
      ctx.levels.nearest.resistance,
    ].filter((l): l is NonNullable<typeof l> => !!l);
    const defensePool = [
      ...defenseLevels,
      ...(ctx.levels.history ? [] : [ctx.levels.nearest.support, ctx.levels.nearest.resistance]),
    ].filter((l): l is NonNullable<typeof l> => !!l);
    // Role reversal requires a closed break AFTER the level became available,
    // followed by a different retest candle. Never label the break candle a retest.
    const brokenLevels = defensePool.filter(
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
    const candidates = [...defensePool.filter((l) => l.type === defendedType), ...brokenLevels]
      .filter(
        (l, i, list) =>
          list.findIndex(
            (other) =>
              other.type === l.type &&
              other.price === l.price &&
              other.availableAtMs === l.availableAtMs,
          ) === i,
      )
      .sort(
        (a, b) =>
          Math.abs(price - a.price) - Math.abs(price - b.price) ||
          a.availableAtMs - b.availableAtMs ||
          a.type.localeCompare(b.type),
      );
    // Pick the closest currently confirmed obstacle FIRST, then check trigger availability.
    // A newly confirmed blocking level cannot be skipped to improve reward/risk.
    const target = allLevels
      .filter(
        (l) =>
          l.type === targetType &&
          Number.isFinite(l.price) &&
          l.price > 0 &&
          Number.isFinite(l.availableAtMs) &&
          l.availableAtMs <= ctx.timestamp &&
          sign * (l.price - price) > 0,
      )
      .sort((a, b) => sign * (a.price - b.price) || a.availableAtMs - b.availableAtMs)[0];
    const attempts: Record<string, unknown>[] = [];
    const referenceTarget = ctx.levels.nearest[targetType];
    const targetSelection = {
      executablePrice: price,
      referenceTargetPrice: referenceTarget?.price ?? null,
      referenceTargetCrossed: referenceTarget ? sign * (referenceTarget.price - price) <= 0 : null,
      rule: 'CLOSEST_CURRENTLY_CONFIRMED_OPPOSING_LEVEL_THEN_TRIGGER_AVAILABILITY',
    };
    let setup: string | undefined;
    let stagesVisited = ['LEVEL_SELECTION'];
    let candidate: unknown = null;
    const fail = (reason: string, extra?: Record<string, unknown>) => {
      const attempt = {
        reason,
        firstReject: reason === 'REACTION_CONFIRMED' ? null : reason,
        stagesVisited: stagesVisited.slice(),
        candidate,
        selectedTarget: target ?? null,
        targetSelection,
        ...(setup ? { setup } : {}),
        ...extra,
      };
      attempts.push(attempt);
      sides[side] = {
        ...attempt,
        firstCandidateReject:
          attempts.find((item) => item.reason !== 'REACTION_CONFIRMED')?.reason ?? null,
        candidatesVisited: attempts.slice(),
      };
    };
    if (!candidates.length || !target) {
      fail('REACTION_LEVEL_NOT_CONFIRMED_BEFORE_TRIGGER', {
        detail: !candidates.length
          ? 'DEFENSE_ABSENT'
          : allLevels.some(
                (l) =>
                  l.type === targetType &&
                  sign * (l.price - price) > 0 &&
                  l.availableAtMs > ctx.timestamp,
              )
            ? 'TARGET_PRESENT_NOT_AVAILABLE_AT_DECISION'
            : targetSelection.referenceTargetCrossed
              ? 'TARGET_CROSSED_NO_NEXT_CONFIRMED'
              : 'TARGET_ABSENT_AHEAD_OF_EXECUTABLE',
        support: ctx.levels.nearest.support?.price ?? null,
        resistance: ctx.levels.nearest.resistance?.price ?? null,
        executablePrice: price,
      });
      continue;
    }
    if (target.availableAtMs > latest.openTime) {
      fail('REACTION_LEVEL_NOT_CONFIRMED_BEFORE_TRIGGER', {
        detail: 'CLOSEST_TARGET_UNAVAILABLE_BEFORE_TRIGGER',
        target,
      });
      continue;
    }
    for (const level of candidates) {
      setup = undefined;
      candidate = level;
      stagesVisited = ['LEVEL_SELECTION', 'TRIGGER_AVAILABILITY'];
      if (
        !level ||
        !target ||
        ![level.price, target.price, level.availableAtMs, target.availableAtMs].every(
          (v) => Number.isFinite(v) && v > 0,
        ) ||
        level.availableAtMs > latest.openTime ||
        target.availableAtMs > latest.openTime
      ) {
        fail('REACTION_LEVEL_NOT_CONFIRMED_BEFORE_TRIGGER', {
          detail: ![level.price, level.availableAtMs].every((v) => Number.isFinite(v) && v > 0)
            ? 'DEFENSE_INVALID'
            : 'DEFENSE_PRESENT_NOT_AVAILABLE_BEFORE_TRIGGER',
          level,
          support: ctx.levels.nearest.support?.price ?? null,
          resistance: ctx.levels.nearest.resistance?.price ?? null,
        });
        continue;
      }
      stagesVisited.push('DEFENSE_PROXIMITY');
      if (
        sign * (price - level.price) <= 0 ||
        priceDistanceToBps(price, level.price) > config.nearLevelThresholdBps
      ) {
        fail('REACTION_NOT_NEAR_LEVEL', {
          detail: sign * (price - level.price) <= 0 ? 'WRONG_SIDE_OR_EQUAL' : 'TOO_FAR',
          levelPrice: level.price,
          distanceBps: priceDistanceToBps(price, level.price),
          maxBps: config.nearLevelThresholdBps,
        });
        continue;
      }
      stagesVisited.push('DIRECTION_AND_FLOW');
      if (ctx.momentum.direction !== side || sign * flow.netTakerFlow <= 0) {
        fail('REACTION_DIRECTION_NOT_CONFIRMED', {
          momentumDir: ctx.momentum.direction,
          netFlow: flow.netTakerFlow,
        });
        continue sideLoop;
      }
      stagesVisited.push('TRIGGER');
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
        fail('REACTION_TRIGGER_MISSING', {
          touchesNow,
          candleDirection: sign * (latest.close - latest.open) > 0 ? 'favorable' : 'adverse',
          hasReclaim: reclaim,
          hasRetest: retest,
          regime: ctx.microRegime,
          visitsCount: visits.length,
        });
        continue;
      }
      setup =
        roleReversed && retest
          ? 'BREAKOUT_RETEST_CONTINUATION'
          : reclaim
            ? 'RECLAIM_REVERSAL'
            : 'TREND_RETEST_CONTINUATION';
      stagesVisited.push('DEFENSE_DEGRADATION');
      const priorVisit = visits[visits.length - 2];
      if (priorVisit && lastVisit.rejection < priorVisit.rejection) {
        fail('REACTION_DEFENSE_DEGRADING', {
          lastRejection: lastVisit.rejection,
          priorRejection: priorVisit.rejection,
        });
        continue;
      }
      const sideContext: MicroBurstContext = {
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
            ...(side === 'LONG'
              ? { support: level, resistance: target }
              : { resistance: level, support: target }),
            structuralPosition: side === 'LONG' ? 'near_support' : 'near_resistance',
          },
        },
      };
      stagesVisited.push('BTC_CONFLICT');
      if (sideContext.btcContext?.conflictFlag) {
        fail('BTC_CONFLICT');
        continue sideLoop;
      }
      const evaluated = evaluateMicroBurstStructuralEntry(sideContext, config, side, (stage) =>
        stagesVisited.push(stage),
      );
      if (evaluated.action !== 'ENTRY_INTENT') {
        fail(evaluated.reason, evaluated.diagnostics);
        continue sideLoop;
      }
      // The existing 14 bps exit budget is residual round-trip friction after the executable
      // entry quote. Do not add spread again. This is a stress assumption, not paid fees.
      stagesVisited.push('NET_ROOM_AND_REWARD_RISK');
      const costs = config.exitEstimatedRoundTripCostBps;
      const boundedTarget = target.price * (1 - (sign * config.exitCostCoverBufferBps) / 10_000);
      const netRoom = ((sign * (boundedTarget - price)) / price) * 10_000 - costs;
      const netRisk = (evaluated.riskToInvalidationBps ?? Infinity) + costs;
      const netRR = netRoom / netRisk;
      const averageVolume = candles.reduce((sum, c) => sum + c.volume, 0) / candles.length;
      const diagnostics = {
        setup,
        selectedDefense: level,
        selectedTarget: target,
        targetSelection,
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
          `MICRO:${level.type}:${level.price}:${level.availableAtMs}`,
        ),
      };
      if (
        !Number.isFinite(costs) ||
        costs < 0 ||
        !Number.isFinite(netRR) ||
        netRoom < config.minRoomBps ||
        netRR < config.minRewardRisk
      ) {
        fail('REACTION_NET_ROOM_INSUFFICIENT', {
          ...diagnostics,
          netFailure:
            !Number.isFinite(costs) || costs < 0 || !Number.isFinite(netRR)
              ? 'INVALID_NET_ECONOMICS'
              : netRoom < config.minRoomBps
                ? 'NET_ROOM'
                : 'NET_REWARD_RISK',
        });
        continue sideLoop;
      }
      fail('REACTION_CONFIRMED', diagnostics);
      accepted.push({
        ...evaluated,
        targetPrice: boundedTarget,
        roomToTargetBps: priceDistanceToBps(price, boundedTarget),
        rewardRisk:
          priceDistanceToBps(price, boundedTarget) / (evaluated.riskToInvalidationBps ?? Infinity),
        reason: 'REACTION_CONFIRMED',
        diagnostics,
      });
      continue sideLoop;
    }
  }
  accepted.sort(
    (a, b) => Number(b.diagnostics.netRewardRisk) - Number(a.diagnostics.netRewardRisk),
  );
  return accepted[0]
    ? { ...accepted[0], diagnostics: { ...accepted[0].diagnostics, commonStagesVisited, sides } }
    : reject('REACTION_NO_QUALIFIED_SIDE', { sides });
}
