// src/strategies/trend_follow.ts
import { Strategy, StrategyContext } from './types';
import { Candle } from '../core/types';
import { last, volumeAvg } from '../core/utils/candles';
import { ema } from '../core/indicators/ema';
import { adx } from '../core/indicators/adx';
import { atr as atrSingle } from '../core/indicators/atr';
import { supertrend } from '../core/indicators/supertrend';
import { computeFeatures } from '../core/utils/features';
import { computeLevels } from './shared/context';

function candleRange(c: Candle): number {
  return c.high - c.low;
}

function bodyRatio(c: Candle): number {
  const range = candleRange(c);
  if (range <= 0) return 0;
  return Math.abs(c.close - c.open) / range;
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

function isBullishHammer(c: Candle, params: TrendFollowParams): boolean {
  if (!Number.isFinite(c.open) || !Number.isFinite(c.close)) return false;
  if (c.close <= c.open) return false;
  const body = bodyRatio(c);
  const lower = lowerWickRatio(c);
  return body <= params.reversalBodyMax && lower >= params.hammerLowerWickMin;
}

function isBearishShootingStar(c: Candle, params: TrendFollowParams): boolean {
  if (!Number.isFinite(c.open) || !Number.isFinite(c.close)) return false;
  if (c.close >= c.open) return false;
  const body = bodyRatio(c);
  const upper = upperWickRatio(c);
  return body <= params.reversalBodyMax && upper >= params.shootingUpperWickMin;
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

type Direction = 'LONG' | 'SHORT';

export interface TrendFollowParams {
  timeframe: string;
  confirmTf1: '3m' | '5m' | '15m' | '1h';
  confirmTf2: '15m' | '1h' | '4h';
  atrLen: number;
  supertrendPeriod: number;
  supertrendMult: number;
  breakoutAtrMult: number;
  volFactor: number;
  volBasis: number;
  adxMin: number;
  maxExtension: number;
  longMaxRsi: number;
  shortMinRsi: number;
  structureLookback: number;
  structureExclude: number;
  longStructureMinDist: number;
  shortStructureMinDist: number;
  reversalBodyMax: number;
  hammerLowerWickMin: number;
  shootingUpperWickMin: number;
  dailyDropGuard: number;
  dailyPumpGuard: number;
  momentumLookback: number;
  momentumBreak: number;
  momentumSlopeMin: number;
  momentumEmaBandMin: number;
  shortRsiFloor: number;
}

export interface TrendFollowState {
  direction: Direction;
  trendOk: boolean;
  confirmOk: boolean;
  adx: number;
  breakoutOk: boolean;
  volumeOk: boolean;
  extensionOk: boolean;
  rsiOk: boolean;
  structureOk: boolean;
  momentumOk: boolean;
  dailyOk: boolean;
  reversalOk: boolean;
  slopeOk: boolean;
  ready: boolean;
  triggerPrice: number;
  stopLine: number;
  atr: number;
  volRatio: number;
  extensionPct: number;
  rsi: number;
}

export interface TrendFollowAnalysis {
  params: TrendFollowParams;
  lastCandle: Candle;
  emaFast: number;
  emaSlow: number;
  atr: number;
  adx: number;
  volRatio: number;
  long: TrendFollowState;
  short: TrendFollowState;
}

function buildState(
  dir: Direction,
  opts: {
    trendOk: boolean;
    confirmOk: boolean;
    adx: number;
    breakoutOk: boolean;
    volumeOk: boolean;
    triggerPrice: number;
    stopLine: number;
    atr: number;
    volRatio: number;
    extensionOk: boolean;
    rsiOk: boolean;
    extensionPct: number;
    rsi: number;
    structureOk: boolean;
    momentumOk: boolean;
    dailyOk: boolean;
    reversalOk: boolean;
    slopeOk: boolean;
    params: TrendFollowParams;
  },
): TrendFollowState {
  const {
    trendOk,
    confirmOk,
    adx,
    breakoutOk,
    volumeOk,
    extensionOk,
    rsiOk,
    extensionPct,
    rsi,
    triggerPrice,
    stopLine,
    atr,
    volRatio,
    structureOk,
    momentumOk,
    dailyOk,
    reversalOk,
    slopeOk,
    params,
  } = opts;
  const ready =
    trendOk &&
    confirmOk &&
    breakoutOk &&
    volumeOk &&
    extensionOk &&
    rsiOk &&
    structureOk &&
    momentumOk &&
    dailyOk &&
    reversalOk &&
    slopeOk &&
    Number.isFinite(adx) &&
    adx >= params.adxMin;
  return {
    direction: dir,
    trendOk,
    confirmOk,
    adx,
    breakoutOk,
    volumeOk,
    extensionOk,
    rsiOk,
    structureOk,
    momentumOk,
    dailyOk,
    reversalOk,
    slopeOk,
    ready,
    triggerPrice,
    stopLine,
    atr,
    volRatio,
    extensionPct,
    rsi,
  };
}

export function analyzeTrendFollow(opts: {
  candles: Candle[];
  confirmCandles1: Candle[];
  confirmCandles2: Candle[];
  config: StrategyContext['config'];
  dailyCandles?: Candle[];
}): TrendFollowAnalysis {
  const { candles, confirmCandles1, confirmCandles2, config } = opts;
  const dailyCandles = opts.dailyCandles ?? [];
  if (candles.length < 80) {
    throw new Error('Trend follow analysis requires candle data');
  }
  const params: TrendFollowParams = {
    timeframe: config.ENTRY_TIMEFRAME,
    confirmTf1: ((config as any).TF_CONFIRM_TF1 ?? '15m') as '3m' | '5m' | '15m' | '1h',
    confirmTf2: ((config as any).TF_CONFIRM_TF2 ?? '1h') as '15m' | '1h' | '4h',
    atrLen: Number((config as any).TF_ATR_LEN ?? 14),
    supertrendPeriod: Number((config as any).TF_SUPERTREND_PERIOD ?? 10),
    supertrendMult: Number((config as any).TF_SUPERTREND_MULT ?? 3),
    breakoutAtrMult: Number((config as any).TF_BREAKOUT_ATR_MULT ?? 0.5),
    volFactor: Number((config as any).TF_VOL_FACTOR ?? 1.2),
    volBasis: Math.max(Number((config as any).TF_VOL_BASIS ?? config.VOL_AVG_LEN ?? 20), 10),
    adxMin: Number((config as any).TF_ADX_MIN ?? 18),
    maxExtension: Number((config as any).TF_MAX_EXTENSION ?? 0.01),
    longMaxRsi: Number((config as any).TF_LONG_MAX_RSI ?? 70),
    shortMinRsi: Number((config as any).TF_SHORT_MIN_RSI ?? 30),
    structureLookback: Number((config as any).TF_STRUCTURE_LOOKBACK ?? 180),
    structureExclude: Number((config as any).TF_STRUCTURE_EXCLUDE ?? 2),
    longStructureMinDist: Number((config as any).TF_LONG_STRUCTURE_DIST ?? 0.01),
    shortStructureMinDist: Number((config as any).TF_SHORT_STRUCTURE_DIST ?? 0.01),
    reversalBodyMax: Number((config as any).TF_REVERSAL_BODY_MAX ?? 0.35),
    hammerLowerWickMin: Number((config as any).TF_HAMMER_LOWER_WICK_MIN ?? 0.45),
    shootingUpperWickMin: Number((config as any).TF_SHOOTING_UPPER_WICK_MIN ?? 0.45),
    dailyDropGuard: Number((config as any).TF_DAILY_DROP_GUARD ?? 0.08),
    dailyPumpGuard: Number((config as any).TF_DAILY_PUMP_GUARD ?? 0.08),
    momentumLookback: Number((config as any).TF_MOMENTUM_LOOKBACK ?? 6),
    momentumBreak: Number((config as any).TF_MOMENTUM_BREAK ?? 0.006),
    momentumSlopeMin: Number((config as any).TF_MOMENTUM_SLOPE_MIN ?? 0.0005),
    momentumEmaBandMin: Number((config as any).TF_MOMENTUM_EMA_BAND_MIN ?? 0.0015),
    shortRsiFloor: Number((config as any).TF_SHORT_RSI_FLOOR ?? 55),
  };

  const lastCandle = last(candles);
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const prevCandle = candles.length > 1 ? candles[candles.length - 2] : undefined;

  const emaUltraFastArr = ema(closes, config.EMA_FAST ?? 7);
  const emaUltraFast = emaUltraFastArr[emaUltraFastArr.length - 1];

  const emaFastArr = ema(closes, config.EMA_MID ?? 25);
  const emaSlowArr = ema(closes, config.EMA_SLOW ?? 99);
  const emaFast = emaFastArr[emaFastArr.length - 1];
  const emaSlow = emaSlowArr[emaSlowArr.length - 1];
  const emaBandRatio =
    Number.isFinite(emaUltraFast) && Number.isFinite(emaFast)
      ? Math.abs((emaUltraFast as number) - emaFast) / Math.max(Math.abs(emaFast), 1e-9)
      : 0;

  const stEntry = supertrend(candles, params.supertrendPeriod, params.supertrendMult);
  const stConfirm1 = supertrend(confirmCandles1, params.supertrendPeriod, params.supertrendMult);
  const stConfirm2 = supertrend(confirmCandles2, params.supertrendPeriod, params.supertrendMult);

  const atrValue = atrSingle(candles, params.atrLen);
  const { adx: adxValue } = adx(highs, lows, closes, params.atrLen);

  const volAvg = volumeAvg(candles, params.volBasis);
  const volRatio = volAvg > 0 ? lastCandle.volume / Math.max(volAvg, 1e-9) : 1;

  const longTrendOk = stEntry.trend === 'UP' && emaFast > emaSlow;
  const shortTrendOk = stEntry.trend === 'DOWN' && emaFast < emaSlow;

  const extensionPct = emaFast > 0 ? (lastCandle.close - emaFast) / emaFast : 0;
  const absExtension = Math.abs(extensionPct);
  const features = computeFeatures(candles);
  const rsi = features.rsi;
  const emaSlope = Number.isFinite(features.ema_slope) ? features.ema_slope : 0;

  const confirmLong = stConfirm1.trend === 'UP' && stConfirm2.trend === 'UP';
  const confirmShort = stConfirm1.trend === 'DOWN' && stConfirm2.trend === 'DOWN';

  const slopeOkLong = emaSlope >= params.momentumSlopeMin;
  const slopeOkShort = emaSlope <= -params.momentumSlopeMin;

  const breakoutLong = Number.isFinite(atrValue)
    ? lastCandle.close > emaFast + params.breakoutAtrMult * atrValue
    : false;
  const breakoutShort = Number.isFinite(atrValue)
    ? lastCandle.close < emaFast - params.breakoutAtrMult * atrValue
    : false;

  const structureExclude = Math.max(0, Math.floor(params.structureExclude));
  const structureLookback = Math.max(1, Math.floor(params.structureLookback));
  const htfLevels = computeLevels(confirmCandles2, structureExclude, structureLookback);
  const resistanceDist = Number.isFinite(htfLevels.resistance)
    ? (htfLevels.resistance - lastCandle.close) / Math.max(lastCandle.close, 1e-9)
    : Number.POSITIVE_INFINITY;
  const supportDist = Number.isFinite(htfLevels.support)
    ? (lastCandle.close - htfLevels.support) / Math.max(lastCandle.close, 1e-9)
    : Number.POSITIVE_INFINITY;

  const longStructureOk =
    resistanceDist === Number.POSITIVE_INFINITY || resistanceDist >= params.longStructureMinDist;
  const shortStructureOk =
    supportDist === Number.POSITIVE_INFINITY || supportDist >= params.shortStructureMinDist;

  const longReversalOk = !(
    isBearishShootingStar(lastCandle, params) || isBearishEngulfing(lastCandle, prevCandle)
  );
  const shortReversalOk = !(
    isBullishHammer(lastCandle, params) || isBullishEngulfing(lastCandle, prevCandle)
  );

  const lookback = Math.max(2, Math.floor(params.momentumLookback));
  const lowsWindow = candles.slice(-lookback - 1, -1);
  const highsWindow = candles.slice(-lookback - 1, -1);
  const recentLow = lowsWindow.length ? Math.min(...lowsWindow.map((c) => c.low)) : lastCandle.low;
  const recentHigh = highsWindow.length ? Math.max(...highsWindow.map((c) => c.high)) : lastCandle.high;
  const newShortBreak =
    recentLow <= 0
      ? true
      : (recentLow - lastCandle.low) / Math.max(recentLow, 1e-9) >= params.momentumBreak;
  const newLongBreak =
    recentHigh <= 0
      ? true
      : (lastCandle.high - recentHigh) / Math.max(recentHigh, 1e-9) >= params.momentumBreak;

  const shortMomentumOk =
    (!prevCandle || lastCandle.close <= prevCandle.close) &&
    (!Number.isFinite(emaUltraFast) || lastCandle.close <= emaUltraFast) &&
    emaBandRatio >= params.momentumEmaBandMin &&
    slopeOkShort &&
    newShortBreak;
  const longMomentumOk =
    (!prevCandle || lastCandle.close >= prevCandle.close) &&
    (!Number.isFinite(emaUltraFast) || lastCandle.close >= emaUltraFast) &&
    emaBandRatio >= params.momentumEmaBandMin &&
    slopeOkLong &&
    newLongBreak;

  const dailyCandle = dailyCandles.length ? last(dailyCandles) : undefined;
  let dailyLongOk = true;
  let dailyShortOk = true;
  if (dailyCandle && dailyCandle.open > 0) {
    const change = dailyCandle.close / dailyCandle.open - 1;
    if (Number.isFinite(change) && change <= -params.dailyDropGuard) {
      dailyLongOk = longStructureOk && newLongBreak && slopeOkLong;
      dailyShortOk = false;
    } else if (Number.isFinite(change) && change >= params.dailyPumpGuard) {
      dailyShortOk = shortStructureOk && newShortBreak && slopeOkShort;
      dailyLongOk = false;
    }
  }

  const longState = buildState('LONG', {
    trendOk: longTrendOk,
    confirmOk: confirmLong,
    adx: adxValue,
    breakoutOk: breakoutLong,
    volumeOk: volRatio >= params.volFactor,
    extensionOk: absExtension <= params.maxExtension,
    rsiOk: rsi <= params.longMaxRsi,
    structureOk: longStructureOk,
    momentumOk: longMomentumOk,
    dailyOk: dailyLongOk,
    reversalOk: longReversalOk,
    slopeOk: slopeOkLong,
    triggerPrice: lastCandle.close,
    stopLine: stEntry.line,
    atr: atrValue,
    volRatio,
    extensionPct,
    rsi,
    params,
  });

  const shortState = buildState('SHORT', {
    trendOk: shortTrendOk,
    confirmOk: confirmShort,
    adx: adxValue,
    breakoutOk: breakoutShort,
    volumeOk: volRatio >= params.volFactor,
    extensionOk: absExtension <= params.maxExtension,
    rsiOk: rsi >= Math.max(params.shortMinRsi, params.shortRsiFloor),
    structureOk: shortStructureOk,
    momentumOk: shortMomentumOk,
    dailyOk: dailyShortOk,
    reversalOk: shortReversalOk,
    slopeOk: slopeOkShort,
    triggerPrice: lastCandle.close,
    stopLine: stEntry.line,
    atr: atrValue,
    volRatio,
    extensionPct,
    rsi,
    params,
  });

  return {
    params,
    lastCandle,
    emaFast,
    emaSlow,
    atr: atrValue,
    adx: adxValue,
    volRatio,
    long: longState,
    short: shortState,
  };
}

export const TrendFollow: Strategy = {
  name: 'trend_follow',
  timeframe: '5m',

  async evaluate(ctx: StrategyContext) {
    const { exchange, symbol, config } = ctx;
    const entryTf = config.ENTRY_TIMEFRAME;
    const confirmTf1 = ((config as any).TF_CONFIRM_TF1 ?? '15m') as '3m' | '5m' | '15m' | '1h';
    const confirmTf2 = ((config as any).TF_CONFIRM_TF2 ?? '1h') as '15m' | '1h' | '4h';

    const candles = await exchange.getCandles(symbol, entryTf, 320);
    if (candles.length < 80) {
      return { action: 'IDLE', reason: 'tf_few_candles' };
    }

    const confirmCandles1 =
      confirmTf1 === entryTf ? candles : await exchange.getCandles(symbol, confirmTf1, 240);
    const confirmCandles2 =
      confirmTf2 === entryTf
        ? candles
        : confirmTf2 === confirmTf1
          ? confirmCandles1
          : await exchange.getCandles(symbol, confirmTf2, 240);

    const dailyCandles = await exchange.getCandles(symbol, '1d', 3);

    const analysis = analyzeTrendFollow({
      candles,
      confirmCandles1,
      confirmCandles2,
      config,
      dailyCandles,
    });

    const lastDaily = dailyCandles.length ? dailyCandles[dailyCandles.length - 1] : undefined;
    const dailyChange =
      lastDaily && lastDaily.open > 0 ? lastDaily.close / lastDaily.open - 1 : NaN;
    const allowLongDaily = analysis.long.dailyOk;
    const allowShortDaily = analysis.short.dailyOk;

    if ((config as any).ALLOW_LONGS && analysis.long.ready) {
      return {
        action: 'ENTER_LONG',
        reason: `tf_long atr=${analysis.atr.toFixed(6)} adx=${analysis.adx.toFixed(
          2,
        )} volx=${analysis.long.volRatio.toFixed(2)} ext=${(
          analysis.long.extensionPct * 100
        ).toFixed(2)} rsi=${analysis.long.rsi.toFixed(1)}`,
        diagnostics: {
          strategy: TrendFollow.name,
          selection: 'LONG',
          analysis,
          dailyChange,
          allowDaily: allowLongDaily,
          confirmTf1,
          confirmTf2,
        },
      };
    }

    if ((config as any).ALLOW_SHORTS && analysis.short.ready) {
      return {
        action: 'ENTER_SHORT',
        reason: `tf_short atr=${analysis.atr.toFixed(6)} adx=${analysis.adx.toFixed(
          2,
        )} volx=${analysis.short.volRatio.toFixed(2)} ext=${(
          analysis.short.extensionPct * 100
        ).toFixed(2)} rsi=${analysis.short.rsi.toFixed(1)} structure=${Number(
          analysis.short.structureOk,
        )} momentum=${Number(analysis.short.momentumOk)} daily=${Number(
          analysis.short.dailyOk,
        )} slope=${Number(analysis.short.slopeOk)}`,
        diagnostics: {
          strategy: TrendFollow.name,
          selection: 'SHORT',
          analysis,
          dailyChange,
          allowDaily: allowShortDaily,
          confirmTf1,
          confirmTf2,
        },
      };
    }

    return {
      action: 'IDLE',
      reason: `tf_filters long=${Number(analysis.long.ready)} short=${Number(
        analysis.short.ready,
      )} short_struct=${Number(analysis.short.structureOk)} short_rev=${Number(
        analysis.short.reversalOk,
      )} short_mom=${Number(analysis.short.momentumOk)} short_slope=${Number(
        analysis.short.slopeOk,
      )} short_daily=${Number(analysis.short.dailyOk)}`,
    };
  },
};
