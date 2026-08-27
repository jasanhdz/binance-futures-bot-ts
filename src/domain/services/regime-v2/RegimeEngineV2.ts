import {
  RegimeEngineV2Decision,
  RegimeEngineV2Direction,
  RegimeEngineV2EvaluateInput,
  RegimeEngineV2Indicators,
  RegimeEngineV2InputCandle,
  RegimeEngineV2MarketConfirmationState,
  RegimeEngineV2MomentumEnvironment,
  RegimeEngineV2Scores,
  RegimeEngineV2TechnicalRegime,
  RegimeEngineV2TransitionRisk,
} from './RegimeEngineV2.types';

const MIN_HISTORY = 120;

export class RegimeEngineV2 {
  static evaluate(input: RegimeEngineV2EvaluateInput): RegimeEngineV2Decision {
    const symbol = input.symbol.toUpperCase();
    const candles = input.candles.filter(validCandle);
    const current = candles[candles.length - 1];
    const timestamp = current ? candleDate(current).toISOString() : new Date(0).toISOString();
    if (candles.length < MIN_HISTORY || !current) {
      return decision({
        symbol,
        timestamp,
        technicalRegime: 'UNKNOWN',
        technicalDirection: 'NONE',
        momentumEnvironment: 'UNKNOWN',
        confidence: 0.1,
        scores: emptyScores(),
        indicators: {},
        marketConfirmationState: classifyMarketConfirmation('NONE', input.market),
        market: input.market,
        transitionRisk: 'HIGH',
        transitionReasons: ['insufficient_history'],
        reasons: ['insufficient_history'],
      });
    }

    const indicators = {
      ...calculateIndicators(candles),
      shortAdverseReboundRisk: round(shortAdverseReboundRisk(input.market)),
    };
    const scores = calculateScores(indicators);
    const technical = classifyTechnicalRegime(indicators, scores);
    const transition = classifyTransition(technical.regime, indicators, scores);
    const marketConfirmationState = classifyMarketConfirmation(technical.direction, input.market);
    const momentumEnvironment = classifyMomentumEnvironment({
      regime: technical.regime,
      direction: technical.direction,
      transitionRisk: transition.risk,
      marketConfirmationState,
      scores,
    });
    const confidence = confidenceFor(
      technical.regime,
      scores,
      transition.risk,
      marketConfirmationState,
    );

    return decision({
      symbol,
      timestamp,
      technicalRegime: technical.regime,
      technicalDirection: technical.direction,
      momentumEnvironment,
      confidence,
      scores,
      indicators,
      marketConfirmationState,
      market: input.market,
      transitionRisk: transition.risk,
      possibleNextRegime: transition.possibleNextRegime,
      transitionReasons: transition.reasons,
      reasons: [
        ...technical.reasons,
        ...environmentReasons(momentumEnvironment, marketConfirmationState, transition.risk),
      ],
    });
  }
}

function calculateIndicators(candles: RegimeEngineV2InputCandle[]): RegimeEngineV2Indicators {
  const closes = candles.map((candle) => candle.close);
  const highs = candles.map((candle) => candle.high);
  const lows = candles.map((candle) => candle.low);
  const volumes = candles.map((candle) => candle.volume);
  const current = candles[candles.length - 1];
  const previous = candles[candles.length - 2];
  const ema7Series = emaSeries(closes, 7);
  const ema25Series = emaSeries(closes, 25);
  const ema99Series = emaSeries(closes, 99);
  const adxSeries = calculateAdxSeries(candles, 14);
  const atrSeriesValues = atrSeries(candles, 14);
  const bollingerWidths = rollingBollingerWidth(closes, 20);
  const ema7 = last(ema7Series);
  const ema25 = last(ema25Series);
  const ema99 = last(ema99Series);
  const adx = last(adxSeries);
  const atr = last(atrSeriesValues);
  const currentBollingerWidth = last(bollingerWidths);
  const previousBollingerWidth =
    bollingerWidths.length > 1 ? bollingerWidths[bollingerWidths.length - 2] : undefined;
  const range = current.high - current.low;
  const upperWick = current.high - Math.max(current.open, current.close);
  const lowerWick = Math.min(current.open, current.close) - current.low;
  const body = Math.abs(current.close - current.open);
  const closeLocation = range > 0 ? (current.close - current.low) / range : 0.5;
  const direction = current.close >= current.open ? 'LONG' : 'SHORT';
  const wickRatio = range > 0 ? (direction === 'LONG' ? upperWick / range : lowerWick / range) : 0;
  const bodyConfirmation = range > 0 ? body / range : 0;
  const bodies = candles
    .slice(-100)
    .map((candle) => (candle.close > 0 ? Math.abs(candle.close - candle.open) / candle.close : 0));
  const bodyPct = current.close > 0 ? Math.abs(current.close - current.open) / current.close : 0;
  const recentHigh20 = max(highs.slice(-21, -1));
  const recentLow20 = min(lows.slice(-21, -1));
  const recentHigh48 = max(highs.slice(-49, -1));
  const recentLow48 = min(lows.slice(-49, -1));
  const breakoutLevelUp = max([recentHigh20, recentHigh48].filter(isNumber));
  const breakoutLevelDown = min([recentLow20, recentLow48].filter(isNumber));
  const breakoutUp = breakoutLevelUp !== undefined && current.close > breakoutLevelUp;
  const breakoutDown = breakoutLevelDown !== undefined && current.close < breakoutLevelDown;
  const breakoutRange =
    breakoutLevelUp !== undefined && breakoutLevelDown !== undefined
      ? breakoutLevelUp - breakoutLevelDown
      : undefined;
  const breakoutCloseBeyondRangePct =
    breakoutUp && breakoutLevelUp !== undefined && current.close > 0
      ? (current.close - breakoutLevelUp) / current.close
      : breakoutDown && breakoutLevelDown !== undefined && current.close > 0
        ? (breakoutLevelDown - current.close) / current.close
        : undefined;
  const breakdownCloseBeyondRangePct =
    breakoutLevelDown !== undefined && current.close > 0
      ? (breakoutLevelDown - current.close) / current.close
      : undefined;
  const breakoutStrengthPct =
    breakoutRange !== undefined && breakoutRange > 0 && breakoutCloseBeyondRangePct !== undefined
      ? Math.abs(breakoutCloseBeyondRangePct * current.close) / breakoutRange
      : undefined;
  const recentVolumeRatio2 = ratio(avg(volumes.slice(-3, -1)), avg(volumes.slice(-23, -3)));
  const recentVolumeRatio3 = ratio(avg(volumes.slice(-4, -1)), avg(volumes.slice(-24, -4)));
  const breakoutVolumePersistence = avgDefined([
    recentVolumeRatio2,
    recentVolumeRatio3,
    ratio(current.volume, avg(volumes.slice(-21, -1))),
  ]);
  const shortVolumePersistence = clamp01(((breakoutVolumePersistence ?? 1) - 0.85) / 0.75);
  const adverseWickAgainstBreakout =
    range > 0
      ? breakoutUp
        ? lowerWick / range
        : breakoutDown
          ? upperWick / range
          : undefined
      : undefined;
  const lowerWickRatio = range > 0 ? lowerWick / range : undefined;
  const lowerWickAgainstBreakdown =
    breakoutLevelDown !== undefined && current.low < breakoutLevelDown && range > 0
      ? lowerWick / range
      : undefined;
  const shortAbsorptionRisk =
    breakoutLevelDown !== undefined && current.low < breakoutLevelDown
      ? current.close >= breakoutLevelDown
        ? 1
        : clamp01((0.0012 - Math.max(0, breakdownCloseBeyondRangePct ?? 0)) / 0.0012)
      : 0;
  const shortSweepRisk = clamp01(
    Math.max(
      lowerWickAgainstBreakdown ?? 0,
      shortAbsorptionRisk,
      current.low < (breakoutLevelDown ?? -Infinity) &&
        (range > 0 ? (current.close - current.low) / range : 0) > 0.42
        ? 0.75
        : 0,
    ),
  );
  const preBreakoutCompression =
    previousBollingerWidth !== undefined
      ? 1 - (percentileRank(bollingerWidths.slice(-121, -1), previousBollingerWidth) ?? 0.5)
      : undefined;
  const breakoutTooExtendedFromEma25 = ema25
    ? Math.abs((current.close - ema25) / ema25) > 0.034
      ? 1
      : 0
    : undefined;
  const failedPressure = clamp01(
    Math.max(
      (failedBreakoutCount(candles) ?? 0) / 3,
      adverseWickAgainstBreakout ?? 0,
      breakoutUp && breakoutLevelUp !== undefined && current.close < breakoutLevelUp ? 1 : 0,
      breakoutDown && breakoutLevelDown !== undefined && current.close > breakoutLevelDown ? 1 : 0,
    ),
  );
  const breakoutFollowThroughScore =
    breakoutUp || breakoutDown
      ? clamp01(
          avgDefined([
            breakoutCloseBeyondRangePct !== undefined
              ? breakoutCloseBeyondRangePct / 0.004
              : undefined,
            bodyConfirmation / 0.55,
            (breakoutVolumePersistence ?? 1) / 1.25,
            1 - (adverseWickAgainstBreakout ?? 0),
            preBreakoutCompression,
          ]) ?? 0,
        )
      : undefined;
  const recentShortCandles = candles.slice(-3);
  const shortContinuationScore = clamp01(
    avgDefined([
      recentShortCandles.length === 3 &&
      recentShortCandles.every((candle) => candle.close < candle.open)
        ? 1
        : 0,
      recentShortCandles.length === 3 &&
      recentShortCandles[2].close < recentShortCandles[1].close &&
      recentShortCandles[1].close < recentShortCandles[0].close
        ? 1
        : 0,
      closeLocation <= 0.25 ? 1 : closeLocation <= 0.36 ? 0.65 : 0,
      shortVolumePersistence,
      breakoutFollowThroughScore,
    ]) ?? 0,
  );
  const shortRetestScore = failedShortRetestScore(candles, breakoutLevelDown);
  const shortExtensionRisk = ema25
    ? clamp01(Math.max(0, (ema25 - current.close) / ema25) / 0.04)
    : undefined;
  const shortBreakdownQuality = clamp01(
    avgDefined([
      breakdownCloseBeyondRangePct !== undefined
        ? Math.max(0, breakdownCloseBeyondRangePct) / 0.004
        : undefined,
      shortVolumePersistence,
      shortContinuationScore,
      shortRetestScore,
      1 - shortSweepRisk,
      shortExtensionRisk !== undefined ? 1 - shortExtensionRisk : undefined,
    ]) ?? 0,
  );
  const emaStackDirection =
    ema7 !== undefined && ema25 !== undefined && ema99 !== undefined
      ? ema7 > ema25 && ema25 > ema99
        ? 'LONG'
        : ema7 < ema25 && ema25 < ema99
          ? 'SHORT'
          : 'NONE'
      : 'NONE';

  return compact({
    ema7: round(ema7),
    ema25: round(ema25),
    ema99: round(ema99),
    ema7Slope: round(seriesSlopePct(ema7Series, 6)),
    ema25Slope: round(seriesSlopePct(ema25Series, 8)),
    emaStackAge: emaStackAge(ema7Series, ema25Series, ema99Series, emaStackDirection),
    adx: round(adx),
    adxSlope: round(seriesSlope(adxSeries, 6)),
    choppiness: round(calculateChoppiness(candles.slice(-14))),
    atrPercentile: round(
      atr !== undefined ? percentileRank(atrSeriesValues.slice(-120), atr) : undefined,
    ),
    bollingerWidthPercentile: round(
      currentBollingerWidth !== undefined
        ? percentileRank(bollingerWidths.slice(-120), currentBollingerWidth)
        : undefined,
    ),
    volumeRatio: round(ratio(current.volume, avg(volumes.slice(-21, -1)))),
    volumeTrend: round(volumeTrend(volumes)),
    closeLocation: round(closeLocation),
    wickRatio: round(wickRatio),
    bodySizePercentile: round(percentileRank(bodies, bodyPct)),
    distanceFromEma25Pct: round(ema25 ? (current.close - ema25) / ema25 : undefined),
    distanceFromEma99Pct: round(ema99 ? (current.close - ema99) / ema99 : undefined),
    rangeBreakout: breakoutUp ? 'UP' : breakoutDown ? 'DOWN' : 'NONE',
    failedBreakoutCount: failedBreakoutCount(candles),
    structure: marketStructure(candles),
    breakoutStrengthPct: round(breakoutStrengthPct),
    breakoutCloseBeyondRangePct: round(breakoutCloseBeyondRangePct),
    breakoutBodyConfirmation: round(bodyConfirmation),
    breakoutVolumePersistence: round(breakoutVolumePersistence),
    breakoutFollowThroughScore: round(breakoutFollowThroughScore),
    adverseWickAgainstBreakout: round(adverseWickAgainstBreakout),
    lowerWickRatio: round(lowerWickRatio),
    breakdownCloseBeyondRangePct: round(breakdownCloseBeyondRangePct),
    lowerWickAgainstBreakdown: round(lowerWickAgainstBreakdown),
    preBreakoutCompression: round(preBreakoutCompression),
    breakoutTooExtendedFromEma25: breakoutTooExtendedFromEma25,
    failedBreakoutPressure: round(failedPressure),
    shortBreakdownQuality: round(shortBreakdownQuality),
    shortSweepRisk: round(shortSweepRisk),
    shortContinuationScore: round(shortContinuationScore),
    shortRetestScore: round(shortRetestScore),
    shortExtensionRisk: round(shortExtensionRisk),
    shortAbsorptionRisk: round(shortAbsorptionRisk),
    shortVolumePersistence: round(shortVolumePersistence),
    // Keep previous referenced so TS does not hide accidental single-candle datasets in future edits.
    ...(previous ? {} : {}),
  });
}

function calculateScores(indicators: RegimeEngineV2Indicators): RegimeEngineV2Scores {
  const trendStrength = clamp01(((indicators.adx ?? 0) - 12) / 28);
  const chopRisk = clamp01(
    Math.max(
      ((indicators.choppiness ?? 50) - 45) / 25,
      1 - trendStrength,
      indicators.structure === 'MIXED' ? 0.7 : 0,
    ),
  );
  const extension = Math.abs(indicators.distanceFromEma25Pct ?? 0);
  const exhaustionRisk = clamp01(
    Math.max(
      extension / 0.035,
      indicators.wickRatio ?? 0,
      (indicators.adxSlope ?? 0) < -2 ? 0.65 : 0,
      (indicators.volumeTrend ?? 0) < -0.15 && extension > 0.018 ? 0.65 : 0,
    ),
  );
  const volatilityRisk = clamp01(indicators.atrPercentile ?? 0);
  const transitionRisk = clamp01(
    Math.max(
      exhaustionRisk,
      (indicators.failedBreakoutCount ?? 0) >= 2 ? 0.75 : 0,
      indicators.rangeBreakout !== 'NONE' &&
        (indicators.closeLocation ?? 0.5) > 0.25 &&
        (indicators.closeLocation ?? 0.5) < 0.75
        ? 0.55
        : 0,
    ),
  );
  const momentumQuality = clamp01(
    avgDefined([
      trendStrength,
      1 - chopRisk,
      clamp01(((indicators.volumeRatio ?? 1) - 0.8) / 0.9),
      indicators.closeLocation !== undefined
        ? Math.abs(indicators.closeLocation - 0.5) * 2
        : undefined,
      1 - Math.min(1, extension / 0.04),
    ]) ?? 0,
  );
  return {
    trendStrength: roundScore(trendStrength),
    momentumQuality: roundScore(momentumQuality),
    chopRisk: roundScore(chopRisk),
    exhaustionRisk: roundScore(exhaustionRisk),
    transitionRisk: roundScore(transitionRisk),
    volatilityRisk: roundScore(volatilityRisk),
    marketConfirmationScore: 0,
  };
}

function classifyTechnicalRegime(
  indicators: RegimeEngineV2Indicators,
  scores: RegimeEngineV2Scores,
): {
  regime: RegimeEngineV2TechnicalRegime;
  direction: RegimeEngineV2Direction;
  reasons: string[];
} {
  const upStack =
    (indicators.ema7 ?? 0) > (indicators.ema25 ?? Infinity) &&
    (indicators.ema25 ?? 0) > (indicators.ema99 ?? Infinity);
  const downStack =
    (indicators.ema7 ?? Infinity) < (indicators.ema25 ?? 0) &&
    (indicators.ema25 ?? Infinity) < (indicators.ema99 ?? 0);
  const closeLocation = indicators.closeLocation ?? 0.5;
  const volumeRatio = indicators.volumeRatio ?? 1;
  const distance = indicators.distanceFromEma25Pct ?? 0;
  const absDistance = Math.abs(distance);
  const stackAge = indicators.emaStackAge ?? 0;
  const adxSlope = indicators.adxSlope ?? 0;
  const ema25Slope = indicators.ema25Slope ?? 0;

  const breakoutUpProblems = breakoutProblems(indicators, scores, 'LONG');
  const breakoutDownProblems = breakoutProblems(indicators, scores, 'SHORT');
  const shortBreakdownProblems = shortBreakdownDegradationReasons(indicators);

  if (
    indicators.rangeBreakout === 'UP' &&
    volumeRatio >= 1.25 &&
    closeLocation >= 0.68 &&
    scores.exhaustionRisk < 0.72 &&
    absDistance <= 0.038 &&
    (indicators.failedBreakoutCount ?? 0) <= 2
  ) {
    if (breakoutUpProblems.length === 0)
      return {
        regime: 'BREAKOUT_UP_EARLY',
        direction: 'LONG',
        reasons: ['range_breakout_up_volume_close_location', 'breakout_v22_confirmed'],
      };
    if (breakoutUpProblems.includes('breakout_failed_pressure_high'))
      return {
        regime: 'CHOP',
        direction: 'NONE',
        reasons: [...breakoutUpProblems, 'breakout_degraded_to_avoid'],
      };
    return {
      regime: 'TREND_UP_PULLBACK',
      direction: 'LONG',
      reasons: [...breakoutUpProblems, 'breakout_degraded_to_watch'],
    };
  }
  if (
    indicators.rangeBreakout === 'DOWN' &&
    volumeRatio >= 1.25 &&
    closeLocation <= 0.32 &&
    scores.exhaustionRisk < 0.72 &&
    absDistance <= 0.038 &&
    (indicators.failedBreakoutCount ?? 0) <= 2
  ) {
    const allBreakdownProblems = [...breakoutDownProblems, ...shortBreakdownProblems];
    if (allBreakdownProblems.length === 0) {
      return {
        regime: 'BREAKOUT_DOWN_EARLY',
        direction: 'SHORT',
        reasons: [
          'range_breakout_down_volume_close_location',
          'breakout_v22_confirmed',
          'short_breakdown_confirmed_close',
          ...((indicators.shortRetestScore ?? 0) >= 0.55
            ? ['short_retest_failed_confirmed']
            : ['short_no_failed_retest']),
          ...((indicators.shortContinuationScore ?? 0) >= 0.65
            ? ['short_continuation_quality_high']
            : []),
        ],
      };
    }
    if (
      allBreakdownProblems.includes('short_breakdown_absorbed') ||
      allBreakdownProblems.includes('short_degraded_to_avoid_fake_breakdown') ||
      breakoutDownProblems.includes('breakout_failed_pressure_high')
    ) {
      return {
        regime: 'CHOP',
        direction: 'NONE',
        reasons: [...allBreakdownProblems, 'breakout_degraded_to_avoid'],
      };
    }
    return {
      regime: 'TREND_DOWN_PULLBACK',
      direction: 'SHORT',
      reasons: [...allBreakdownProblems, 'breakout_degraded_to_watch'],
    };
  }
  if (scores.chopRisk >= 0.78 && scores.trendStrength < 0.35)
    return { regime: 'CHOP', direction: 'NONE', reasons: ['high_choppiness_low_trend_strength'] };
  if (
    scores.chopRisk >= 0.62 &&
    indicators.structure === 'MIXED' &&
    (indicators.bollingerWidthPercentile ?? 0.5) < 0.45
  ) {
    return {
      regime: 'ACCUMULATION_RANGE',
      direction: 'NONE',
      reasons: ['mixed_structure_compressed_range'],
    };
  }
  if (
    upStack &&
    (scores.exhaustionRisk >= 0.76 || (distance > 0.035 && (indicators.wickRatio ?? 0) >= 0.38))
  ) {
    return {
      regime: 'MOMENTUM_UP_EXHAUSTED',
      direction: 'LONG',
      reasons: ['up_momentum_overextended_or_upper_wick'],
    };
  }
  if (
    downStack &&
    (scores.exhaustionRisk >= 0.76 || (distance < -0.035 && (indicators.wickRatio ?? 0) >= 0.38))
  ) {
    return {
      regime: 'MOMENTUM_DOWN_EXHAUSTED',
      direction: 'SHORT',
      reasons: ['down_momentum_overextended_or_lower_wick'],
    };
  }
  if (
    scores.volatilityRisk >= 0.99 &&
    scores.momentumQuality < 0.5 &&
    indicators.rangeBreakout === 'NONE'
  ) {
    return {
      regime: 'HIGH_VOL_RISK',
      direction: 'NONE',
      reasons: ['atr_percentile_extreme_without_clean_momentum'],
    };
  }
  if (upStack && stackAge >= 48 && scores.trendStrength >= 0.48) {
    return {
      regime: 'MOMENTUM_UP_MATURE',
      direction: 'LONG',
      reasons: ['long_ema_stack_mature_trend'],
    };
  }
  if (downStack && stackAge >= 48 && scores.trendStrength >= 0.48) {
    return {
      regime: 'MOMENTUM_DOWN_MATURE',
      direction: 'SHORT',
      reasons: ['short_ema_stack_mature_trend'],
    };
  }
  if (
    (indicators.ema7 ?? 0) > (indicators.ema25 ?? Infinity) &&
    ema25Slope > 0 &&
    scores.momentumQuality >= 0.52 &&
    closeLocation >= 0.58 &&
    absDistance <= 0.03 &&
    scores.chopRisk < 0.68
  ) {
    return {
      regime: 'MOMENTUM_UP_EARLY',
      direction: 'LONG',
      reasons: ['ema7_above_ema25_slope_volume_no_overextension'],
    };
  }
  if (
    (indicators.ema7 ?? Infinity) < (indicators.ema25 ?? 0) &&
    ema25Slope < 0 &&
    scores.momentumQuality >= 0.52 &&
    closeLocation <= 0.42 &&
    absDistance <= 0.03 &&
    scores.chopRisk < 0.68
  ) {
    return {
      regime: 'MOMENTUM_DOWN_EARLY',
      direction: 'SHORT',
      reasons: ['ema7_below_ema25_slope_volume_no_overextension'],
    };
  }
  if (
    upStack &&
    distance <= 0.006 &&
    distance >= -0.018 &&
    scores.chopRisk < 0.7 &&
    adxSlope >= -1
  ) {
    return {
      regime: 'TREND_UP_PULLBACK',
      direction: 'LONG',
      reasons: ['uptrend_pullback_to_ema25'],
    };
  }
  if (
    downStack &&
    distance >= -0.006 &&
    distance <= 0.018 &&
    scores.chopRisk < 0.7 &&
    adxSlope >= -1
  ) {
    return {
      regime: 'TREND_DOWN_PULLBACK',
      direction: 'SHORT',
      reasons: ['downtrend_pullback_to_ema25'],
    };
  }
  return { regime: 'UNKNOWN', direction: 'NONE', reasons: ['mixed_or_unclassified_context'] };
}

function breakoutProblems(
  indicators: RegimeEngineV2Indicators,
  scores: RegimeEngineV2Scores,
  side: RegimeEngineV2Direction,
): string[] {
  const reasons: string[] = [];
  if ((indicators.breakoutCloseBeyondRangePct ?? 0) < 0.0012)
    reasons.push('breakout_close_not_far_enough');
  if ((indicators.breakoutBodyConfirmation ?? 0) < 0.42) reasons.push('breakout_body_too_weak');
  if ((indicators.adverseWickAgainstBreakout ?? 0) > 0.34)
    reasons.push('breakout_adverse_wick_high');
  if ((indicators.breakoutVolumePersistence ?? 0) < 1.03 && (indicators.volumeRatio ?? 0) < 1.45)
    reasons.push('breakout_volume_not_persistent');
  if ((indicators.breakoutTooExtendedFromEma25 ?? 0) > 0)
    reasons.push('breakout_too_extended_from_ema25');
  if ((indicators.failedBreakoutPressure ?? 0) >= 0.72)
    reasons.push('breakout_failed_pressure_high');
  if (scores.transitionRisk >= 0.78) reasons.push('transition_risk_high');
  if (side === 'LONG' && (indicators.closeLocation ?? 0.5) < 0.7)
    reasons.push('breakout_close_location_not_strong');
  if (side === 'SHORT' && (indicators.closeLocation ?? 0.5) > 0.3)
    reasons.push('breakout_close_location_not_strong');
  return reasons;
}

function shortBreakdownDegradationReasons(indicators: RegimeEngineV2Indicators): string[] {
  const reasons: string[] = [];
  const retestContinuationConfirmed =
    (indicators.shortRetestScore ?? 0) >= 0.55 && (indicators.shortContinuationScore ?? 0) >= 0.65;
  if ((indicators.breakdownCloseBeyondRangePct ?? 0) < 0.0014)
    reasons.push('short_breakdown_close_not_far_enough');
  if ((indicators.shortAbsorptionRisk ?? 0) >= 0.72) reasons.push('short_breakdown_absorbed');
  if ((indicators.shortSweepRisk ?? 0) >= 0.86)
    reasons.push('short_degraded_to_avoid_fake_breakdown');
  else if ((indicators.shortSweepRisk ?? 0) >= 0.24) reasons.push('short_lower_wick_sweep_risk');
  if (!retestContinuationConfirmed && (indicators.shortVolumePersistence ?? 0) < 0.34)
    reasons.push('short_volume_not_persistent');
  if ((indicators.shortExtensionRisk ?? 0) >= 0.55) reasons.push('short_too_extended_from_ema25');
  if ((indicators.shortAdverseReboundRisk ?? 0) >= 0.75) reasons.push('short_btc_eth_rebound_risk');
  if (!retestContinuationConfirmed && (indicators.shortBreakdownQuality ?? 0) < 0.34)
    reasons.push('short_degraded_to_watch_false_breakout_risk');
  return reasons;
}

function classifyTransition(
  regime: RegimeEngineV2TechnicalRegime,
  indicators: RegimeEngineV2Indicators,
  scores: RegimeEngineV2Scores,
): { risk: RegimeEngineV2TransitionRisk; possibleNextRegime?: string; reasons: string[] } {
  const reasons: string[] = [];
  if (scores.exhaustionRisk >= 0.72) reasons.push('exhaustion_risk_high');
  if ((indicators.adxSlope ?? 0) < -2) reasons.push('adx_decelerating');
  if ((indicators.failedBreakoutCount ?? 0) >= 2) reasons.push('failed_breakouts_recent');
  if (Math.abs(indicators.distanceFromEma25Pct ?? 0) > 0.02) reasons.push('extended_from_ema25');
  const risk: RegimeEngineV2TransitionRisk =
    scores.transitionRisk >= 0.72 ? 'HIGH' : scores.transitionRisk >= 0.45 ? 'MODERATE' : 'LOW';
  const possibleNextRegime =
    risk === 'HIGH'
      ? regime.includes('UP')
        ? 'CHOP_OR_PULLBACK'
        : regime.includes('DOWN')
          ? 'CHOP_OR_PULLBACK'
          : 'UNKNOWN'
      : undefined;
  return {
    risk,
    possibleNextRegime,
    reasons: reasons.length > 0 ? reasons : ['transition_risk_normal'],
  };
}

function classifyMarketConfirmation(
  direction: RegimeEngineV2Direction,
  market?: {
    btc?: { action?: string; score?: number; direction?: string };
    eth?: { action?: string; score?: number; direction?: string };
  },
): RegimeEngineV2MarketConfirmationState {
  const signals = [market?.btc, market?.eth].filter(Boolean) as Array<{
    action?: string;
    score?: number;
    direction?: string;
  }>;
  if (signals.length === 0 || direction === 'NONE') return 'NEUTRAL';
  let confirms = 0;
  let contradicts = 0;
  for (const signal of signals) {
    const signalDirection = normalizeDirection(signal.direction ?? signal.action);
    if (signalDirection === direction) confirms++;
    else if (signalDirection !== 'NONE') contradicts++;
  }
  if (contradicts > 0 && confirms === 0) return 'CONTRADICT';
  if (contradicts > 0 && confirms > 0) return 'MIXED';
  if (confirms > 0) return direction === 'LONG' ? 'CONFIRM_LONG' : 'CONFIRM_SHORT';
  return 'NEUTRAL';
}

function shortAdverseReboundRisk(market?: {
  btc?: { action?: string; score?: number; direction?: string };
  eth?: { action?: string; score?: number; direction?: string };
}): number | undefined {
  const signals = [market?.btc, market?.eth].filter(Boolean) as Array<{
    action?: string;
    score?: number;
    direction?: string;
  }>;
  if (signals.length === 0) return undefined;
  const risks = signals.map((signal) => {
    const direction = normalizeDirection(signal.direction ?? signal.action);
    const score = signal.score ?? 0.55;
    if (direction === 'LONG') return clamp01(score);
    if (direction === 'SHORT') return 0;
    return 0.25;
  });
  return avg(risks);
}

function classifyMomentumEnvironment(input: {
  regime: RegimeEngineV2TechnicalRegime;
  direction: RegimeEngineV2Direction;
  transitionRisk: RegimeEngineV2TransitionRisk;
  marketConfirmationState: RegimeEngineV2MarketConfirmationState;
  scores: RegimeEngineV2Scores;
}): RegimeEngineV2MomentumEnvironment {
  if (input.regime === 'UNKNOWN') return 'UNKNOWN';
  if (
    input.regime === 'CHOP' ||
    input.regime === 'ACCUMULATION_RANGE' ||
    input.regime === 'HIGH_VOL_RISK'
  )
    return 'AVOID_MOMENTUM';
  if (input.regime.includes('EXHAUSTED'))
    return input.transitionRisk === 'HIGH' ? 'AVOID_MOMENTUM' : watchFor(input.direction);
  if (input.marketConfirmationState === 'CONTRADICT')
    return input.transitionRisk === 'HIGH' ? 'AVOID_MOMENTUM' : watchFor(input.direction);
  if (input.transitionRisk === 'HIGH')
    return input.regime.includes('EARLY') ? watchFor(input.direction) : 'AVOID_MOMENTUM';
  if (input.regime.includes('MATURE') || input.regime.includes('PULLBACK'))
    return watchFor(input.direction);
  if (input.regime.includes('BREAKOUT') && input.regime.includes('EARLY'))
    return allowFor(input.direction);
  if (input.regime.includes('EARLY') && input.scores.momentumQuality >= 0.52)
    return allowFor(input.direction);
  return input.direction === 'NONE' ? 'UNKNOWN' : watchFor(input.direction);
}

function decision(input: {
  symbol: string;
  timestamp: string;
  technicalRegime: RegimeEngineV2TechnicalRegime;
  technicalDirection: RegimeEngineV2Direction;
  momentumEnvironment: RegimeEngineV2MomentumEnvironment;
  confidence: number;
  scores: RegimeEngineV2Scores;
  indicators: RegimeEngineV2Indicators;
  marketConfirmationState: RegimeEngineV2MarketConfirmationState;
  market?: { btc?: unknown; eth?: unknown };
  transitionRisk: RegimeEngineV2TransitionRisk;
  possibleNextRegime?: string;
  transitionReasons: string[];
  reasons: string[];
}): RegimeEngineV2Decision {
  return {
    symbol: input.symbol,
    timestamp: input.timestamp,
    timeframe: '5m',
    technicalRegime: input.technicalRegime,
    technicalDirection: input.technicalDirection,
    momentumEnvironment: input.momentumEnvironment,
    confidence: roundScore(input.confidence),
    scores: {
      ...input.scores,
      marketConfirmationScore: marketConfirmationScore(input.marketConfirmationState),
    },
    marketConfirmation: {
      state: input.marketConfirmationState,
      btc: input.market?.btc as RegimeEngineV2Decision['marketConfirmation']['btc'],
      eth: input.market?.eth as RegimeEngineV2Decision['marketConfirmation']['eth'],
    },
    transition: {
      risk: input.transitionRisk,
      possibleNextRegime: input.possibleNextRegime,
      reasons: input.transitionReasons,
    },
    indicators: input.indicators,
    reasons: input.reasons,
  };
}

function confidenceFor(
  regime: RegimeEngineV2TechnicalRegime,
  scores: RegimeEngineV2Scores,
  transitionRisk: RegimeEngineV2TransitionRisk,
  market: RegimeEngineV2MarketConfirmationState,
): number {
  if (regime === 'UNKNOWN') return 0.25;
  const base =
    regime === 'CHOP'
      ? scores.chopRisk
      : regime === 'HIGH_VOL_RISK'
        ? scores.volatilityRisk
        : (avgDefined([
            scores.trendStrength,
            scores.momentumQuality,
            1 - scores.chopRisk,
            1 - scores.exhaustionRisk,
          ]) ?? 0.4);
  const transitionPenalty =
    transitionRisk === 'HIGH' ? 0.15 : transitionRisk === 'MODERATE' ? 0.06 : 0;
  const marketPenalty = market === 'CONTRADICT' ? 0.12 : 0;
  return clamp01(base - transitionPenalty - marketPenalty);
}

function environmentReasons(
  environment: RegimeEngineV2MomentumEnvironment,
  market: RegimeEngineV2MarketConfirmationState,
  transitionRisk: RegimeEngineV2TransitionRisk,
): string[] {
  const reasons = [`environment_${environment.toLowerCase()}`];
  if (market === 'CONTRADICT') reasons.push('market_confirmation_contradicts');
  if (transitionRisk === 'HIGH') reasons.push('transition_risk_high');
  return reasons;
}

function allowFor(direction: RegimeEngineV2Direction): RegimeEngineV2MomentumEnvironment {
  if (direction === 'LONG') return 'ALLOW_LONG_MOMENTUM';
  if (direction === 'SHORT') return 'ALLOW_SHORT_MOMENTUM';
  return 'UNKNOWN';
}

function watchFor(direction: RegimeEngineV2Direction): RegimeEngineV2MomentumEnvironment {
  if (direction === 'LONG') return 'WATCH_LONG_MOMENTUM';
  if (direction === 'SHORT') return 'WATCH_SHORT_MOMENTUM';
  return 'UNKNOWN';
}

function emptyScores(): RegimeEngineV2Scores {
  return {
    trendStrength: 0,
    momentumQuality: 0,
    chopRisk: 0,
    exhaustionRisk: 0,
    transitionRisk: 1,
    volatilityRisk: 0,
    marketConfirmationScore: 0,
  };
}

function validCandle(candle: RegimeEngineV2InputCandle): boolean {
  return [candle.open, candle.high, candle.low, candle.close, candle.volume].every((value) =>
    Number.isFinite(value),
  );
}

function candleDate(candle: RegimeEngineV2InputCandle): Date {
  return new Date(candle.timestamp ?? candle.openTime ?? 0);
}

function normalizeDirection(value?: string): RegimeEngineV2Direction {
  const normalized = String(value || '').toUpperCase();
  if (normalized === 'LONG' || normalized === 'SHORT') return normalized;
  return 'NONE';
}

function emaSeries(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const alpha = 2 / (period + 1);
  const output: number[] = [];
  let ema = values[0];
  for (const value of values) {
    ema = value * alpha + ema * (1 - alpha);
    output.push(ema);
  }
  return output;
}

function atrSeries(candles: RegimeEngineV2InputCandle[], period: number): number[] {
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];
    trs.push(
      Math.max(
        current.high - current.low,
        Math.abs(current.high - previous.close),
        Math.abs(current.low - previous.close),
      ),
    );
  }
  return wilderSeries(trs, period);
}

function calculateAdxSeries(candles: RegimeEngineV2InputCandle[], period: number): number[] {
  if (candles.length < period + 2) return [];
  const plusDm: number[] = [];
  const minusDm: number[] = [];
  const tr: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];
    const upMove = current.high - previous.high;
    const downMove = previous.low - current.low;
    plusDm.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDm.push(downMove > upMove && downMove > 0 ? downMove : 0);
    tr.push(
      Math.max(
        current.high - current.low,
        Math.abs(current.high - previous.close),
        Math.abs(current.low - previous.close),
      ),
    );
  }
  const atr = wilderSeries(tr, period);
  const plus = wilderSeries(plusDm, period);
  const minus = wilderSeries(minusDm, period);
  const dx: number[] = [];
  for (let i = 0; i < atr.length; i++) {
    const plusDi = atr[i] > 0 ? (plus[i] / atr[i]) * 100 : 0;
    const minusDi = atr[i] > 0 ? (minus[i] / atr[i]) * 100 : 0;
    dx.push(plusDi + minusDi > 0 ? (Math.abs(plusDi - minusDi) / (plusDi + minusDi)) * 100 : 0);
  }
  return wilderSeries(dx, period);
}

function wilderSeries(values: number[], period: number): number[] {
  if (values.length < period) return [];
  const output: number[] = [];
  let smoothed = values.slice(0, period).reduce(sum, 0) / period;
  output.push(smoothed);
  for (let i = period; i < values.length; i++) {
    smoothed = (smoothed * (period - 1) + values[i]) / period;
    output.push(smoothed);
  }
  return output;
}

function calculateChoppiness(candles: RegimeEngineV2InputCandle[]): number | undefined {
  if (candles.length < 2) return undefined;
  let trSum = 0;
  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];
    trSum += Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close),
    );
  }
  const high = max(candles.map((candle) => candle.high));
  const low = min(candles.map((candle) => candle.low));
  if (high === undefined || low === undefined || high <= low || trSum <= 0) return undefined;
  return (100 * Math.log10(trSum / (high - low))) / Math.log10(candles.length);
}

function rollingBollingerWidth(values: number[], period: number): number[] {
  const output: number[] = [];
  for (let i = period - 1; i < values.length; i++) {
    const window = values.slice(i - period + 1, i + 1);
    const mean = avg(window);
    const std = standardDeviation(window);
    output.push(mean && mean > 0 ? (4 * std) / mean : 0);
  }
  return output;
}

function emaStackAge(
  ema7: number[],
  ema25: number[],
  ema99: number[],
  direction: RegimeEngineV2Direction,
): number | undefined {
  if (direction === 'NONE') return 0;
  let age = 0;
  const len = Math.min(ema7.length, ema25.length, ema99.length);
  for (let offset = 1; offset <= len; offset++) {
    const i = len - offset;
    const up = ema7[i] > ema25[i] && ema25[i] > ema99[i];
    const down = ema7[i] < ema25[i] && ema25[i] < ema99[i];
    if ((direction === 'LONG' && up) || (direction === 'SHORT' && down)) age++;
    else break;
  }
  return age;
}

function failedBreakoutCount(candles: RegimeEngineV2InputCandle[]): number {
  let count = 0;
  for (let i = Math.max(21, candles.length - 20); i < candles.length; i++) {
    const prior = candles.slice(Math.max(0, i - 20), i);
    const high = max(prior.map((candle) => candle.high));
    const low = min(prior.map((candle) => candle.low));
    const candle = candles[i];
    if (high !== undefined && candle.high > high && candle.close < high) count++;
    if (low !== undefined && candle.low < low && candle.close > low) count++;
  }
  return count;
}

function failedShortRetestScore(
  candles: RegimeEngineV2InputCandle[],
  currentBreakdownLevel?: number,
): number | undefined {
  if (candles.length < 45) return undefined;
  const current = candles[candles.length - 1];
  const start = Math.max(25, candles.length - 18);
  let best = 0;
  for (let i = start; i < candles.length - 2; i++) {
    const prior = candles.slice(Math.max(0, i - 20), i);
    const priorLow = min(prior.map((candle) => candle.low));
    const breakdown = candles[i];
    if (priorLow === undefined || !(breakdown.low < priorLow && breakdown.close < priorLow))
      continue;
    const retestWindow = candles.slice(i + 1, candles.length - 1);
    const retested = retestWindow.some(
      (candle) => candle.high >= priorLow && candle.close <= priorLow,
    );
    if (!retested) continue;
    const sameLevel =
      currentBreakdownLevel === undefined ||
      Math.abs(priorLow - currentBreakdownLevel) / current.close < 0.006;
    const currentConfirms = current.close < current.open && current.close < priorLow;
    if (sameLevel && currentConfirms) best = Math.max(best, 1);
    else if (sameLevel || currentConfirms) best = Math.max(best, 0.55);
  }
  return best;
}

function marketStructure(
  candles: RegimeEngineV2InputCandle[],
): RegimeEngineV2Indicators['structure'] {
  const window = candles.slice(-12);
  if (window.length < 8) return 'UNKNOWN';
  const first = window.slice(0, 6);
  const second = window.slice(6);
  const firstHigh = max(first.map((candle) => candle.high));
  const firstLow = min(first.map((candle) => candle.low));
  const secondHigh = max(second.map((candle) => candle.high));
  const secondLow = min(second.map((candle) => candle.low));
  if (
    firstHigh === undefined ||
    firstLow === undefined ||
    secondHigh === undefined ||
    secondLow === undefined
  )
    return 'UNKNOWN';
  if (secondHigh > firstHigh && secondLow > firstLow) return 'HH_HL';
  if (secondHigh < firstHigh && secondLow < firstLow) return 'LL_LH';
  return 'MIXED';
}

function volumeTrend(volumes: number[]): number | undefined {
  if (volumes.length < 20) return undefined;
  const recent = avg(volumes.slice(-10));
  const previous = avg(volumes.slice(-20, -10));
  return recent !== undefined && previous !== undefined && previous > 0
    ? (recent - previous) / previous
    : undefined;
}

function seriesSlopePct(values: number[], lookback: number): number | undefined {
  const current = last(values);
  const prior = values.length > lookback ? values[values.length - 1 - lookback] : undefined;
  return current !== undefined && prior !== undefined && prior !== 0
    ? (current - prior) / prior
    : undefined;
}

function seriesSlope(values: number[], lookback: number): number | undefined {
  const current = last(values);
  const prior = values.length > lookback ? values[values.length - 1 - lookback] : undefined;
  return current !== undefined && prior !== undefined ? current - prior : undefined;
}

function percentileRank(values: Array<number | undefined>, value: number): number | undefined {
  const finite = values.filter(isNumber);
  if (finite.length === 0) return undefined;
  return finite.filter((item) => item <= value).length / finite.length;
}

function marketConfirmationScore(state: RegimeEngineV2MarketConfirmationState): number {
  if (state === 'CONFIRM_LONG' || state === 'CONFIRM_SHORT') return 1;
  if (state === 'MIXED') return 0.45;
  if (state === 'CONTRADICT') return 0;
  return 0.55;
}

function ratio(a: number | undefined, b: number | undefined): number | undefined {
  return a !== undefined && b !== undefined && b !== 0 ? a / b : undefined;
}

function avg(values: number[]): number | undefined {
  return values.length > 0 ? values.reduce(sum, 0) / values.length : undefined;
}

function avgDefined(values: Array<number | undefined>): number | undefined {
  return avg(values.filter(isNumber));
}

function standardDeviation(values: number[]): number {
  const mean = avg(values) ?? 0;
  return Math.sqrt(values.map((value) => (value - mean) ** 2).reduce(sum, 0) / values.length);
}

function last<T>(values: T[]): T | undefined {
  return values[values.length - 1];
}

function max(values: number[]): number | undefined {
  const finite = values.filter(isNumber);
  return finite.length > 0 ? Math.max(...finite) : undefined;
}

function min(values: number[]): number | undefined {
  const finite = values.filter(isNumber);
  return finite.length > 0 ? Math.min(...finite) : undefined;
}

function sum(a: number, b: number): number {
  return a + b;
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function round(value: number | undefined): number | undefined {
  return value === undefined || !Number.isFinite(value) ? undefined : Number(value.toFixed(6));
}

function roundScore(value: number): number {
  return Number(clamp01(value).toFixed(6));
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}
