import type { FeatureVector, ScoutDecision, SrZone, LevelCandidateEvent } from './ScoutTypes';
import type { BuiltCandle } from '../market/ThreeMinuteCandleBuilder';

export interface BreakRiskPolicy {
  evaluate(
    event: LevelCandidateEvent,
    featureVector: FeatureVector,
    recentCandles3m: BuiltCandle[],
    breakConfirmCandles: number,
  ): {
    decision: ScoutDecision;
    reasons: string[];
  };
}

export function createBreakRiskPolicy(): BreakRiskPolicy {
  return {
    evaluate(event, featureVector, recentCandles3m, breakConfirmCandles) {
      const reasons: string[] = [];
      const zone = event.zone;
      const price = featureVector.level.distanceAtr;
      const btc = featureVector.btcContext;
      const flow = featureVector.flow;
      const candles = recentCandles3m;

      if (candles.length < breakConfirmCandles) {
        reasons.push('insufficient_candles_for_breakout_detection');
        return { decision: 'NO_TRADE', reasons };
      }

      const lastCandles = candles.slice(-breakConfirmCandles);
      const breakCount = lastCandles.filter((c) => {
        if (zone.side === 'RESISTANCE') {
          return c.close > zone.high;
        }
        return c.close < zone.low;
      }).length;

      const volumeExpansion =
        lastCandles.length > 0 &&
        lastCandles[lastCandles.length - 1].volume >
          (candles.slice(-10).reduce((s, c) => s + c.volume, 0) / Math.min(candles.length, 10)) *
            1.5;

      const btcAligned =
        zone.side === 'RESISTANCE'
          ? btc.return1m > 0.001 && btc.takerImbalance > 0.55
          : btc.return1m < -0.001 && btc.takerImbalance < 0.45;

      const flowAligned =
        zone.side === 'RESISTANCE' ? flow.takerBuyRatio1m > 0.55 : flow.takerBuyRatio1m < 0.45;

      if (breakCount >= breakConfirmCandles) {
        reasons.push(`breakout_accepted_${breakCount}_of_${breakConfirmCandles}_candles`);
        if (volumeExpansion) reasons.push('volume_expansion_at_break');
        if (btcAligned) reasons.push('btc_aligned_with_breakout');
        if (flowAligned) reasons.push('taker_flow_aligned_with_breakout');
        return { decision: 'BLOCK_BREAKOUT_RISK', reasons };
      }

      const partialBreakCount = lastCandles.filter((c) => {
        if (zone.side === 'RESISTANCE') {
          return c.close > zone.low;
        }
        return c.close < zone.high;
      }).length;

      if (partialBreakCount > 0 && (volumeExpansion || btcAligned)) {
        reasons.push('partial_break_with_context');
        return { decision: 'WAIT_BREAKOUT_PULLBACK', reasons };
      }

      return { decision: 'ALLOW_REJECTION_LONG', reasons: ['no_breakout_detected'] };
    },
  };
}
