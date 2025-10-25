// src/strategies/range_breakout_continuation.ts
import { Strategy, StrategyContext } from './types';
import { Candle } from '../core/types';
import { last, volumeAvg, atrPctNow } from '../core/utils/candles';
import { getTrendSignals } from './shared/context';

type Direction = 'LONG' | 'SHORT';

export interface RangeBreakoutParams {
  timeframe: string;
  confirmTf: '5m' | '15m' | '30m' | '1h';
  rangeLookback: number;
  rangeExclude: number;
  rangeWidthMax: number;
  breakoutBuffer: number;
  atrPctMax: number;
  volRatioMin: number;
  trendAdxMin: number;
}

export interface RangeBreakoutState {
  direction: Direction;
  rangeHigh: number;
  rangeLow: number;
  rangeWidthPct: number;
  atrPct: number;
  volRatio: number;
  trendAligned: boolean;
  confirmAligned: boolean;
  ready: boolean;
}

export interface RangeBreakoutAnalysis {
  params: RangeBreakoutParams;
  last: Candle;
  prev: Candle;
  long: RangeBreakoutState;
  short: RangeBreakoutState;
}

const fmt = (value: number | undefined, digits = 4) =>
  Number.isFinite(value ?? NaN) ? (value as number).toFixed(digits) : 'n/a';

const fmtPct = (value: number, digits = 2) =>
  Number.isFinite(value) ? (value * 100).toFixed(digits) + '%' : 'n/a';

function computeRange(
  candles: Candle[],
  lookback: number,
  exclude: number,
): { high: number; low: number } {
  const end = Math.max(0, candles.length - exclude);
  const start = Math.max(0, end - lookback);
  const window = candles.slice(start, end);
  if (!window.length) return { high: NaN, low: NaN };
  let high = -Infinity;
  let low = Infinity;
  for (const c of window) {
    if (c.high > high) high = c.high;
    if (c.low < low) low = c.low;
  }
  return { high, low };
}

export function analyzeRangeBreakout(opts: {
  candles: Candle[];
  confirmCandles: Candle[];
  config: StrategyContext['config'];
}): RangeBreakoutAnalysis {
  const { candles, confirmCandles, config } = opts;
  const params: RangeBreakoutParams = {
    timeframe: config.ENTRY_TIMEFRAME || '5m',
    confirmTf: ((config as any).RBC_CONFIRM_TF ?? '15m') as '5m' | '15m' | '30m' | '1h',
    rangeLookback: Number((config as any).RBC_RANGE_LOOKBACK ?? 36),
    rangeExclude: Number((config as any).RBC_RANGE_EXCLUDE ?? 4),
    rangeWidthMax: Number((config as any).RBC_RANGE_WIDTH_MAX ?? 0.007),
    breakoutBuffer: Number((config as any).RBC_BREAKOUT_BUFFER ?? 0.0008),
    atrPctMax: Number((config as any).RBC_ATR_PCT_MAX ?? 0.012),
    volRatioMin: Number((config as any).RBC_VOL_RATIO_MIN ?? 1.5),
    trendAdxMin: Number((config as any).RBC_TREND_ADX_MIN ?? 16),
  };

  const lastCandle = last(candles);
  const prevCandle = candles[candles.length - 2];

  const range = computeRange(candles, params.rangeLookback, params.rangeExclude);
  const rangeWidthPct =
    Number.isFinite(range.high) && Number.isFinite(range.low) && range.high > 0
      ? (range.high - range.low) / range.high
      : Number.POSITIVE_INFINITY;

  const atrPct = atrPctNow(candles, Math.min(params.rangeLookback, 20));
  const volAvg = volumeAvg(candles, Math.max(10, Math.floor(params.rangeLookback / 2)));
  const volRatio = volAvg > 0 ? lastCandle.volume / Math.max(volAvg, 1e-9) : 1;

  const trendNow = getTrendSignals(candles, config);
  const trendConfirm = getTrendSignals(confirmCandles, config);

  const longReady =
    Number.isFinite(range.high) &&
    rangeWidthPct <= params.rangeWidthMax &&
    atrPct <= params.atrPctMax &&
    volRatio >= params.volRatioMin &&
    trendNow.bull &&
    trendConfirm.bull &&
    Number.isFinite(trendNow.adx) &&
    trendNow.adx >= params.trendAdxMin &&
    lastCandle.close > range.high * (1 + params.breakoutBuffer) &&
    prevCandle.close <= range.high * (1 + params.breakoutBuffer);

  const shortReady =
    Number.isFinite(range.low) &&
    rangeWidthPct <= params.rangeWidthMax &&
    atrPct <= params.atrPctMax &&
    volRatio >= params.volRatioMin &&
    trendNow.bear &&
    trendConfirm.bear &&
    Number.isFinite(trendNow.adx) &&
    trendNow.adx >= params.trendAdxMin &&
    lastCandle.close < range.low * (1 - params.breakoutBuffer) &&
    prevCandle.close >= range.low * (1 - params.breakoutBuffer);

  return {
    params,
    last: lastCandle,
    prev: prevCandle,
    long: {
      direction: 'LONG',
      rangeHigh: range.high,
      rangeLow: range.low,
      rangeWidthPct,
      atrPct,
      volRatio,
      trendAligned: trendNow.bull,
      confirmAligned: trendConfirm.bull,
      ready: longReady,
    },
    short: {
      direction: 'SHORT',
      rangeHigh: range.high,
      rangeLow: range.low,
      rangeWidthPct,
      atrPct,
      volRatio,
      trendAligned: trendNow.bear,
      confirmAligned: trendConfirm.bear,
      ready: shortReady,
    },
  };
}

export const RangeBreakoutContinuation: Strategy = {
  name: 'range_breakout_continuation',
  timeframe: '5m',

  async evaluate(ctx: StrategyContext) {
    const { exchange, symbol, config } = ctx;
    const timeframe = config.ENTRY_TIMEFRAME || '5m';
    const candles = await exchange.getCandles(symbol, timeframe, 320);
    if (candles.length < 120) {
      return { action: 'IDLE', reason: 'rbc_few_candles' };
    }

    const confirmTf = ((config as any).RBC_CONFIRM_TF ?? '15m') as '5m' | '15m' | '30m' | '1h';
    const confirmCandles =
      confirmTf === timeframe
        ? candles
        : await exchange.getCandles(symbol, confirmTf, confirmTf === '1h' ? 200 : 240);

    const analysis = analyzeRangeBreakout({ candles, confirmCandles, config });

    if ((config as any).ALLOW_LONGS !== false && analysis.long.ready) {
      return {
        action: 'ENTER_LONG',
        reason: `rbc_long breakout=${fmt(analysis.long.rangeHigh)} width=${fmtPct(
          analysis.long.rangeWidthPct,
        )} atr=${fmtPct(analysis.long.atrPct)} vol=${analysis.long.volRatio.toFixed(2)}`,
        diagnostics: {
          strategy: RangeBreakoutContinuation.name,
          selection: 'LONG',
          analysis,
          confirmTf,
        },
      };
    }

    if ((config as any).ALLOW_SHORTS !== false && analysis.short.ready) {
      return {
        action: 'ENTER_SHORT',
        reason: `rbc_short breakout=${fmt(analysis.short.rangeLow)} width=${fmtPct(
          analysis.short.rangeWidthPct,
        )} atr=${fmtPct(analysis.short.atrPct)} vol=${analysis.short.volRatio.toFixed(2)}`,
        diagnostics: {
          strategy: RangeBreakoutContinuation.name,
          selection: 'SHORT',
          analysis,
          confirmTf,
        },
      };
    }

    return {
      action: 'IDLE',
      reason: `rbc_filters long=${Number(analysis.long.ready)} short=${Number(
        analysis.short.ready,
      )} width=${fmtPct(analysis.long.rangeWidthPct)} atr=${fmtPct(
        analysis.long.atrPct,
      )} vol=${analysis.long.volRatio.toFixed(2)}`,
      diagnostics: {
        strategy: RangeBreakoutContinuation.name,
        analysis,
        confirmTf,
      },
    };
  },
};
