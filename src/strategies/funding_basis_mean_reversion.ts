// src/strategies/funding_basis_mean_reversion.ts
import { Strategy, StrategyContext } from './types';
import { Candle } from '../core/types';
import { computeFeatures } from '../core/utils/features';
import { volumeAvg, countStreak } from '../core/utils/candles';

export interface FundingBasisParams {
  timeframe: string;
  fundingExtreme: number;
  basisExtreme: number;
  streakMin: number;
  volRatioMin: number;
  rsiHigh: number;
  rsiLow: number;
  atrLookback: number;
  meanReversionWindow: number;
}

export interface FundingBasisState {
  direction: 'LONG' | 'SHORT';
  fundingRate: number;
  basisPct: number;
  streak: number;
  volRatio: number;
  rsi: number;
  momentum: number;
  ready: boolean;
}

export interface FundingBasisAnalysis {
  params: FundingBasisParams;
  fundingRate: number;
  basisPct: number;
  long: FundingBasisState;
  short: FundingBasisState;
}

const percent = (value: number) =>
  Number.isFinite(value) ? (value * 100).toFixed(2) + '%' : 'n/a';

export function analyzeFundingBasis(opts: {
  candles: Candle[];
  fundingRate: number;
  basisPct: number;
  config: StrategyContext['config'];
}): FundingBasisAnalysis {
  const { candles, fundingRate, basisPct, config } = opts;
  if (candles.length < 80) {
    throw new Error('Funding basis analysis requires at least 80 candles');
  }

  const params: FundingBasisParams = {
    timeframe: config.ENTRY_TIMEFRAME || '5m',
    fundingExtreme: Number((config as any).FB_FUNDING_EXTREME ?? 0.0005),
    basisExtreme: Number((config as any).FB_BASIS_EXTREME ?? 0.001),
    streakMin: Number((config as any).FB_STREAK_MIN ?? 3),
    volRatioMin: Number((config as any).FB_VOL_RATIO_MIN ?? 1.1),
    rsiHigh: Number((config as any).FB_RSI_HIGH ?? 65),
    rsiLow: Number((config as any).FB_RSI_LOW ?? 35),
    atrLookback: Number((config as any).FB_ATR_LOOKBACK ?? 14),
    meanReversionWindow: Number((config as any).FB_MR_WINDOW ?? 6),
  };

  const features = computeFeatures(candles);
  const volAvg = volumeAvg(candles, Math.max(10, params.meanReversionWindow * 2));
  const volRatio = volAvg > 0 ? candles[candles.length - 1].volume / Math.max(volAvg, 1e-9) : 1;
  const streakGreen = countStreak(candles, 'green');
  const streakRed = countStreak(candles, 'red');

  const momentumWindow = Math.max(2, params.meanReversionWindow);
  const last = candles[candles.length - 1];
  const windowStart = Math.max(0, candles.length - 1 - momentumWindow);
  const ref = candles[windowStart];
  const momentum = ref && ref.close > 0 ? last.close / ref.close - 1 : 0;

  const longReady =
    fundingRate <= -Math.abs(params.fundingExtreme) &&
    basisPct <= -Math.abs(params.basisExtreme) &&
    streakRed >= params.streakMin &&
    volRatio >= params.volRatioMin &&
    features.rsi <= params.rsiLow &&
    momentum <= 0;

  const shortReady =
    fundingRate >= Math.abs(params.fundingExtreme) &&
    basisPct >= Math.abs(params.basisExtreme) &&
    streakGreen >= params.streakMin &&
    volRatio >= params.volRatioMin &&
    features.rsi >= params.rsiHigh &&
    momentum >= 0;

  return {
    params,
    fundingRate,
    basisPct,
    long: {
      direction: 'LONG',
      fundingRate,
      basisPct,
      streak: streakRed,
      volRatio,
      rsi: features.rsi,
      momentum,
      ready: longReady,
    },
    short: {
      direction: 'SHORT',
      fundingRate,
      basisPct,
      streak: streakGreen,
      volRatio,
      rsi: features.rsi,
      momentum,
      ready: shortReady,
    },
  };
}

export const FundingBasisMeanReversion: Strategy = {
  name: 'funding_basis_mean_reversion',
  timeframe: '5m',

  async evaluate(ctx: StrategyContext) {
    const { exchange, symbol, config } = ctx;
    const timeframe = config.ENTRY_TIMEFRAME || '5m';
    const candles = await exchange.getCandles(symbol, timeframe, 320);
    if (candles.length < 120) {
      return { action: 'IDLE', reason: 'fb_few_candles' };
    }

    const fundingSnapshot = await exchange.getFundingRate(symbol);
    const basisSnapshot = await exchange.getBasisSnapshot(symbol);

    const analysis = analyzeFundingBasis({
      candles,
      fundingRate: fundingSnapshot.rate,
      basisPct: basisSnapshot.basisPct,
      config,
    });

    if ((config as any).ALLOW_LONGS !== false && analysis.long.ready) {
      return {
        action: 'ENTER_LONG',
        reason: `fb_long funding=${percent(analysis.fundingRate)} basis=${percent(
          analysis.basisPct,
        )} rsi=${analysis.long.rsi.toFixed(1)} streak=${analysis.long.streak}`,
        diagnostics: {
          strategy: FundingBasisMeanReversion.name,
          selection: 'LONG',
          analysis,
          fundingSnapshot,
          basisSnapshot,
        },
      };
    }

    if ((config as any).ALLOW_SHORTS !== false && analysis.short.ready) {
      return {
        action: 'ENTER_SHORT',
        reason: `fb_short funding=${percent(analysis.fundingRate)} basis=${percent(
          analysis.basisPct,
        )} rsi=${analysis.short.rsi.toFixed(1)} streak=${analysis.short.streak}`,
        diagnostics: {
          strategy: FundingBasisMeanReversion.name,
          selection: 'SHORT',
          analysis,
          fundingSnapshot,
          basisSnapshot,
        },
      };
    }

    return {
      action: 'IDLE',
      reason: `fb_filters funding=${percent(analysis.fundingRate)} basis=${percent(
        analysis.basisPct,
      )} streak_long=${analysis.long.streak} streak_short=${analysis.short.streak}`,
      diagnostics: {
        strategy: FundingBasisMeanReversion.name,
        analysis,
        fundingSnapshot,
        basisSnapshot,
      },
    };
  },
};
