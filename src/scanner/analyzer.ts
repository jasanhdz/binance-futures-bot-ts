// src/scanner/analyzer.ts
import { Exchange } from '../core/ports/Exchange';
import { Candle } from '../core/types';
import { StrategyContext } from '../strategies/types';
import {
  analyzeBreakRetest,
  BreakRetestAnalysis,
  BreakRetestState,
} from '../strategies/break_retest';
import {
  analyzeSnapback,
  SnapAnalysis,
  SnapState,
  SnapParams,
} from '../strategies/mean_reversion_snapback';
import {
  analyzeRangeBreakout,
  RangeBreakoutAnalysis,
  RangeBreakoutState,
} from '../strategies/range_breakout_continuation';
import {
  analyzeLiquiditySweep,
  LiquiditySweepAnalysis,
  SweepState,
} from '../strategies/liquidity_sweep_reversal';
import {
  analyzeVolumeProfilePullback,
  VolumeProfileAnalysis,
  VolumeProfileState,
} from '../strategies/volume_profile_pullback';
import {
  analyzeFundingBasis,
  FundingBasisAnalysis,
  FundingBasisState,
} from '../strategies/funding_basis_mean_reversion';
import {
  analyzeTrendRide,
  TrendRideAnalysis,
  TrendRideState,
  TrendRideParams,
} from '../strategies/volatility_trend_ride';
import {
  analyzeMomentumBreakout,
  MomentumAnalysis,
  MomentumDirectionState,
  MOMENTUM_TIMEFRAME,
} from '../strategies/momentum_breakout';
import { getTrendSignals } from '../strategies/shared/context';
import { BasisSnapshot, FundingSnapshot } from '../core/ports/Exchange';

export type StrategyKey =
  | 'momentum'
  | 'range_breakout'
  | 'break_retest'
  | 'liquidity_sweep'
  | 'snapback'
  | 'volume_profile'
  | 'funding_basis'
  | 'trend_ride';

export interface StrategyCandidate {
  strategy: StrategyKey;
  side: 'LONG' | 'SHORT';
  score: number;
  ready: boolean;
  detail: string;
}

export interface SymbolScanResult {
  symbol: string;
  best: StrategyCandidate | null;
  candidates: StrategyCandidate[];
  analyses: {
    momentum?: MomentumAnalysis;
    breakRetest?: BreakRetestAnalysis;
    rangeBreakout?: RangeBreakoutAnalysis;
    liquiditySweep?: LiquiditySweepAnalysis;
    volumeProfile?: VolumeProfileAnalysis;
    fundingBasis?: FundingBasisAnalysis;
    trendRide?: TrendRideAnalysis;
    snap?: SnapAnalysis;
  };
  extras: {
    lastClose: number;
    shortSma: number;
    longSma: number;
    trendStrengthPct: number;
  };
}

export interface ScanOptions {
  exchange?: Pick<Exchange, 'getCandles'>;
  candlesFetcher?: (symbol: string, interval: string, limit: number) => Promise<Candle[]>;
  fundingFetcher?: (symbol: string) => Promise<FundingSnapshot>;
  basisFetcher?: (symbol: string) => Promise<BasisSnapshot>;
  symbols: string[];
  config: StrategyContext['config'];
  sideFilter?: 'LONG' | 'SHORT' | 'BOTH';
  minScore?: number;
  limit?: number;
  logger?: { warn(msg: string, ctx?: any): void; debug(msg: string, ctx?: any): void };
}

function breakRetestScore(state: BreakRetestState): number {
  let score = 0;
  if (state.trendNow.bull || state.trendNow.bear) score += 15;
  if (state.trendConfirm.bull || state.trendConfirm.bear) score += 15;
  if (state.breakoutOk) score += 20;
  if (state.retestOk) score += 20;
  if (state.volumeOk) score += 10;
  if (state.roomOk) score += 10;
  if (state.ready) score += 20;
  return Math.min(100, score);
}

function snapScore(state: SnapState, params: SnapParams): number {
  let score = 0;
  const ext = Math.abs(state.extension);
  const extRatio = params.emaExtension > 0 ? Math.min(1, ext / params.emaExtension) : 0;
  score += extRatio * 20;
  if (state.trendNow.bull || state.trendNow.bear) score += 8;
  if (state.trendConfirm.bull || state.trendConfirm.bear) score += 8;
  if (state.volumeOk) score += 4;
  if (state.levelsOk) score += 4;
  if (state.structureOk) score += 14;
  if (state.reversalOk) score += 14;
  if (state.dailyOk) score += 4;
  if (state.streak >= params.streakMin) score += 6;

  const rsiFactor =
    state.direction === 'LONG'
      ? Math.min(1, (params.rsiLow - state.rsi) / Math.max(1, params.rsiLow - 15))
      : Math.min(1, (state.rsi - params.rsiHigh) / Math.max(1, 85 - params.rsiHigh));
  if (Number.isFinite(rsiFactor) && rsiFactor > 0) {
    score += Math.min(1, Math.max(0, rsiFactor)) * 12;
  }
  if (state.ready) score += 6;
  return Math.min(100, score);
}

function momentumScore(analysis: MomentumAnalysis, state: MomentumDirectionState): number {
  if (!Number.isFinite(state.triggerPrice) || !Number.isFinite(state.baseLevel)) return 0;
  let score = 0;

  const streakRatio =
    analysis.params.streakMin > 0 ? Math.min(1, state.streak / analysis.params.streakMin) : 0;
  score += streakRatio * 25;

  const volRatio =
    analysis.params.volFactor > 0
      ? Math.min(state.weakestVolRatio / analysis.params.volFactor, 1)
      : 0;
  score += volRatio * 20;

  if (state.trendOk) score += 25;
  if (state.breakoutOk) score += 10;

  const dist = state.priceToTriggerPct;
  if (Number.isFinite(dist)) {
    const window = 0.003;
    const closeness = Math.max(0, (window - Math.max(0, dist)) / window);
    score += closeness * 20;
  }

  if (state.ready) score += 20;
  return Math.min(100, score);
}

function rangeBreakoutScore(analysis: RangeBreakoutAnalysis, state: RangeBreakoutState): number {
  let score = 0;
  const { params } = analysis;
  const widthFactor =
    params.rangeWidthMax > 0
      ? Math.max(0, 1 - Math.min(state.rangeWidthPct / params.rangeWidthMax, 1))
      : 0;
  score += widthFactor * 25;

  const atrFactor =
    params.atrPctMax > 0
      ? Math.max(0, 1 - Math.min(state.atrPct / params.atrPctMax, 1))
      : 0;
  score += atrFactor * 20;

  const volFactor =
    params.volRatioMin > 0 ? Math.min(state.volRatio / params.volRatioMin, 1) : 0;
  score += volFactor * 20;

  if (state.trendAligned) score += 15;
  if (state.confirmAligned) score += 10;

  if (state.ready) score += 20;

  return Math.min(100, score);
}

function liquiditySweepScore(analysis: LiquiditySweepAnalysis, state: SweepState): number {
  let score = 0;
  const params = analysis.params;

  score += Math.min(1, state.wickRatio / params.wickMin) * 20;
  score += Math.min(1, state.volRatio / params.volRatioMin) * 20;
  score += Math.min(1, state.streak / params.streakMin) * 10;

  const levelFactor =
    params.levelProximityMax > 0
      ? Math.max(0, 1 - Math.min(state.levelDistance / params.levelProximityMax, 1))
      : 0;
  score += levelFactor * 20;

  if (state.trendAligned) score += 10;

  const rsiOk =
    state.direction === 'LONG'
      ? state.rsi <= params.rsiLongMax
      : state.rsi >= params.rsiShortMin;
  if (rsiOk) score += 10;

  if (state.ready) score += 20;

  return Math.min(100, score);
}

function volumeProfileScore(state: VolumeProfileState): number {
  let score = 0;
  const distScore = Math.max(0, 1 - Math.min(state.distancePct / 0.01, 1));
  score += distScore * 30;
  if (state.trendOk) score += 25;
  score += Math.min(1, state.volRatio) * 15;
  if (state.ready) score += 30;
  return Math.min(100, score);
}

function fundingBasisScore(state: FundingBasisState, analysis: FundingBasisAnalysis): number {
  let score = 0;
  const fundingExtreme = Math.abs(analysis.params.fundingExtreme);
  const basisExtreme = Math.abs(analysis.params.basisExtreme);
  if (fundingExtreme > 0) {
    score += Math.min(1, Math.abs(state.fundingRate) / fundingExtreme) * 30;
  }
  if (basisExtreme > 0) {
    score += Math.min(1, Math.abs(state.basisPct) / basisExtreme) * 25;
  }
  score += Math.min(1, state.volRatio / Math.max(analysis.params.volRatioMin, 1e-6)) * 15;
  score += Math.min(1, Math.abs(state.momentum) / 0.01) * 10;
  if (state.ready) score += 20;
  return Math.min(100, score);
}

function trendRideScore(state: TrendRideState, params: TrendRideParams): number {
  let score = 0;
  const slopeTarget = params.slopeMin;
  if (slopeTarget > 0) {
    score += Math.min(1, Math.abs(state.slope) / slopeTarget) * 25;
  }
  score += Math.min(1, state.volRatio / Math.max(params.volRatioMin, 1e-6)) * 20;
  score += Math.min(1, Math.abs(state.atr)) * 10;
  if (state.ready) score += 35;
  return Math.min(100, score);
}

export async function scanSymbols(options: ScanOptions): Promise<SymbolScanResult[]> {
  const {
    exchange,
    candlesFetcher,
    fundingFetcher,
    basisFetcher,
    symbols,
    config,
    sideFilter = 'BOTH',
    minScore = 20,
    limit = symbols.length,
    logger,
  } = options;

  const results: SymbolScanResult[] = [];

  const getCandles = async (symbol: string, interval: string, count: number) => {
    if (candlesFetcher) return candlesFetcher(symbol, interval, count);
    if (exchange) return exchange.getCandles(symbol, interval, count);
    throw new Error('scanSymbols requires an exchange or candlesFetcher');
  };

  for (const symbol of symbols) {
    try {
      const tfCache = new Map<string, Candle[]>();
      const fetchCandles = async (tf: string, limit: number) => {
        const key = `${tf}|${limit}`;
        if (!tfCache.has(key)) {
          tfCache.set(key, await getCandles(symbol, tf, limit));
        }
        return tfCache.get(key)!;
      };

      const momentumCandles = await fetchCandles(MOMENTUM_TIMEFRAME, 320);
      if (momentumCandles.length < 80) {
        logger?.warn?.('scan_skip_insufficient_candles', { symbol, candles: momentumCandles.length });
        continue;
      }
      const momentumConfirmTf = ((config as any).MOM_TREND_CONFIRM_TF ?? '15m') as
        | '3m'
        | '5m'
        | '15m'
        | '1h';
      const momentumConfirmCandles =
        momentumConfirmTf === MOMENTUM_TIMEFRAME
          ? momentumCandles
          : await fetchCandles(momentumConfirmTf, 320);
      const momentumAnalysis = analyzeMomentumBreakout({
        candles: momentumCandles,
        confirmCandles: momentumConfirmCandles,
        config,
        confirmTf: momentumConfirmTf,
      });

      const entryTf = config.ENTRY_TIMEFRAME;
      const entryCandles = await fetchCandles(entryTf, 320);
      if (entryCandles.length < 120) {
        logger?.warn?.('scan_skip_insufficient_candles', { symbol, candles: entryCandles.length });
        continue;
      }

      const breakConfirmTf = ((config as any).BR_CONFIRM_TF ?? '15m') as '3m' | '5m' | '15m' | '1h';
      const breakConfirmCandles =
        breakConfirmTf === entryTf
          ? entryCandles
          : await fetchCandles(breakConfirmTf, 240);
      const breakAnalysis = analyzeBreakRetest({
        candles: entryCandles,
        confirmCandles: breakConfirmCandles,
        config,
      });

      const snapConfirmTf = ((config as any).MRS_CONFIRM_TF ?? '15m') as '3m' | '5m' | '15m' | '1h';
      const snapConfirmCandles =
        snapConfirmTf === entryTf
          ? entryCandles
          : await fetchCandles(snapConfirmTf, 240);
      const snapHigherTf = ((config as any).MRS_HTF_TF ?? '1h') as '1h' | '4h';
      const snapHigherLimit = snapHigherTf === '4h' ? 160 : 320;
      const snapHigherCandles =
        snapHigherTf === entryTf
          ? entryCandles
          : await fetchCandles(snapHigherTf, snapHigherLimit);
      const snapDailyCandles = await fetchCandles('1d', 3);
      const snapAnalysis = analyzeSnapback({
        candles: entryCandles,
        confirmCandles: snapConfirmCandles,
        config,
        htfCandles: snapHigherCandles,
        dailyCandles: snapDailyCandles,
      });

      const rbcConfirmTf = ((config as any).RBC_CONFIRM_TF ?? '15m') as
        | '5m'
        | '15m'
        | '30m'
        | '1h';
      const rbcConfirmCandles =
        rbcConfirmTf === entryTf
          ? entryCandles
          : await fetchCandles(rbcConfirmTf, rbcConfirmTf === '1h' ? 200 : 240);
      const rangeAnalysis = analyzeRangeBreakout({
        candles: entryCandles,
        confirmCandles: rbcConfirmCandles,
        config,
      });

      const trendRideAnalysis = analyzeTrendRide({ candles: entryCandles, config });

      const sweepConfirmTf = ((config as any).LS_CONFIRM_TF ?? '15m') as
        | '5m'
        | '15m'
        | '30m'
        | '1h';
      const sweepConfirmCandles =
        sweepConfirmTf === entryTf
          ? entryCandles
          : await fetchCandles(sweepConfirmTf, sweepConfirmTf === '1h' ? 220 : 260);
      const sweepHtfTf = ((config as any).LS_HTF_TF ?? '1h') as '1h' | '4h';
      const sweepHtfCandles =
        sweepHtfTf === sweepConfirmTf
          ? sweepConfirmCandles
          : await fetchCandles(sweepHtfTf, sweepHtfTf === '4h' ? 200 : 320);
      const sweepAnalysis = analyzeLiquiditySweep({
        candles: entryCandles,
        confirmCandles: sweepConfirmCandles,
        htfCandles: sweepHtfCandles,
        config,
      });

      const volumeProfileAnalysis = analyzeVolumeProfilePullback({ candles: entryCandles, config });

      let fundingBasisAnalysis: FundingBasisAnalysis | undefined;
      if (fundingFetcher && basisFetcher) {
        const [fundingSnap, basisSnap] = await Promise.all([
          fundingFetcher(symbol),
          basisFetcher(symbol),
        ]);
        fundingBasisAnalysis = analyzeFundingBasis({
          candles: entryCandles,
          fundingRate: fundingSnap.rate,
          basisPct: basisSnap.basisPct,
          config,
        });
      }

      const lastClose = entryCandles[entryCandles.length - 1]?.close ?? NaN;
      const shortSma = sma(entryCandles, 7);
      const longSma = sma(entryCandles, 25);
      const trendSignals = getTrendSignals(entryCandles, config);
      const trendStrengthPct = computeTrendStrengthPct(trendSignals);

      const candidates: StrategyCandidate[] = [];
      candidates.push(
        ...[momentumAnalysis.long, momentumAnalysis.short].map((state) => ({
          strategy: 'momentum' as const,
          side: state.direction,
          score: momentumScore(momentumAnalysis, state),
          ready: state.ready,
          detail: `streak=${state.streak} volx=${state.weakestVolRatio.toFixed(2)} room=${
            Number.isFinite(state.priceToTriggerPct)
              ? (state.priceToTriggerPct * 100).toFixed(2)
              : 'n/a'
          }%`,
        })),
      );
      candidates.push(
        ...[rangeAnalysis.long, rangeAnalysis.short].map((state) => ({
          strategy: 'range_breakout' as const,
          side: state.direction,
          score: rangeBreakoutScore(rangeAnalysis, state),
          ready: state.ready,
          detail: `width=${(state.rangeWidthPct * 100).toFixed(2)}% atr=${(
            state.atrPct * 100
          ).toFixed(2)}% vol=${state.volRatio.toFixed(2)}`,
        })),
      );

      candidates.push(
        ...[breakAnalysis.long, breakAnalysis.short].map((state) => ({
          strategy: 'break_retest' as const,
          side: state.direction,
          score: breakRetestScore(state),
          ready: state.ready,
          detail: `level=${
            Number.isFinite(state.breakoutLevel) ? state.breakoutLevel.toFixed(4) : 'n/a'
          } room=${Number.isFinite(state.roomPct) ? (state.roomPct * 100).toFixed(2) : 'n/a'}%`,
        })),
      );

      candidates.push(
        ...[sweepAnalysis.long, sweepAnalysis.short].map((state) => ({
          strategy: 'liquidity_sweep' as const,
          side: state.direction,
          score: liquiditySweepScore(sweepAnalysis, state),
          ready: state.ready,
          detail: `wick=${state.wickRatio.toFixed(2)} vol=${state.volRatio.toFixed(
            2,
          )} dist=${(state.levelDistance * 100).toFixed(2)}% rsi=${state.rsi.toFixed(1)}`,
        })),
      );

      candidates.push(
        ...[snapAnalysis.long, snapAnalysis.short].map((state) => ({
          strategy: 'snapback' as const,
          side: state.direction,
          score: snapScore(state, snapAnalysis.params),
          ready: state.ready,
          detail: `ext=${(state.extension * 100).toFixed(2)}% rsi=${state.rsi.toFixed(1)}`,
        })),
      );

      candidates.push(
        ...[volumeProfileAnalysis.long, volumeProfileAnalysis.short].map((state) => ({
          strategy: 'volume_profile' as const,
          side: state.direction,
          score: volumeProfileScore(state),
          ready: state.ready,
          detail: `dist=${(state.distancePct * 100).toFixed(2)}% vol=${state.volRatio.toFixed(2)}`,
        })),
      );

      candidates.push(
        ...[trendRideAnalysis.long, trendRideAnalysis.short].map((state) => ({
          strategy: 'trend_ride' as const,
          side: state.direction,
          score: trendRideScore(state, trendRideAnalysis.params),
          ready: state.ready,
          detail: `slope=${state.slope.toFixed(4)} vol=${state.volRatio.toFixed(2)}`,
        })),
      );

      if (fundingBasisAnalysis) {
        candidates.push(
          ...[fundingBasisAnalysis.long, fundingBasisAnalysis.short].map((state) => ({
            strategy: 'funding_basis' as const,
            side: state.direction,
            score: fundingBasisScore(state, fundingBasisAnalysis!),
            ready: state.ready,
            detail: `fund=${(state.fundingRate * 100).toFixed(4)}% basis=${(
              state.basisPct * 100
            ).toFixed(2)}%`,
          })),
        );
      }

      const filtered = sideFilter === 'BOTH' ? candidates : candidates.filter((c) => c.side === sideFilter);
      const best = filtered.reduce<StrategyCandidate | null>((acc, cand) => {
        if (cand.score < minScore) return acc;
        if (!acc || cand.score > acc.score) return cand;
        return acc;
      }, null);

      results.push({
        symbol,
        best,
        candidates,
        analyses: {
          momentum: momentumAnalysis,
          breakRetest: breakAnalysis,
          rangeBreakout: rangeAnalysis,
          liquiditySweep: sweepAnalysis,
          volumeProfile: volumeProfileAnalysis,
          trendRide: trendRideAnalysis,
          fundingBasis: fundingBasisAnalysis,
          snap: snapAnalysis,
        },
        extras: {
          lastClose,
          shortSma,
          longSma,
          trendStrengthPct,
        },
      });
    } catch (err) {
      logger?.warn?.('scan_symbol_error', { symbol, err: (err as any)?.message || String(err) });
    }
  }

  const sorted = results
    .filter((r) => !!r.best)
    .sort((a, b) => (b.best?.score ?? 0) - (a.best?.score ?? 0))
    .slice(0, limit);

  return sorted;
}

function sma(candles: Candle[], length: number): number {
  if (candles.length < length) {
    const closes = candles.map((c) => c.close);
    const sum = closes.reduce((acc, v) => acc + v, 0);
    return closes.length ? sum / closes.length : NaN;
  }
  const closes = candles.slice(-length).map((c) => c.close);
  const sum = closes.reduce((acc, v) => acc + v, 0);
  return sum / length;
}

function computeTrendStrengthPct(signals: ReturnType<typeof getTrendSignals>): number {
  const fast = signals.emaFast;
  const slow = signals.emaSlow;
  if (!Number.isFinite(fast) || !Number.isFinite(slow) || slow === 0) return 0;
  return ((fast - slow) / Math.abs(slow)) * 100;
}
