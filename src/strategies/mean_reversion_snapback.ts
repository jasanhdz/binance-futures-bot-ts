// src/strategies/mean_reversion_snapback.ts
import { Strategy, StrategyContext } from './types';
import { Candle } from '../core/types';
import { last, countStreak } from '../core/utils/candles';
import { computeLevels, getTrendSignals, TrendSignals } from './shared/context';
import { computeFeatures } from '../core/utils/features';

type Direction = 'LONG' | 'SHORT';

export interface SnapParams {
  timeframe: string;
  confirmTf: '3m' | '5m' | '15m' | '1h';
  volBasis: number;
  volFactor: number;
  volContraction: number;
  emaExtension: number;
  rsiHigh: number;
  rsiLow: number;
  streakMin: number;
  roomMin: number;
  htfSupportLookback: number;
  htfSupportExclude: number;
  htfSupportMaxDist: number;
  hammerBodyMax: number;
  hammerLowerWickMin: number;
  hammerUpperWickMin: number;
  dailyDropGuard: number;
  dailyPumpGuard: number;
}

export interface SnapState {
  direction: Direction;
  trendNow: TrendSignals;
  trendConfirm: TrendSignals;
  trendHigher: TrendSignals;
  extension: number;
  rsi: number;
  streak: number;
  volumeOk: boolean;
  levelsOk: boolean;
  structureOk: boolean;
  reversalOk: boolean;
  dailyOk: boolean;
  ready: boolean;
}

export interface SnapAnalysis {
  params: SnapParams;
  long: SnapState;
  short: SnapState;
}

function extensionFromEma(candle: Candle, emaValue: number): number {
  if (!Number.isFinite(emaValue) || emaValue <= 0) return 0;
  return (candle.close - emaValue) / emaValue;
}

function candleRange(c: Candle): number {
  return c.high - c.low;
}

function lowerWickRatio(c: Candle): number {
  const range = candleRange(c);
  if (range <= 0) return 0;
  const bodyLow = Math.min(c.open, c.close);
  return (bodyLow - c.low) / range;
}

function upperWickRatio(c: Candle): number {
  const range = candleRange(c);
  if (range <= 0) return 0;
  const bodyHigh = Math.max(c.open, c.close);
  return (c.high - bodyHigh) / range;
}

function bodyRatio(c: Candle): number {
  const range = candleRange(c);
  if (range <= 0) return 0;
  return Math.abs(c.close - c.open) / range;
}

function isBullishHammer(c: Candle, params: SnapParams): boolean {
  if (!Number.isFinite(c.open) || !Number.isFinite(c.close)) return false;
  if (c.close < c.open) return false;
  const body = bodyRatio(c);
  const lowerWick = lowerWickRatio(c);
  return body <= params.hammerBodyMax && lowerWick >= params.hammerLowerWickMin;
}

function isBearishShootingStar(c: Candle, params: SnapParams): boolean {
  if (!Number.isFinite(c.open) || !Number.isFinite(c.close)) return false;
  if (c.close > c.open) return false;
  const body = bodyRatio(c);
  const upperWick = upperWickRatio(c);
  return body <= params.hammerBodyMax && upperWick >= params.hammerUpperWickMin;
}

function isBullishEngulfing(current: Candle, previous?: Candle): boolean {
  if (!previous) return false;
  if (current.close <= current.open) return false;
  if (previous.close >= previous.open) return false;
  return current.open <= previous.close && current.close >= previous.open;
}

function isBearishEngulfing(current: Candle, previous?: Candle): boolean {
  if (!previous) return false;
  if (current.close >= current.open) return false;
  if (previous.close <= previous.open) return false;
  return current.open >= previous.close && current.close <= previous.open;
}

export function analyzeSnapback(opts: {
  candles: Candle[];
  confirmCandles: Candle[];
  config: StrategyContext['config'];
  htfCandles?: Candle[];
  dailyCandles?: Candle[];
}): SnapAnalysis {
  const { candles, confirmCandles, config } = opts;
  const htfCandles = opts.htfCandles && opts.htfCandles.length ? opts.htfCandles : confirmCandles;
  const dailyCandles = opts.dailyCandles ?? [];
  const params: SnapParams = {
    timeframe: config.ENTRY_TIMEFRAME,
    confirmTf: ((config as any).MRS_CONFIRM_TF ?? '15m') as '3m' | '5m' | '15m' | '1h',
    volBasis: Math.max(Number((config as any).MRS_VOL_BASIS ?? config.VOL_AVG_LEN ?? 20), 10),
    volFactor: Number((config as any).MRS_VOL_FACTOR ?? 1.1),
    volContraction: Number((config as any).MRS_VOL_CONTRACTION ?? 0.85),
    emaExtension: Number((config as any).MRS_EXT_MIN ?? 0.015),
    rsiHigh: Number((config as any).MRS_RSI_HIGH ?? 75),
    rsiLow: Number((config as any).MRS_RSI_LOW ?? 25),
    streakMin: Number((config as any).MRS_STREAK_MIN ?? 3),
    roomMin: Number((config as any).MRS_ROOM_MIN ?? 0.0025),
    htfSupportLookback: Number((config as any).MRS_HTF_SUPPORT_LOOKBACK ?? 120),
    htfSupportExclude: Number((config as any).MRS_HTF_SUPPORT_EXCLUDE ?? 3),
    htfSupportMaxDist: Number((config as any).MRS_HTF_SUPPORT_MAX_DIST ?? 0.0125),
    hammerBodyMax: Number((config as any).MRS_HAMMER_BODY_MAX ?? 0.35),
    hammerLowerWickMin: Number((config as any).MRS_HAMMER_LOWER_WICK_MIN ?? 0.45),
    hammerUpperWickMin: Number((config as any).MRS_SHOOTING_UPPER_WICK_MIN ?? 0.45),
    dailyDropGuard: Number((config as any).MRS_DAILY_DROP_GUARD ?? 0.15),
    dailyPumpGuard: Number((config as any).MRS_DAILY_PUMP_GUARD ?? 0.12),
  };

  const lastCandle = last(candles);
  const prevCandle = candles.length > 1 ? candles[candles.length - 2] : undefined;
  const features = computeFeatures(candles);

  const trendNow = getTrendSignals(candles, config);
  const trendConfirm = getTrendSignals(confirmCandles, config);
  const trendHigher = getTrendSignals(htfCandles, config);

  const emaMid = trendNow.emaMid;
  const emaFast = trendNow.emaFast;

  const longStreak = countStreak(candles, 'red');
  const shortStreak = countStreak(candles, 'green');

  const volumeContraction = prevCandle
    ? lastCandle.volume <= prevCandle.volume * params.volContraction
    : false;

  const longHammer = isBullishHammer(lastCandle, params);
  const shortShootingStar = isBearishShootingStar(lastCandle, params);
  const longEngulf = isBullishEngulfing(lastCandle, prevCandle);
  const shortEngulf = isBearishEngulfing(lastCandle, prevCandle);

  const longReversalOk =
    longHammer ||
    longEngulf ||
    (volumeContraction && lastCandle.close >= lastCandle.open);

  const shortReversalOk =
    shortShootingStar ||
    shortEngulf ||
    (volumeContraction && lastCandle.close <= lastCandle.open);

  const { resistance, support } = computeLevels(candles, 10, 120);
  const roomAbove = Number.isFinite(resistance)
    ? (resistance - lastCandle.close) / Math.max(resistance, 1e-9)
    : Number.POSITIVE_INFINITY;
  const roomBelow = Number.isFinite(support)
    ? (lastCandle.close - support) / Math.max(support, 1e-9)
    : Number.POSITIVE_INFINITY;

  const htfExclude = Math.max(0, Math.floor(params.htfSupportExclude));
  const htfLookback = Math.max(1, Math.floor(params.htfSupportLookback));
  const htfLevels = computeLevels(htfCandles, htfExclude, htfLookback);

  const supportDist = Number.isFinite(htfLevels.support)
    ? (lastCandle.close - htfLevels.support) / Math.max(lastCandle.close, 1e-9)
    : Number.POSITIVE_INFINITY;
  const resistanceDist = Number.isFinite(htfLevels.resistance)
    ? (htfLevels.resistance - lastCandle.close) / Math.max(lastCandle.close, 1e-9)
    : Number.POSITIVE_INFINITY;

  const longStructureOk =
    Number.isFinite(htfLevels.support) &&
    htfLevels.support <= lastCandle.close &&
    supportDist >= 0 &&
    supportDist <= params.htfSupportMaxDist;

  const shortStructureOk =
    Number.isFinite(htfLevels.resistance) &&
    htfLevels.resistance >= lastCandle.close &&
    resistanceDist >= 0 &&
    resistanceDist <= params.htfSupportMaxDist;

  const higherTrendFastSlowValid =
    Number.isFinite(trendHigher.emaFast) && Number.isFinite(trendHigher.emaMid);

  const htfTrendOkLong =
    !trendHigher.bear &&
    (higherTrendFastSlowValid ? trendHigher.emaFast >= trendHigher.emaMid : true);
  const htfTrendOkShort =
    !trendHigher.bull &&
    (higherTrendFastSlowValid ? trendHigher.emaFast <= trendHigher.emaMid : true);

  const dailyCandle = dailyCandles.length ? last(dailyCandles) : undefined;
  let dailyOkLong = true;
  let dailyOkShort = true;
  if (dailyCandle && dailyCandle.open > 0) {
    const dayChange = dailyCandle.close / dailyCandle.open - 1;
    if (Number.isFinite(dayChange) && dayChange <= -params.dailyDropGuard) {
      dailyOkLong = longHammer && longStructureOk;
    }
    if (Number.isFinite(dayChange) && dayChange >= params.dailyPumpGuard) {
      dailyOkShort = shortShootingStar && shortStructureOk;
    }
  }

  const extDown = extensionFromEma(lastCandle, emaMid ?? emaFast);
  const longLevelsOk =
    roomAbove === Number.POSITIVE_INFINITY ? true : roomAbove >= params.roomMin;
  const shortLevelsOk =
    roomBelow === Number.POSITIVE_INFINITY ? true : roomBelow >= params.roomMin;

  const longVolumeOk = longReversalOk;
  const shortVolumeOk = shortReversalOk;

  const confirmTrendOkLong = !trendConfirm.bear || trendConfirm.bull;
  const confirmTrendOkShort = !trendConfirm.bull || trendConfirm.bear;

  const longReady =
    (trendNow.bear || !trendNow.bull) &&
    confirmTrendOkLong &&
    htfTrendOkLong &&
    extDown <= -params.emaExtension &&
    features.rsi <= params.rsiLow &&
    longStreak >= params.streakMin &&
    longVolumeOk &&
    longStructureOk &&
    dailyOkLong &&
    longLevelsOk;

  const shortReady =
    (trendNow.bull || !trendNow.bear) &&
    confirmTrendOkShort &&
    htfTrendOkShort &&
    extDown >= params.emaExtension &&
    features.rsi >= params.rsiHigh &&
    shortStreak >= params.streakMin &&
    shortVolumeOk &&
    shortStructureOk &&
    dailyOkShort &&
    shortLevelsOk;

  return {
    params,
    long: {
      direction: 'LONG',
      trendNow,
      trendConfirm,
      trendHigher,
      extension: extDown,
      rsi: features.rsi,
      streak: longStreak,
      volumeOk: longVolumeOk,
      levelsOk: longLevelsOk,
      structureOk: longStructureOk,
      reversalOk: longReversalOk,
      dailyOk: dailyOkLong,
      ready: longReady,
    },
    short: {
      direction: 'SHORT',
      trendNow,
      trendConfirm,
      trendHigher,
      extension: extDown,
      rsi: features.rsi,
      streak: shortStreak,
      volumeOk: shortVolumeOk,
      levelsOk: shortLevelsOk,
      structureOk: shortStructureOk,
      reversalOk: shortReversalOk,
      dailyOk: dailyOkShort,
      ready: shortReady,
    },
  };
}

export const MeanReversionSnapback: Strategy = {
  name: 'mean_reversion_snap',
  timeframe: '5m',

  async evaluate(ctx: StrategyContext) {
    const { exchange, symbol, config, state } = ctx;
    const candles = await exchange.getCandles(symbol, config.ENTRY_TIMEFRAME, 320);
    if (candles.length < 120) {
      return { action: 'IDLE', reason: 'mrs_few_candles' };
    }

    const confirmTf = ((config as any).MRS_CONFIRM_TF ?? '15m') as '3m' | '5m' | '15m' | '1h';
    const confirmCandles =
      confirmTf === config.ENTRY_TIMEFRAME
        ? candles
        : await exchange.getCandles(symbol, confirmTf, 240);

    const higherTf = ((config as any).MRS_HTF_TF ?? '1h') as '1h' | '4h';
    const higherLimit = higherTf === '4h' ? 160 : 320;
    const htfCandles =
      higherTf === config.ENTRY_TIMEFRAME
        ? candles
        : await exchange.getCandles(symbol, higherTf, higherLimit);

    const dailyCandles = await exchange.getCandles(symbol, '1d', 3);

    const analysis = analyzeSnapback({
      candles,
      confirmCandles,
      config,
      htfCandles,
      dailyCandles,
    });

    const alreadyLong = state.mode === 'LONG_RIDE';
    const alreadyShort = state.mode === 'SHORT_RIDE';

    if ((config as any).ALLOW_LONGS && analysis.long.ready) {
      if (alreadyLong) {
        return { action: 'IDLE', reason: 'mrs_block_long_active' };
      }
      return {
        action: 'ENTER_LONG',
        reason: `mrs_long ext=${(analysis.long.extension * 100).toFixed(2)}% rsi=${analysis.long.rsi.toFixed(1)}`,
        diagnostics: {
          strategy: MeanReversionSnapback.name,
          selection: 'LONG',
          analysis,
          alreadyLong,
          alreadyShort,
        },
      };
    }

    if ((config as any).ALLOW_SHORTS && analysis.short.ready) {
      if (alreadyShort) {
        return { action: 'IDLE', reason: 'mrs_block_short_active' };
      }
      return {
        action: 'ENTER_SHORT',
        reason: `mrs_short ext=${(analysis.short.extension * 100).toFixed(2)}% rsi=${analysis.short.rsi.toFixed(1)}`,
        diagnostics: {
          strategy: MeanReversionSnapback.name,
          selection: 'SHORT',
          analysis,
          alreadyLong,
          alreadyShort,
        },
      };
    }

    const reasonParts = [
      `long_ready=${Number(analysis.long.ready)}`,
      `short_ready=${Number(analysis.short.ready)}`,
      `long_daily=${Number(analysis.long.dailyOk)}`,
      `short_daily=${Number(analysis.short.dailyOk)}`,
      `long_structure=${Number(analysis.long.structureOk)}`,
      `short_structure=${Number(analysis.short.structureOk)}`,
    ];

    return {
      action: 'IDLE',
      reason: `mrs_filters ${reasonParts.join(' ')}`,
    };
  },
};
