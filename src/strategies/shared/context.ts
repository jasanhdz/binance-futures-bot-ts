// src/strategies/shared/context.ts
import { ema } from '../../core/indicators/ema';
import { adx as adxCalc } from '../../core/indicators/adx';
import { Candle } from '../../core/types';
import { StrategyContext } from '../types';

export type TrendSignals = {
  bull: boolean;
  bear: boolean;
  adx: number;
  emaFast: number;
  emaMid: number;
  emaSlow: number;
};

export function getTrendSignals(
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

export function computeLevels(
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
