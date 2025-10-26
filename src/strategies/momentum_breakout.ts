// src/strategies/momentum_breakout.ts
import { Strategy, StrategyContext } from './types';
import { last, volumeAvg } from '../core/utils/candles';
import { Candle } from '../core/types';
import { computeLevels, getTrendSignals, TrendSignals } from './shared/context';

type Direction = 'LONG' | 'SHORT';

export const MOMENTUM_TIMEFRAME = '3m';

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
  const volFactor =
    Number((config as any).MOM_VOL_FACTOR ?? (config as any).VOL_FACTOR_ENTRY ?? 1.3);

  let streak = 0;
  let weakestVolRatio = Number.POSITIVE_INFINITY;

  for (let i = candles.length - 1; i >= 0; i--) {
    const c = candles[i];
    const directionalOk = dir === 'LONG' ? c.close > c.open : c.close < c.open;
    if (!directionalOk) break;

    const volRatio = volAvg > 0 ? c.volume / Math.max(volAvg, 1e-9) : 1;
    if (volRatio < volFactor) break;
    weakestVolRatio = Math.min(weakestVolRatio, volRatio);

    streak += 1;
    if (streak >= 2) break;
  }

  return {
    ok: streak >= 2,
    streak,
    weakestVolRatio: weakestVolRatio === Number.POSITIVE_INFINITY ? 0 : weakestVolRatio,
  };
}

export interface MomentumParams {
  timeframe: string;
  confirmTf: '3m' | '5m' | '15m' | '1h';
  streakMin: number;
  streakMax: number;
  volFactor: number;
  volBasis: number;
  srBuffer: number;
  adxMin: number;
  roomBuffer: number;
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
  const streakMin = 2;
  const streakMax = 2;
  const params: MomentumParams = {
    timeframe: MOMENTUM_TIMEFRAME,
    confirmTf,
    streakMin,
    streakMax,
    volFactor: Number((config as any).MOM_VOL_FACTOR ?? (config as any).VOL_FACTOR_ENTRY ?? 1.3),
    volBasis: Math.max(10, Number(config.VOL_AVG_LEN) || 0),
    srBuffer: Number((config as any).MOM_SR_BUFFER ?? 0.001),
    adxMin: Number((config as any).MOM_TREND_ADX_MIN ?? 0),
    roomBuffer: Number((config as any).MOM_ROOM_MIN ?? 0.003),
  };

  const volAvg = volumeAvg(candles, params.volBasis);
  const streakLong = streakMomentum(candles, 'LONG', volAvg, config);
  const streakShort = streakMomentum(candles, 'SHORT', volAvg, config);

  const exclude = Math.max(streakLong.streak, streakShort.streak, 3);
  const lookback = Number((config as any).MOM_SR_LOOKBACK ?? 36);
  const levels = computeLevels(candles, exclude, lookback);

  const trendNow = getTrendSignals(candles, config);
  const trendConfirm = getTrendSignals(confirmCandles, config);

  const longTrendOk = trendNow.bull && trendConfirm.bull;
  const shortTrendOk = trendNow.bear && trendConfirm.bear;

  const lastClose = lastCandle.close;
  const resistance = levels.resistance;
  const support = levels.support;

  const aboveSupport = Number.isFinite(support)
    ? lastClose >= support * (1 + params.srBuffer)
    : true;
  const belowResistance = Number.isFinite(resistance)
    ? lastClose <= resistance * (1 - params.srBuffer)
    : true;
  const roomToResistance = Number.isFinite(resistance)
    ? Math.max(0, (resistance - lastClose) / Math.max(resistance, 1e-9))
    : Number.POSITIVE_INFINITY;
  const roomToSupport = Number.isFinite(support)
    ? Math.max(0, (lastClose - support) / Math.max(support, 1e-9))
    : Number.POSITIVE_INFINITY;

  const longLevelsOk = aboveSupport && roomToResistance >= params.roomBuffer;
  const shortLevelsOk = belowResistance && roomToSupport >= params.roomBuffer;

  const longState: MomentumDirectionState = {
    direction: 'LONG',
    streak: streakLong.streak,
    streakOk: streakLong.ok,
    weakestVolRatio: streakLong.weakestVolRatio,
    trendOk: longTrendOk,
    breakoutOk: longLevelsOk,
    triggerPrice: Number.isFinite(resistance) ? resistance : NaN,
    baseLevel: resistance,
    priceToTriggerPct: Number.isFinite(resistance) ? roomToResistance : NaN,
    priceVsLevelPct: Number.isFinite(support) ? roomToSupport : NaN,
    ready: streakLong.ok && longTrendOk && longLevelsOk,
  };

  const shortState: MomentumDirectionState = {
    direction: 'SHORT',
    streak: streakShort.streak,
    streakOk: streakShort.ok,
    weakestVolRatio: streakShort.weakestVolRatio,
    trendOk: shortTrendOk,
    breakoutOk: shortLevelsOk,
    triggerPrice: Number.isFinite(support) ? support : NaN,
    baseLevel: support,
    priceToTriggerPct: Number.isFinite(support) ? roomToSupport : NaN,
    priceVsLevelPct: Number.isFinite(resistance) ? roomToResistance : NaN,
    ready: streakShort.ok && shortTrendOk && shortLevelsOk,
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
        )} trend=bull room=${Number.isFinite(analysis.long.priceToTriggerPct) ? (analysis.long.priceToTriggerPct * 100).toFixed(2) : 'n/a'}% adx=${adxNowStr}`,
        diagnostics: {
          strategy: MomentumBreakout.name,
          selection: 'LONG',
          confirmTf,
          analysis,
        },
      };
    }

    if ((config as any).ALLOW_SHORTS && analysis.short.ready) {
      return {
        action: 'ENTER_SHORT',
        reason: `mom_short streak=${analysis.short.streak} volx=${analysis.short.weakestVolRatio.toFixed(
          2,
        )} trend=bear room=${Number.isFinite(analysis.short.priceToTriggerPct) ? (analysis.short.priceToTriggerPct * 100).toFixed(2) : 'n/a'}% adx=${adxNowStr}`,
        diagnostics: {
          strategy: MomentumBreakout.name,
          selection: 'SHORT',
          confirmTf,
          analysis,
        },
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
