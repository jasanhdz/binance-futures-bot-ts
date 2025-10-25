// src/strategies/volume_profile_pullback.ts
import { Strategy, StrategyContext } from './types';
import { Candle } from '../core/types';
import { last, volumeAvg } from '../core/utils/candles';
import { ema } from '../core/indicators/ema';
import { computeFeatures } from '../core/utils/features';

type Direction = 'LONG' | 'SHORT';

export interface VolumeProfileParams {
  timeframe: string;
  lookback: number;
  bucketCount: number;
  pocTolerance: number;
  breakoutBuffer: number;
  volDecreaseFactor: number;
  atrLookback: number;
}

export interface VolumeProfileState {
  direction: Direction;
  poc: number;
  valueAreaHigh: number;
  valueAreaLow: number;
  distancePct: number;
  volRatio: number;
  trendOk: boolean;
  ready: boolean;
}

export interface VolumeProfileAnalysis {
  params: VolumeProfileParams;
  poc: number;
  valueAreaHigh: number;
  valueAreaLow: number;
  long: VolumeProfileState;
  short: VolumeProfileState;
}

function buildProfile(candles: Candle[], bucketCount: number) {
  const lows = candles.map((c) => c.low);
  const highs = candles.map((c) => c.high);
  const minPrice = Math.min(...lows);
  const maxPrice = Math.max(...highs);
  if (!Number.isFinite(minPrice) || !Number.isFinite(maxPrice) || minPrice === maxPrice) {
    return { poc: NaN, valueAreaHigh: NaN, valueAreaLow: NaN };
  }
  const range = maxPrice - minPrice;
  const bucketSize = range / Math.max(bucketCount, 1);
  const buckets = new Array(bucketCount).fill(0);

  for (const c of candles) {
    const px = c.close;
    const idx = Math.min(bucketCount - 1, Math.max(0, Math.floor((px - minPrice) / bucketSize)));
    buckets[idx] += c.volume;
  }

  let pocIdx = 0;
  let maxVol = -Infinity;
  for (let i = 0; i < buckets.length; i++) {
    if (buckets[i] > maxVol) {
      maxVol = buckets[i];
      pocIdx = i;
    }
  }

  const totalVol = buckets.reduce((sum, v) => sum + v, 0);
  const valueAreaTarget = totalVol * 0.7;
  let running = buckets[pocIdx];
  let left = pocIdx;
  let right = pocIdx;
  while (running < valueAreaTarget) {
    const nextLeft = left > 0 ? buckets[left - 1] : 0;
    const nextRight = right < buckets.length - 1 ? buckets[right + 1] : 0;
    if (nextLeft >= nextRight && left > 0) {
      left -= 1;
      running += nextLeft;
    } else if (right < buckets.length - 1) {
      right += 1;
      running += nextRight;
    } else {
      break;
    }
  }

  const poc = minPrice + pocIdx * bucketSize + bucketSize / 2;
  const valueAreaLow = minPrice + left * bucketSize;
  const valueAreaHigh = minPrice + (right + 1) * bucketSize;

  return { poc, valueAreaHigh, valueAreaLow };
}

export function analyzeVolumeProfilePullback(opts: {
  candles: Candle[];
  config: StrategyContext['config'];
}): VolumeProfileAnalysis {
  const { candles, config } = opts;
  if (candles.length < 120) {
    throw new Error('Volume profile analysis requires sufficient candles');
  }

  const params: VolumeProfileParams = {
    timeframe: config.ENTRY_TIMEFRAME || '5m',
    lookback: Number((config as any).VP_LOOKBACK ?? 180),
    bucketCount: Number((config as any).VP_BUCKETS ?? 24),
    pocTolerance: Number((config as any).VP_POC_TOLERANCE ?? 0.0025),
    breakoutBuffer: Number((config as any).VP_BREAKOUT_BUFFER ?? 0.003),
    volDecreaseFactor: Number((config as any).VP_VOL_DECREASE ?? 0.85),
    atrLookback: Number((config as any).VP_ATR_LOOKBACK ?? 14),
  };

  const window = candles.slice(-params.lookback);
  const profile = buildProfile(window, params.bucketCount);
  const lastCandle = last(candles);
  const prevCandle = candles[candles.length - 2];

  const closes = candles.map((c) => c.close);
  const emaFast = ema(closes, 21);
  const emaSlow = ema(closes, 55);
  const fast = emaFast[emaFast.length - 1];
  const slow = emaSlow[emaSlow.length - 1];

  const volAvg = volumeAvg(candles, Math.max(10, Math.floor(params.lookback / 6)));
  const volRatio = volAvg > 0 ? lastCandle.volume / Math.max(volAvg, 1e-9) : 1;
  const features = computeFeatures(candles);

  const distancePct =
    Number.isFinite(profile.poc) && profile.poc !== 0
      ? Math.abs(lastCandle.close - profile.poc) / Math.abs(profile.poc)
      : Number.POSITIVE_INFINITY;

  const longTrendOk = Number.isFinite(fast) && Number.isFinite(slow) && fast > slow;
  const shortTrendOk = Number.isFinite(fast) && Number.isFinite(slow) && fast < slow;

  const pullbackLong =
    Number.isFinite(profile.poc) &&
    lastCandle.low <= profile.poc * (1 + params.pocTolerance) &&
    lastCandle.close > profile.poc;

  const pullbackShort =
    Number.isFinite(profile.poc) &&
    lastCandle.high >= profile.poc * (1 - params.pocTolerance) &&
    lastCandle.close < profile.poc;

  const breakoutLong =
    Number.isFinite(profile.valueAreaHigh) &&
    prevCandle.close >= profile.valueAreaHigh * (1 + params.breakoutBuffer);
  const breakoutShort =
    Number.isFinite(profile.valueAreaLow) &&
    prevCandle.close <= profile.valueAreaLow * (1 - params.breakoutBuffer);

  const volDecreasingLong = prevCandle.volume > 0 ? lastCandle.volume <= prevCandle.volume * params.volDecreaseFactor : false;
  const volDecreasingShort = prevCandle.volume > 0 ? lastCandle.volume <= prevCandle.volume * params.volDecreaseFactor : false;

  const longReady =
    breakoutLong &&
    pullbackLong &&
    volDecreasingLong &&
    longTrendOk &&
    distancePct <= params.pocTolerance * 1.5 &&
    features.rsi <= 65 &&
    volRatio >= 0.8;

  const shortReady =
    breakoutShort &&
    pullbackShort &&
    volDecreasingShort &&
    shortTrendOk &&
    distancePct <= params.pocTolerance * 1.5 &&
    features.rsi >= 35 &&
    volRatio >= 0.8;

  return {
    params,
    poc: profile.poc,
    valueAreaHigh: profile.valueAreaHigh,
    valueAreaLow: profile.valueAreaLow,
    long: {
      direction: 'LONG',
      poc: profile.poc,
      valueAreaHigh: profile.valueAreaHigh,
      valueAreaLow: profile.valueAreaLow,
      distancePct,
      volRatio,
      trendOk: longTrendOk,
      ready: longReady,
    },
    short: {
      direction: 'SHORT',
      poc: profile.poc,
      valueAreaHigh: profile.valueAreaHigh,
      valueAreaLow: profile.valueAreaLow,
      distancePct,
      volRatio,
      trendOk: shortTrendOk,
      ready: shortReady,
    },
  };
}

export const VolumeProfilePullback: Strategy = {
  name: 'volume_profile_pullback',
  timeframe: '5m',

  async evaluate(ctx: StrategyContext) {
    const { exchange, symbol, config } = ctx;
    const timeframe = config.ENTRY_TIMEFRAME || '5m';
    const candles = await exchange.getCandles(symbol, timeframe, 320);
    if (candles.length < 200) {
      return { action: 'IDLE', reason: 'vp_few_candles' };
    }

    const analysis = analyzeVolumeProfilePullback({ candles, config });

    if ((config as any).ALLOW_LONGS !== false && analysis.long.ready) {
      return {
        action: 'ENTER_LONG',
        reason: `vp_long poc=${analysis.long.poc.toFixed(4)} dist=${(
          analysis.long.distancePct * 100
        ).toFixed(2)}% vol=${analysis.long.volRatio.toFixed(2)}`,
        diagnostics: {
          strategy: VolumeProfilePullback.name,
          selection: 'LONG',
          analysis,
        },
      };
    }

    if ((config as any).ALLOW_SHORTS !== false && analysis.short.ready) {
      return {
        action: 'ENTER_SHORT',
        reason: `vp_short poc=${analysis.short.poc.toFixed(4)} dist=${(
          analysis.short.distancePct * 100
        ).toFixed(2)}% vol=${analysis.short.volRatio.toFixed(2)}`,
        diagnostics: {
          strategy: VolumeProfilePullback.name,
          selection: 'SHORT',
          analysis,
        },
      };
    }

    return {
      action: 'IDLE',
      reason: `vp_filters dist=${(analysis.long.distancePct * 100).toFixed(2)}% trend_long=${Number(
        analysis.long.trendOk,
      )} trend_short=${Number(analysis.short.trendOk)}`,
      diagnostics: {
        strategy: VolumeProfilePullback.name,
        analysis,
      },
    };
  },
};
