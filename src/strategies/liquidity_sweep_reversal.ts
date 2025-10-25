// src/strategies/liquidity_sweep_reversal.ts
import { Strategy, StrategyContext } from './types';
import { Candle } from '../core/types';
import { last, volumeAvg, countStreak } from '../core/utils/candles';
import { computeFeatures } from '../core/utils/features';
import { computeLevels, getTrendSignals } from './shared/context';

type Direction = 'LONG' | 'SHORT';

export interface SweepParams {
  timeframe: string;
  confirmTf: '5m' | '15m' | '30m' | '1h';
  htfTf: '1h' | '4h';
  sweepLookback: number;
  sweepTolerance: number;
  wickMin: number;
  volRatioMin: number;
  streakMin: number;
  rsiLongMax: number;
  rsiShortMin: number;
  levelProximityMax: number;
  adxTrendCap: number;
}

export interface SweepState {
  direction: Direction;
  sweptLevel: number;
  reclaimed: boolean;
  wickRatio: number;
  volRatio: number;
  streak: number;
  rsi: number;
  levelDistance: number;
  trendAligned: boolean;
  ready: boolean;
}

export interface LiquiditySweepAnalysis {
  params: SweepParams;
  last: Candle;
  prev: Candle;
  long: SweepState;
  short: SweepState;
}

const lowerWickRatio = (c: Candle) => {
  const range = Math.max(1e-9, c.high - c.low);
  const bodyLow = Math.min(c.open, c.close);
  return (bodyLow - c.low) / range;
};

const upperWickRatio = (c: Candle) => {
  const range = Math.max(1e-9, c.high - c.low);
  const bodyHigh = Math.max(c.open, c.close);
  return (c.high - bodyHigh) / range;
};

function nearestLevelDistance(px: number, level: number) {
  if (!Number.isFinite(level) || level <= 0) return Number.POSITIVE_INFINITY;
  return Math.abs(px - level) / Math.max(level, 1e-9);
}

function computeSweepLevels(candles: Candle[], lookback: number) {
  let maxHigh = -Infinity;
  let minLow = Infinity;
  for (let i = candles.length - lookback - 1; i < candles.length - 1; i++) {
    if (i < 0) continue;
    const c = candles[i];
    if (c.high > maxHigh) maxHigh = c.high;
    if (c.low < minLow) minLow = c.low;
  }
  return { maxHigh, minLow };
}

export function analyzeLiquiditySweep(opts: {
  candles: Candle[];
  confirmCandles: Candle[];
  htfCandles: Candle[];
  config: StrategyContext['config'];
}): LiquiditySweepAnalysis {
  const { candles, confirmCandles, htfCandles, config } = opts;
  const params: SweepParams = {
    timeframe: config.ENTRY_TIMEFRAME || '5m',
    confirmTf: ((config as any).LS_CONFIRM_TF ?? '15m') as '5m' | '15m' | '30m' | '1h',
    htfTf: ((config as any).LS_HTF_TF ?? '1h') as '1h' | '4h',
    sweepLookback: Number((config as any).LS_SWEEP_LOOKBACK ?? 24),
    sweepTolerance: Number((config as any).LS_SWEEP_TOLERANCE ?? 0.0005),
    wickMin: Number((config as any).LS_WICK_MIN ?? 0.55),
    volRatioMin: Number((config as any).LS_VOL_RATIO_MIN ?? 1.3),
    streakMin: Number((config as any).LS_STREAK_MIN ?? 3),
    rsiLongMax: Number((config as any).LS_RSI_LONG_MAX ?? 40),
    rsiShortMin: Number((config as any).LS_RSI_SHORT_MIN ?? 60),
    levelProximityMax: Number((config as any).LS_LEVEL_PROX_MAX ?? 0.006),
    adxTrendCap: Number((config as any).LS_ADX_TREND_CAP ?? 32),
  };

  const lastCandle = last(candles);
  const prevCandle = candles[candles.length - 2];
  const features = computeFeatures(candles);
  const volAvg = volumeAvg(candles, Math.max(10, Math.floor(params.sweepLookback / 2)));
  const volRatio = volAvg > 0 ? lastCandle.volume / Math.max(volAvg, 1e-9) : 1;
  const wickLower = lowerWickRatio(lastCandle);
  const wickUpper = upperWickRatio(lastCandle);
  const streakRed = countStreak(candles, 'red');
  const streakGreen = countStreak(candles, 'green');

  const { maxHigh, minLow } = computeSweepLevels(candles, params.sweepLookback);
  const levels = computeLevels(htfCandles, 2, Math.min(180, params.sweepLookback * 2));

  const trendNow = getTrendSignals(confirmCandles, config);
  const trendHtf = getTrendSignals(htfCandles, config);

  const sweptLow =
    Number.isFinite(minLow) &&
    lastCandle.low < minLow * (1 - params.sweepTolerance) &&
    lastCandle.close > minLow;
  const sweptHigh =
    Number.isFinite(maxHigh) &&
    lastCandle.high > maxHigh * (1 + params.sweepTolerance) &&
    lastCandle.close < maxHigh;

  const distanceToSupport = nearestLevelDistance(lastCandle.close, levels.support);
  const distanceToResistance = nearestLevelDistance(lastCandle.close, levels.resistance);

  const longReady =
    sweptLow &&
    wickLower >= params.wickMin &&
    volRatio >= params.volRatioMin &&
    streakRed >= params.streakMin &&
    features.rsi <= params.rsiLongMax &&
    distanceToSupport <= params.levelProximityMax &&
    Number.isFinite(trendNow.adx) &&
    trendNow.adx <= params.adxTrendCap &&
    !trendNow.bull &&
    !trendHtf.bull;

  const shortReady =
    sweptHigh &&
    wickUpper >= params.wickMin &&
    volRatio >= params.volRatioMin &&
    streakGreen >= params.streakMin &&
    features.rsi >= params.rsiShortMin &&
    distanceToResistance <= params.levelProximityMax &&
    Number.isFinite(trendNow.adx) &&
    trendNow.adx <= params.adxTrendCap &&
    !trendNow.bear &&
    !trendHtf.bear;

  return {
    params,
    last: lastCandle,
    prev: prevCandle,
    long: {
      direction: 'LONG',
      sweptLevel: minLow,
      reclaimed: sweptLow,
      wickRatio: wickLower,
      volRatio,
      streak: streakRed,
      rsi: features.rsi,
      levelDistance: distanceToSupport,
      trendAligned: !trendNow.bull && !trendHtf.bull,
      ready: longReady,
    },
    short: {
      direction: 'SHORT',
      sweptLevel: maxHigh,
      reclaimed: sweptHigh,
      wickRatio: wickUpper,
      volRatio,
      streak: streakGreen,
      rsi: features.rsi,
      levelDistance: distanceToResistance,
      trendAligned: !trendNow.bear && !trendHtf.bear,
      ready: shortReady,
    },
  };
}

const fmt = (value: number | undefined, digits = 4) =>
  Number.isFinite(value ?? NaN) ? (value as number).toFixed(digits) : 'n/a';

export const LiquiditySweepReversal: Strategy = {
  name: 'liquidity_sweep_reversal',
  timeframe: '5m',

  async evaluate(ctx: StrategyContext) {
    const { exchange, symbol, config } = ctx;
    const timeframe = config.ENTRY_TIMEFRAME || '5m';
    const candles = await exchange.getCandles(symbol, timeframe, 320);
    if (candles.length < 160) {
      return { action: 'IDLE', reason: 'lsr_few_candles' };
    }

    const confirmTf = ((config as any).LS_CONFIRM_TF ?? '15m') as '5m' | '15m' | '30m' | '1h';
    const confirmCandles =
      confirmTf === timeframe
        ? candles
        : await exchange.getCandles(symbol, confirmTf, confirmTf === '1h' ? 220 : 260);

    const htfTf = ((config as any).LS_HTF_TF ?? '1h') as '1h' | '4h';
    const htfCandles =
      htfTf === confirmTf
        ? confirmCandles
        : await exchange.getCandles(symbol, htfTf, htfTf === '4h' ? 200 : 320);

    const analysis = analyzeLiquiditySweep({ candles, confirmCandles, htfCandles, config });

    if ((config as any).ALLOW_LONGS !== false && analysis.long.ready) {
      return {
        action: 'ENTER_LONG',
        reason: `lsr_long sweep=${fmt(analysis.long.sweptLevel)} wick=${analysis.long.wickRatio.toFixed(
          2,
        )} vol=${analysis.long.volRatio.toFixed(2)} rsi=${analysis.long.rsi.toFixed(
          1,
        )} dist=${(analysis.long.levelDistance * 100).toFixed(2)}%`,
        diagnostics: {
          strategy: LiquiditySweepReversal.name,
          selection: 'LONG',
          analysis,
          confirmTf,
          htfTf,
        },
      };
    }

    if ((config as any).ALLOW_SHORTS !== false && analysis.short.ready) {
      return {
        action: 'ENTER_SHORT',
        reason: `lsr_short sweep=${fmt(analysis.short.sweptLevel)} wick=${analysis.short.wickRatio.toFixed(
          2,
        )} vol=${analysis.short.volRatio.toFixed(2)} rsi=${analysis.short.rsi.toFixed(
          1,
        )} dist=${(analysis.short.levelDistance * 100).toFixed(2)}%`,
        diagnostics: {
          strategy: LiquiditySweepReversal.name,
          selection: 'SHORT',
          analysis,
          confirmTf,
          htfTf,
        },
      };
    }

    return {
      action: 'IDLE',
      reason: `lsr_filters long=${Number(analysis.long.ready)} short=${Number(
        analysis.short.ready,
      )} wick=${analysis.long.wickRatio.toFixed(2)} vol=${analysis.long.volRatio.toFixed(
        2,
      )} rsi=${analysis.long.rsi.toFixed(1)}`,
      diagnostics: {
        strategy: LiquiditySweepReversal.name,
        analysis,
        confirmTf,
        htfTf,
      },
    };
  },
};
