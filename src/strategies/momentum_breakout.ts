// src/strategies/momentum_breakout.ts
import { Strategy, StrategyContext } from './types';
import { bodyPct, last, volumeAvg } from '../core/utils/candles';
import { ema } from '../core/indicators/ema';
import { adx as adxCalc } from '../core/indicators/adx';
import { Candle } from '../core/types';

type Direction = 'LONG' | 'SHORT';

export const MOMENTUM_TIMEFRAME = '3m';

type TrendSignals = {
  bull: boolean;
  bear: boolean;
  adx: number;
  emaFast: number;
  emaMid: number;
  emaSlow: number;
};

function getTrendSignals(
  candles: Candle[],
  config: StrategyContext['config'],
): TrendSignals {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);

  if (closes.length < Math.max(config.EMA_SLOW, config.ADX_LEN) + 5) {
    return {
      bull: false,
      bear: false,
      adx: NaN,
      emaFast: NaN,
      emaMid: NaN,
      emaSlow: NaN,
    };
  }

  const emaFastArr = ema(closes, config.EMA_FAST);
  const emaMidArr = ema(closes, config.EMA_MID);
  const emaSlowArr = ema(closes, config.EMA_SLOW);

  const emaFast = emaFastArr[emaFastArr.length - 1];
  const emaMid = emaMidArr[emaMidArr.length - 1];
  const emaSlow = emaSlowArr[emaSlowArr.length - 1];

  const { adx } = adxCalc(highs, lows, closes, config.ADX_LEN);
  const adxVal = Number.isFinite(adx) ? (adx as number) : NaN;

  return {
    bull: emaFast > emaMid && emaMid > emaSlow,
    bear: emaFast < emaMid && emaMid < emaSlow,
    adx: adxVal,
    emaFast,
    emaMid,
    emaSlow,
  };
}

type StreakResult = {
  ok: boolean;
  streak: number;
  weakestVolRatio: number;
};

function streakMomentum(
  candles: Candle[],
  dir: Direction,
  volAvg: number,
  config: StrategyContext['config'],
): StreakResult {
  const minNeeded = Math.max(2, Number((config as any).MOM_CONSEC_MIN ?? 2));
  const maxAllowed = Math.max(minNeeded, Number((config as any).MOM_CONSEC_MAX ?? 3));
  const volFactor =
    Number((config as any).MOM_VOL_FACTOR ?? (config as any).VOL_FACTOR_ENTRY ?? 1.4);
  const bodyMin = Number((config as any).MOM_BODY_PCT_MIN ?? 0.55);

  let prevClose = dir === 'LONG' ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  let streak = 0;
  let weakestVolRatio = Number.POSITIVE_INFINITY;

  for (let i = candles.length - 1; i >= 0; i--) {
    const c = candles[i];
    const isGreen = c.close > c.open;
    const isRed = c.close < c.open;
    const directionalOk = dir === 'LONG' ? isGreen : isRed;
    if (!directionalOk) break;

    const volRatio = volAvg > 0 ? c.volume / volAvg : 1;
    if (volRatio < volFactor) break;
    weakestVolRatio = Math.min(weakestVolRatio, volRatio);

    const body = bodyPct(c);
    if (!Number.isFinite(body) || body < bodyMin) break;

    const closeMonotonic =
      dir === 'LONG' ? c.close < prevClose - 1e-9 : c.close > prevClose + 1e-9;
    if (!closeMonotonic && streak > 0) break;

    streak += 1;
    prevClose = c.close;
    if (streak >= maxAllowed) break;
  }

  return {
    ok: streak >= minNeeded,
    streak,
    weakestVolRatio: weakestVolRatio === Number.POSITIVE_INFINITY ? 0 : weakestVolRatio,
  };
}

function computeLevels(
  candles: Candle[],
  excludeLastN: number,
  lookback: number,
): { resistance: number; support: number } {
  const cutoff = candles.length - excludeLastN;
  const start = Math.max(0, cutoff - lookback);
  const window = candles.slice(start, cutoff);
  if (window.length === 0) {
    return { resistance: NaN, support: NaN };
  }

  let resistance = -Infinity;
  let support = Infinity;
  for (const c of window) {
    if (c.high > resistance) resistance = c.high;
    if (c.low < support) support = c.low;
  }
  return { resistance, support };
}

export interface MomentumParams {
  timeframe: string;
  confirmTf: '3m' | '5m' | '15m' | '1h';
  streakMin: number;
  streakMax: number;
  volFactor: number;
  bodyMin: number;
  volBasis: number;
  srBuffer: number;
  adxMin: number;
}

export interface MomentumDirectionState {
  direction: Direction;
  streak: number;
  streakOk: boolean;
  weakestVolRatio: number;
  trendOk: boolean;
  breakoutOk: boolean;
  triggerPrice: number;
  baseLevel: number;
  priceToTriggerPct: number;
  priceVsLevelPct: number;
  ready: boolean;
}

export interface MomentumAnalysis {
  params: MomentumParams;
  volumeAvg: number;
  lastCandle: Candle;
  levels: { resistance: number; support: number };
  trendNow: TrendSignals;
  trendConfirm: TrendSignals;
  long: MomentumDirectionState;
  short: MomentumDirectionState;
}

export function analyzeMomentumBreakout(opts: {
  candles: Candle[];
  confirmCandles: Candle[];
  config: StrategyContext['config'];
  confirmTf: '3m' | '5m' | '15m' | '1h';
}): MomentumAnalysis {
  const { candles, confirmCandles, config, confirmTf } = opts;
  if (!candles.length) {
    throw new Error('Momentum analysis requires candle data');
  }
  const lastCandle = last(candles);
  const streakMin = Math.max(2, Number((config as any).MOM_CONSEC_MIN ?? 2));
  const streakMax = Math.max(streakMin, Number((config as any).MOM_CONSEC_MAX ?? 3));
  const params: MomentumParams = {
    timeframe: MOMENTUM_TIMEFRAME,
    confirmTf,
    streakMin,
    streakMax,
    volFactor: Number((config as any).MOM_VOL_FACTOR ?? (config as any).VOL_FACTOR_ENTRY ?? 1.4),
    bodyMin: Number((config as any).MOM_BODY_PCT_MIN ?? 0.55),
    volBasis: Math.max(10, Number(config.VOL_AVG_LEN) || 0),
    srBuffer: Number((config as any).MOM_SR_BUFFER ?? 0.0015),
    adxMin: Number((config as any).MOM_TREND_ADX_MIN ?? config.ADX_MIN ?? 20),
  };

  const volAvg = volumeAvg(candles, params.volBasis);
  const streakLong = streakMomentum(candles, 'LONG', volAvg, config);
  const streakShort = streakMomentum(candles, 'SHORT', volAvg, config);

  const exclude = Math.max(streakLong.streak, streakShort.streak, 3);
  const lookback = Number((config as any).MOM_SR_LOOKBACK ?? 36);
  const levels = computeLevels(candles, exclude, lookback);

  const trendNow = getTrendSignals(candles, config);
  const trendConfirm = getTrendSignals(confirmCandles, config);

  const longTrendOk =
    trendNow.bull &&
    trendConfirm.bull &&
    Number.isFinite(trendNow.adx) &&
    trendNow.adx >= params.adxMin &&
    Number.isFinite(trendConfirm.adx) &&
    trendConfirm.adx >= params.adxMin;

  const shortTrendOk =
    trendNow.bear &&
    trendConfirm.bear &&
    Number.isFinite(trendNow.adx) &&
    trendNow.adx >= params.adxMin &&
    Number.isFinite(trendConfirm.adx) &&
    trendConfirm.adx >= params.adxMin;

  const lastClose = lastCandle.close;

  const resistance = levels.resistance;
  const support = levels.support;

  const longTrigger = Number.isFinite(resistance) ? resistance * (1 + params.srBuffer) : NaN;
  const priceToLongTrigger = Number.isFinite(longTrigger)
    ? (longTrigger - lastClose) / longTrigger
    : NaN;
  const priceVsResistance = Number.isFinite(resistance)
    ? (lastClose - resistance) / resistance
    : NaN;
  const breakoutLong =
    Number.isFinite(resistance) && lastClose > resistance * (1 + params.srBuffer);

  const shortTrigger = Number.isFinite(support) ? support * (1 - params.srBuffer) : NaN;
  const priceToShortTrigger = Number.isFinite(shortTrigger)
    ? (lastClose - shortTrigger) / shortTrigger
    : NaN;
  const priceVsSupport = Number.isFinite(support)
    ? (lastClose - support) / support
    : NaN;
  const breakdownShort =
    Number.isFinite(support) && lastClose < support * (1 - params.srBuffer);

  const longState: MomentumDirectionState = {
    direction: 'LONG',
    streak: streakLong.streak,
    streakOk: streakLong.ok,
    weakestVolRatio: streakLong.weakestVolRatio,
    trendOk: longTrendOk,
    breakoutOk: breakoutLong,
    triggerPrice: longTrigger,
    baseLevel: resistance,
    priceToTriggerPct: priceToLongTrigger,
    priceVsLevelPct: priceVsResistance,
    ready: streakLong.ok && longTrendOk && breakoutLong,
  };

  const shortState: MomentumDirectionState = {
    direction: 'SHORT',
    streak: streakShort.streak,
    streakOk: streakShort.ok,
    weakestVolRatio: streakShort.weakestVolRatio,
    trendOk: shortTrendOk,
    breakoutOk: breakdownShort,
    triggerPrice: shortTrigger,
    baseLevel: support,
    priceToTriggerPct: priceToShortTrigger,
    priceVsLevelPct: priceVsSupport,
    ready: streakShort.ok && shortTrendOk && breakdownShort,
  };

  return {
    params,
    volumeAvg: volAvg,
    lastCandle,
    levels,
    trendNow,
    trendConfirm,
    long: longState,
    short: shortState,
  };
}

export const MomentumBreakout: Strategy = {
  name: 'momentum_breakout',
  timeframe: MOMENTUM_TIMEFRAME,

  async evaluate(ctx: StrategyContext) {
    const { exchange, symbol, config } = ctx;

    const candles = await exchange.getCandles(symbol, MOMENTUM_TIMEFRAME, 320);
    if (candles.length < 80) {
      return { action: 'IDLE', reason: 'mom_few_candles' };
    }

    const confirmTf = ((config as any).MOM_TREND_CONFIRM_TF ?? '15m') as
      | '3m'
      | '5m'
      | '15m'
      | '1h';
    const confirmCandles =
      confirmTf === MOMENTUM_TIMEFRAME
        ? candles
        : await exchange.getCandles(symbol, confirmTf, 300);
    const analysis = analyzeMomentumBreakout({
      candles,
      confirmCandles,
      config,
      confirmTf,
    });

    const adxNowStr = Number.isFinite(analysis.trendNow.adx)
      ? analysis.trendNow.adx.toFixed(1)
      : 'NaN';

    if ((config as any).ALLOW_LONGS && analysis.long.ready) {
      return {
        action: 'ENTER_LONG',
        reason: `mom_long streak=${analysis.long.streak} volx=${analysis.long.weakestVolRatio.toFixed(
          2,
        )} adx=${adxNowStr} confTf=${analysis.params.confirmTf}`,
      };
    }

    if ((config as any).ALLOW_SHORTS && analysis.short.ready) {
      return {
        action: 'ENTER_SHORT',
        reason: `mom_short streak=${analysis.short.streak} volx=${analysis.short.weakestVolRatio.toFixed(
          2,
        )} adx=${adxNowStr} confTf=${analysis.params.confirmTf}`,
      };
    }

    return {
      action: 'IDLE',
      reason: `mom_filters long=${Number(analysis.long.ready)} short=${Number(
        analysis.short.ready,
      )} adx=${adxNowStr}`,
    };
  },
};
