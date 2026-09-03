import type { FeatureVector, ScoutDecision, LevelCandidateEvent, SrZone } from './ScoutTypes';
import type { BuiltCandle } from '../market/ThreeMinuteCandleBuilder';
import type { RawAggTradeEvent, RawDepthEvent } from '../market/ScoutMarketDataRuntime';

export interface DecisionPolicy {
  evaluate(
    event: LevelCandidateEvent,
    featureVector: FeatureVector,
    recentCandles1m: BuiltCandle[],
    recentCandles3m: BuiltCandle[],
    aggTrades: RawAggTradeEvent[],
    depthBids: RawDepthEvent[],
    depthAsks: RawDepthEvent[],
  ): {
    decision: ScoutDecision;
    reasons: string[];
  };
}

export function createDecisionPolicy(config: {
  minNetRMultiple: number;
  btcAggressiveThreshold: number;
}): DecisionPolicy {
  const { minNetRMultiple, btcAggressiveThreshold } = config;

  function hasRejectionPattern(candles: BuiltCandle[], side: 'SUPPORT' | 'RESISTANCE'): boolean {
    if (candles.length < 2) return false;
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];

    if (side === 'SUPPORT') {
      const hasLowerWick =
        last.low < last.open && last.open - last.low > (last.high - last.low) * 0.3;
      const isBullish = last.close > last.open;
      const prevWasDown = prev.close < prev.open;
      return hasLowerWick && isBullish && prevWasDown;
    } else {
      const hasUpperWick =
        last.high > last.open && last.high - last.open > (last.high - last.low) * 0.3;
      const isBearish = last.close < last.open;
      const prevWasUp = prev.close > prev.open;
      return hasUpperWick && isBearish && prevWasUp;
    }
  }

  function checkTakerFlow(
    trades: RawAggTradeEvent[],
    side: 'SUPPORT' | 'RESISTANCE',
    nowMs: number,
  ): boolean {
    const recent = trades.filter((t) => t.receivedAtMs >= nowMs - 60000);
    if (recent.length < 5) return false;

    const buyVol = recent
      .filter((t) => !t.isBuyerMaker)
      .reduce((s, t) => s + t.quantity * t.price, 0);
    const totalVol = recent.reduce((s, t) => s + t.quantity * t.price, 0);
    const ratio = totalVol > 0 ? buyVol / totalVol : 0.5;

    if (side === 'SUPPORT') {
      return ratio > 0.45;
    }
    return ratio < 0.55;
  }

  function checkRoomToTarget(
    event: LevelCandidateEvent,
    zones: SrZone[],
    currentPrice: number,
  ): boolean {
    const opposing = zones.find(
      (z) => z.id !== event.zone.id && z.side !== event.zone.side && !z.broken && z.touchCount >= 2,
    );

    if (!opposing) return true;

    const targetPrice = (opposing.high + opposing.low) / 2;
    const distance = Math.abs(targetPrice - currentPrice);
    const risk = Math.abs(
      event.zone.side === 'RESISTANCE'
        ? event.zone.high - currentPrice
        : event.zone.low - currentPrice,
    );

    return risk > 0 && distance / risk >= minNetRMultiple;
  }

  return {
    evaluate(
      event,
      featureVector,
      recentCandles1m,
      recentCandles3m,
      aggTrades,
      depthBids,
      depthAsks,
    ) {
      const reasons: string[] = [];
      const zone = event.zone;
      const btc = featureVector.btcContext;

      if (featureVector.level.zoneScore < 0.4) {
        reasons.push('zone_score_too_low');
        return { decision: 'NO_TRADE', reasons };
      }

      if (featureVector.level.touchCount < 2) {
        reasons.push('insufficient_touches');
        return { decision: 'NO_TRADE', reasons };
      }

      if (btc.aggressiveAgainstTrade) {
        reasons.push('btc_aggressive_against_trade');
        return { decision: 'BLOCK_BREAKOUT_RISK', reasons };
      }

      const rejectionPattern = hasRejectionPattern(recentCandles3m, zone.side);
      if (!rejectionPattern) {
        reasons.push('no_rejection_pattern');
        return { decision: 'NO_TRADE', reasons };
      }

      const flowOk = checkTakerFlow(aggTrades, zone.side, featureVector.timestamp);
      if (!flowOk) {
        reasons.push('taker_flow_against_trade');
        return { decision: 'NO_TRADE', reasons };
      }

      const roomOk = checkRoomToTarget(
        event,
        [event.zone],
        featureVector.level.distanceAtr > 0
          ? featureVector.level.zoneHigh
          : featureVector.level.zoneLow,
      );
      if (!roomOk) {
        reasons.push('insufficient_room_to_target');
        return { decision: 'NO_TRADE', reasons };
      }

      if (featureVector.price.realizedVol > 0.03) {
        reasons.push('high_volatility');
        return { decision: 'NO_TRADE', reasons };
      }

      if (zone.side === 'SUPPORT') {
        reasons.push('support_rejection_eligible');
        return { decision: 'ALLOW_REJECTION_LONG', reasons };
      } else {
        reasons.push('resistance_rejection_eligible');
        return { decision: 'ALLOW_REJECTION_SHORT', reasons };
      }
    },
  };
}
