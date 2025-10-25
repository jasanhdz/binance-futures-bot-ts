// src/strategies/volatility_trend_ride.ts
import { Strategy, StrategyContext } from './types';
import { Candle } from '../core/types';
import { ema } from '../core/indicators/ema';
import { last, volumeAvg } from '../core/utils/candles';
import { atr } from '../core/indicators/atr';
import { computeFeatures } from '../core/utils/features';

type Direction = 'LONG' | 'SHORT';

export interface TrendRideParams {
  timeframe: string;
  atrLen: number;
  keltnerMult: number;
  retraceBand: number;
  volRatioMin: number;
  slopeMin: number;
  rsiHigh: number;
  rsiLow: number;
}

export interface TrendRideState {
  direction: Direction;
  emaFast: number;
  emaSlow: number;
  atr: number;
  keltnerUpper: number;
  keltnerLower: number;
  volRatio: number;
  rsi: number;
  slope: number;
  ready: boolean;
}

export interface TrendRideAnalysis {
  params: TrendRideParams;
  last: Candle;
  long: TrendRideState;
  short: TrendRideState;
}

export function analyzeTrendRide(opts: {
  candles: Candle[];
  config: StrategyContext['config'];
}): TrendRideAnalysis {
  const { candles, config } = opts;
  if (candles.length < 160) {
    throw new Error('Trend ride analysis requires 160 candles');
  }

  const params: TrendRideParams = {
    timeframe: config.ENTRY_TIMEFRAME || '5m',
    atrLen: Number((config as any).TR_ATR_LEN ?? 21),
    keltnerMult: Number((config as any).TR_KELTNER_MULT ?? 1.5),
    retraceBand: Number((config as any).TR_RETRACE_BAND ?? 0.35),
    volRatioMin: Number((config as any).TR_VOL_RATIO_MIN ?? 1.0),
    slopeMin: Number((config as any).TR_SLOPE_MIN ?? 0.0004),
    rsiHigh: Number((config as any).TR_RSI_HIGH ?? 70),
    rsiLow: Number((config as any).TR_RSI_LOW ?? 30),
  };

  const closes = candles.map((c) => c.close);
  const emaFastSeries = ema(closes, config.EMA_FAST ?? 7);
  const emaMidSeries = ema(closes, config.EMA_MID ?? 25);
  const emaSlowSeries = ema(closes, config.EMA_SLOW ?? 99);
  const emaFastVal = emaFastSeries[emaFastSeries.length - 1];
  const emaMidVal = emaMidSeries[emaMidSeries.length - 1];
  const emaSlowVal = emaSlowSeries[emaSlowSeries.length - 1];

  const atrVal = atr(candles, params.atrLen);
  const lastCandle = last(candles);
  const keltnerUpper = emaMidVal + params.keltnerMult * atrVal;
  const keltnerLower = emaMidVal - params.keltnerMult * atrVal;

  const volAvg = volumeAvg(candles, 40);
  const volRatio = volAvg > 0 ? lastCandle.volume / Math.max(volAvg, 1e-9) : 1;
  const features = computeFeatures(candles);

  const slope =
    emaMidSeries.length > 8
      ? (emaMidSeries[emaMidSeries.length - 1] - emaMidSeries[emaMidSeries.length - 8]) /
        Math.max(Math.abs(emaMidSeries[emaMidSeries.length - 8]), 1e-9)
      : 0;

  const retraceLong =
    lastCandle.low <= emaMidVal &&
    lastCandle.low >= emaMidVal - params.retraceBand * (emaMidVal - keltnerLower);
  const retraceShort =
    lastCandle.high >= emaMidVal &&
    lastCandle.high <= emaMidVal + params.retraceBand * (keltnerUpper - emaMidVal);

  const longReady =
    emaFastVal > emaMidVal &&
    emaMidVal > emaSlowVal &&
    Number.isFinite(slope) &&
    slope >= params.slopeMin &&
    retraceLong &&
    volRatio >= params.volRatioMin &&
    features.rsi <= params.rsiHigh;

  const shortReady =
    emaFastVal < emaMidVal &&
    emaMidVal < emaSlowVal &&
    Number.isFinite(slope) &&
    slope <= -params.slopeMin &&
    retraceShort &&
    volRatio >= params.volRatioMin &&
    features.rsi >= params.rsiLow;

  return {
    params,
    last: lastCandle,
    long: {
      direction: 'LONG',
      emaFast: emaFastVal,
      emaSlow: emaSlowVal,
      atr: atrVal,
      keltnerUpper,
      keltnerLower,
      volRatio,
      rsi: features.rsi,
      slope,
      ready: longReady,
    },
    short: {
      direction: 'SHORT',
      emaFast: emaFastVal,
      emaSlow: emaSlowVal,
      atr: atrVal,
      keltnerUpper,
      keltnerLower,
      volRatio,
      rsi: features.rsi,
      slope,
      ready: shortReady,
    },
  };
}

export const VolatilityTrendRide: Strategy = {
  name: 'volatility_trend_ride',
  timeframe: '5m',

  async evaluate(ctx: StrategyContext) {
    const { exchange, symbol, config } = ctx;
    const timeframe = config.ENTRY_TIMEFRAME || '5m';
    const candles = await exchange.getCandles(symbol, timeframe, 320);
    if (candles.length < 200) {
      return { action: 'IDLE', reason: 'tr_few_candles' };
    }

    const analysis = analyzeTrendRide({ candles, config });

    if ((config as any).ALLOW_LONGS !== false && analysis.long.ready) {
      return {
        action: 'ENTER_LONG',
        reason: `tr_long slope=${analysis.long.slope.toFixed(4)} atr=${analysis.long.atr.toFixed(
          6,
        )} vol=${analysis.long.volRatio.toFixed(2)} rsi=${analysis.long.rsi.toFixed(1)}`,
        diagnostics: {
          strategy: VolatilityTrendRide.name,
          selection: 'LONG',
          analysis,
        },
      };
    }

    if ((config as any).ALLOW_SHORTS !== false && analysis.short.ready) {
      return {
        action: 'ENTER_SHORT',
        reason: `tr_short slope=${analysis.short.slope.toFixed(4)} atr=${analysis.short.atr.toFixed(
          6,
        )} vol=${analysis.short.volRatio.toFixed(2)} rsi=${analysis.short.rsi.toFixed(1)}`,
        diagnostics: {
          strategy: VolatilityTrendRide.name,
          selection: 'SHORT',
          analysis,
        },
      };
    }

    return {
      action: 'IDLE',
      reason: `tr_filters long=${Number(analysis.long.ready)} short=${Number(
        analysis.short.ready,
      )} slope=${analysis.long.slope.toFixed(4)} rsi=${analysis.long.rsi.toFixed(1)}`,
      diagnostics: {
        strategy: VolatilityTrendRide.name,
        analysis,
      },
    };
  },
};
