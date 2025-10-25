// src/strategies/break_retest.ts
import { Strategy, StrategyContext } from './types';
import { Candle } from '../core/types';
import { last, volumeAvg } from '../core/utils/candles';
import { computeLevels, getTrendSignals, TrendSignals } from './shared/context';
import { computeFeatures } from '../core/utils/features';
import { ema } from '../core/indicators/ema';

type Direction = 'LONG' | 'SHORT';

export interface BreakRetestParams {
  timeframe: string;
  confirmTf: '3m' | '5m' | '15m' | '1h';
  lookback: number;
  excludeRecent: number;
  breakBuffer: number;
  retestTolerance: number;
  retestDepth: number;
  minRoom: number;
  volFactor: number;
  volBasis: number;
  slopeMin: number;
  emaBandMin: number;
}

export interface BreakRetestState {
  direction: Direction;
  trendNow: TrendSignals;
  trendConfirm: TrendSignals;
  breakoutLevel: number;
  retestOk: boolean;
  breakoutOk: boolean;
  volumeOk: boolean;
  roomOk: boolean;
  ready: boolean;
  roomPct: number;
  last: Candle;
  prev: Candle;
}

export interface BreakRetestAnalysis {
  params: BreakRetestParams;
  long: BreakRetestState;
  short: BreakRetestState;
}

function computeRoom(
  candles: Candle[],
  direction: Direction,
  exclude: number,
): { roomPct: number; level: number } {
  const slice = candles.slice(-exclude);
  if (!slice.length) return { roomPct: NaN, level: NaN };
  if (direction === 'LONG') {
    const high = slice.reduce((m, c) => Math.max(m, c.high), -Infinity);
    const lastClose = last(candles).close;
    const room = high > 0 ? Math.max(0, (high - lastClose) / high) : NaN;
    return { roomPct: room, level: high };
  }
  const low = slice.reduce((m, c) => Math.min(m, c.low), Infinity);
  const lastClose = last(candles).close;
  const room = low > 0 ? Math.max(0, (lastClose - low) / low) : NaN;
  return { roomPct: room, level: low };
}

export function analyzeBreakRetest(opts: {
  candles: Candle[];
  confirmCandles: Candle[];
  config: StrategyContext['config'];
}): BreakRetestAnalysis {
  const { candles, confirmCandles, config } = opts;
  const params: BreakRetestParams = {
    timeframe: config.ENTRY_TIMEFRAME || '5m',
    confirmTf: ((config as any).BR_CONFIRM_TF ?? '15m') as '3m' | '5m' | '15m' | '1h',
    lookback: Number((config as any).BR_LOOKBACK ?? 180),
    excludeRecent: Number((config as any).BR_EXCLUDE_RECENT ?? 20),
    breakBuffer: Number((config as any).BR_BREAK_BUFFER ?? 0.0015),
    retestTolerance: Number((config as any).BR_RETEST_TOLERANCE ?? 0.001),
    retestDepth: Number((config as any).BR_RETEST_DEPTH ?? 0.0025),
    minRoom: Number((config as any).BR_MIN_ROOM ?? 0.004),
    volFactor: Number((config as any).BR_VOL_FACTOR ?? 1.2),
    volBasis: Math.max(Number((config as any).BR_VOL_BASIS ?? config.VOL_AVG_LEN ?? 20), 10),
    slopeMin: Number((config as any).BR_SLOPE_MIN ?? 0.0003),
    emaBandMin: Number((config as any).BR_EMA_BAND_MIN ?? 0.001),
  };

  const prev = candles[candles.length - 2];
  const lastCandle = last(candles);
  const volAvg = volumeAvg(candles, params.volBasis);

  const closes = candles.map((c) => c.close);
  const emaFastArr = ema(closes, (config as any).EMA_MID ?? 25);
  const emaUltraArr = ema(closes, (config as any).EMA_FAST ?? 7);
  const emaFast = emaFastArr[emaFastArr.length - 1];
  const emaUltra = emaUltraArr[emaUltraArr.length - 1];
  const emaBandRatio =
    Number.isFinite(emaUltra) && Number.isFinite(emaFast)
      ? Math.abs((emaUltra as number) - (emaFast as number)) /
        Math.max(Math.abs(emaFast as number), 1e-9)
      : 0;

  const features = computeFeatures(candles);
  const emaSlope = Number.isFinite(features.ema_slope) ? features.ema_slope : 0;

  const { resistance, support } = computeLevels(
    candles,
    params.excludeRecent,
    params.lookback,
  );

  const trendNow = getTrendSignals(candles, config);
  const trendConfirm = getTrendSignals(confirmCandles, config);

  const breakoutLong =
    Number.isFinite(resistance) && prev.close > resistance * (1 + params.breakBuffer);
  const breakoutShort =
    Number.isFinite(support) && prev.close < support * (1 - params.breakBuffer);

  const retestLong =
    Number.isFinite(resistance) &&
    lastCandle.low <= resistance * (1 + params.retestTolerance) &&
    lastCandle.low >= resistance * (1 - params.retestDepth) &&
    lastCandle.close > resistance &&
    lastCandle.close > lastCandle.open;

  const retestShort =
    Number.isFinite(support) &&
    lastCandle.high >= support * (1 - params.retestTolerance) &&
    lastCandle.high <= support * (1 + params.retestDepth) &&
    lastCandle.close < support &&
    lastCandle.close < lastCandle.open;

  const volumeLong = volAvg > 0 ? lastCandle.volume >= params.volFactor * volAvg : true;
  const volumeShort = volAvg > 0 ? lastCandle.volume >= params.volFactor * volAvg : true;

  const roomLong = computeRoom(candles, 'LONG', params.excludeRecent);
  const roomShort = computeRoom(candles, 'SHORT', params.excludeRecent);

  const longReady =
    trendNow.bull &&
    trendConfirm.bull &&
    breakoutLong &&
    retestLong &&
    volumeLong &&
    emaSlope >= params.slopeMin &&
    emaBandRatio >= params.emaBandMin &&
    (Number.isFinite(roomLong.roomPct) ? roomLong.roomPct >= params.minRoom : true);

  const shortReady =
    trendNow.bear &&
    trendConfirm.bear &&
    breakoutShort &&
    retestShort &&
    volumeShort &&
    emaSlope <= -params.slopeMin &&
    emaBandRatio >= params.emaBandMin &&
    (Number.isFinite(roomShort.roomPct) ? roomShort.roomPct >= params.minRoom : true);

  return {
    params,
    long: {
      direction: 'LONG',
      trendNow,
      trendConfirm,
      breakoutLevel: resistance,
      breakoutOk: breakoutLong,
      retestOk: retestLong,
      volumeOk: volumeLong,
      roomOk: Number.isFinite(roomLong.roomPct)
        ? roomLong.roomPct >= params.minRoom
        : true,
      ready: longReady,
      roomPct: roomLong.roomPct,
      last: lastCandle,
      prev,
    },
    short: {
      direction: 'SHORT',
      trendNow,
      trendConfirm,
      breakoutLevel: support,
      breakoutOk: breakoutShort,
      retestOk: retestShort,
      volumeOk: volumeShort,
      roomOk: Number.isFinite(roomShort.roomPct)
        ? roomShort.roomPct >= params.minRoom
        : true,
      ready: shortReady,
      roomPct: roomShort.roomPct,
      last: lastCandle,
      prev,
    },
  };
}

export const BreakRetest: Strategy = {
  name: 'break_retest',
  timeframe: '5m',

  async evaluate(ctx: StrategyContext) {
    const { exchange, symbol, config } = ctx;

    const candles = await exchange.getCandles(symbol, config.ENTRY_TIMEFRAME, 320);
    if (candles.length < 120) {
      return { action: 'IDLE', reason: 'br_few_candles' };
    }

    const dailyPumpGuard = Number((config as any).BR_DAILY_PUMP_GUARD ?? 0.05);
    const dailyDropGuard = Number((config as any).BR_DAILY_DROP_GUARD ?? 0.05);
    const dailyCandles = await exchange.getCandles(symbol, '1d', 3);
    const lastDaily = dailyCandles.length ? last(dailyCandles) : undefined;
    const dailyChange = lastDaily && lastDaily.open > 0 ? lastDaily.close / lastDaily.open - 1 : NaN;

    const confirmTf = ((config as any).BR_CONFIRM_TF ?? '15m') as '3m' | '5m' | '15m' | '1h';
    const confirmCandles =
      confirmTf === config.ENTRY_TIMEFRAME
        ? candles
        : await exchange.getCandles(symbol, confirmTf, 240);

    const analysis = analyzeBreakRetest({ candles, confirmCandles, config });
    
    const allowLongDaily =
      !Number.isFinite(dailyChange) || Number.isNaN(dailyChange)
        ? true
        : dailyChange > -dailyDropGuard;
    const allowShortDaily =
      !Number.isFinite(dailyChange) || Number.isNaN(dailyChange)
        ? true
        : dailyChange < dailyPumpGuard;

    if ((config as any).ALLOW_LONGS && analysis.long.ready && allowLongDaily) {
      const levelStr = Number.isFinite(analysis.long.breakoutLevel)
        ? analysis.long.breakoutLevel.toFixed(4)
        : 'n/a';
      return {
        action: 'ENTER_LONG',
        reason: `br_long level=${levelStr} room=${Number.isFinite(analysis.long.roomPct) ? (analysis.long.roomPct * 100).toFixed(2) : 'n/a'}% daily=${Number(
          allowLongDaily,
        )}`,
        diagnostics: {
          strategy: BreakRetest.name,
          selection: 'LONG',
          analysis,
          confirmTf,
          dailyChange,
          allowDaily: allowLongDaily,
        },
      };
    }

    if ((config as any).ALLOW_SHORTS && analysis.short.ready && allowShortDaily) {
      const levelStr = Number.isFinite(analysis.short.breakoutLevel)
        ? analysis.short.breakoutLevel.toFixed(4)
        : 'n/a';
      return {
        action: 'ENTER_SHORT',
        reason: `br_short level=${levelStr} room=${Number.isFinite(analysis.short.roomPct) ? (analysis.short.roomPct * 100).toFixed(2) : 'n/a'}% daily=${Number(
          allowShortDaily,
        )}`,
        diagnostics: {
          strategy: BreakRetest.name,
          selection: 'SHORT',
          analysis,
          confirmTf,
          dailyChange,
          allowDaily: allowShortDaily,
        },
      };
    }

    return {
      action: 'IDLE',
      reason: `br_filters long=${Number(analysis.long.ready)} short=${Number(
        analysis.short.ready,
      )} daily_short=${Number(allowShortDaily)} daily_long=${Number(allowLongDaily)}`,
    };
  },
};
