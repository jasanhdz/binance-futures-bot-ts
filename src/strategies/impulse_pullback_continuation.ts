// src/strategies/impulse_pullback_continuation.ts
import { Strategy, StrategyContext } from './types';
import { Candle } from '../core/types';
import { ema } from '../core/indicators/ema';
import { last } from '../core/utils/candles';
import { computeLevels, getTrendSignals } from './shared/context';

type Direction = 'LONG' | 'SHORT';

export interface ImpulsePullbackParams {
  timeframe: string;
  confirmTf: '15m' | '1h' | '4h';
  higherTf: '4h' | '1d';
  emaLen: number;
  zoneLookback: number;
  zoneExclude: number;
  zoneTolerance: number;
  structureLookback: number;
  pullbackLookback: number;
  pullbackTolerance: number;
}

export interface ImpulsePullbackState {
  direction: Direction;
  zoneOk: boolean;
  trendOk: boolean;
  structureOk: boolean;
  pullbackOk: boolean;
  ready: boolean;
  triggerPrice: number;
  stopPrice: number;
  distanceToTriggerPct: number;
  ema: number;
  emaSlope: number;
}

export interface ImpulsePullbackAnalysis {
  params: ImpulsePullbackParams;
  dailyLevels: {
    support: number;
    resistance: number;
    nearSupport: boolean;
    nearResistance: boolean;
    last: Candle | null;
  };
  confirm: {
    ema: number;
    emaSlope: number;
    structureHigh: number;
    structureLow: number;
    trendBull: boolean;
    trendBear: boolean;
    last: Candle | null;
  };
  entry: {
    ema: number;
    emaSlope: number;
    pullbackLow: number;
    pullbackHigh: number;
    last: Candle | null;
    prev: Candle | null;
  };
  long: ImpulsePullbackState;
  short: ImpulsePullbackState;
}

function slope(current: number, previous: number): number {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return NaN;
  const base = Math.max(Math.abs(previous), 1e-9);
  return (current - previous) / base;
}

function minLow(candles: Candle[]): number {
  return candles.reduce((acc, c) => Math.min(acc, c.low), Number.POSITIVE_INFINITY);
}

function maxHigh(candles: Candle[]): number {
  return candles.reduce((acc, c) => Math.max(acc, c.high), Number.NEGATIVE_INFINITY);
}

export function analyzeImpulsePullback(opts: {
  entryCandles: Candle[];
  confirmCandles: Candle[];
  higherCandles: Candle[];
  config: StrategyContext['config'];
}): ImpulsePullbackAnalysis {
  const { entryCandles, confirmCandles, higherCandles, config } = opts;

  if (!entryCandles.length) {
    throw new Error('Impulse pullback analysis requires entry candles');
  }
  if (!confirmCandles.length) {
    throw new Error('Impulse pullback analysis requires confirmation candles');
  }
  if (!higherCandles.length) {
    throw new Error('Impulse pullback analysis requires higher timeframe candles');
  }

  const params: ImpulsePullbackParams = {
    timeframe: (config.ENTRY_TIMEFRAME ?? '5m') as string,
    confirmTf: ((config as any).IPC_CONFIRM_TF ?? '1h') as '15m' | '1h' | '4h',
    higherTf: ((config as any).IPC_HIGHER_TF ?? '1d') as '4h' | '1d',
    emaLen: Number((config as any).IPC_EMA_LEN ?? 50),
    zoneLookback: Number((config as any).IPC_ZONE_LOOKBACK ?? 30),
    zoneExclude: Number((config as any).IPC_ZONE_EXCLUDE ?? 2),
    zoneTolerance: Number((config as any).IPC_ZONE_TOLERANCE ?? 0.005),
    structureLookback: Number((config as any).IPC_STRUCTURE_LOOKBACK ?? 12),
    pullbackLookback: Number((config as any).IPC_PULLBACK_LOOKBACK ?? 6),
    pullbackTolerance: Number((config as any).IPC_PULLBACK_TOLERANCE ?? 0.002),
  };

  const entryCloses = entryCandles.map((c) => c.close);
  const entryEmaSeries = ema(entryCloses, params.emaLen);
  const entryEma = entryEmaSeries[entryEmaSeries.length - 1];
  const entryPrevEma =
    entryEmaSeries.length > 1 ? entryEmaSeries[entryEmaSeries.length - 2] : Number.NaN;
  const entryLast = last(entryCandles);
  const entryPrev = entryCandles.length > 1 ? entryCandles[entryCandles.length - 2] : entryLast;
  const pullbackSlice = entryCandles.slice(-Math.max(params.pullbackLookback + 1, 2));
  const pullbackLow = pullbackSlice.length ? minLow(pullbackSlice) : NaN;
  const pullbackHigh = pullbackSlice.length ? maxHigh(pullbackSlice) : NaN;

  const confirmCloses = confirmCandles.map((c) => c.close);
  const confirmEmaSeries = ema(confirmCloses, params.emaLen);
  const confirmEma = confirmEmaSeries[confirmEmaSeries.length - 1];
  const confirmPrevEma =
    confirmEmaSeries.length > 1 ? confirmEmaSeries[confirmEmaSeries.length - 2] : Number.NaN;
  const confirmLast = last(confirmCandles);
  const structureWindow = confirmCandles.slice(-Math.max(params.structureLookback + 1, 3), -1);
  const structureHigh = structureWindow.length ? maxHigh(structureWindow) : NaN;
  const structureLow = structureWindow.length ? minLow(structureWindow) : NaN;

  const trendSignals = getTrendSignals(confirmCandles, config);

  const higherLevels = computeLevels(
    higherCandles,
    Math.max(params.zoneExclude, 1),
    Math.max(params.zoneLookback, params.zoneExclude + 1),
  );
  const higherLast = last(higherCandles);
  const nearSupport = Number.isFinite(higherLevels.support)
    ? Math.abs(higherLast.low - higherLevels.support) /
        Math.max(Math.abs(higherLevels.support), 1e-9) <=
      params.zoneTolerance
    : false;
  const nearResistance = Number.isFinite(higherLevels.resistance)
    ? Math.abs(higherLast.high - higherLevels.resistance) /
        Math.max(Math.abs(higherLevels.resistance), 1e-9) <=
      params.zoneTolerance
    : false;

  const longTrendOk =
    trendSignals.bull &&
    Number.isFinite(confirmEma) &&
    Number.isFinite(confirmPrevEma) &&
    confirmLast.close > confirmEma &&
    confirmEma > confirmPrevEma;

  const shortTrendOk =
    trendSignals.bear &&
    Number.isFinite(confirmEma) &&
    Number.isFinite(confirmPrevEma) &&
    confirmLast.close < confirmEma &&
    confirmEma < confirmPrevEma;

  const longStructureOk =
    Number.isFinite(structureHigh) &&
    confirmLast.close > structureHigh &&
    confirmLast.close > confirmLast.open;

  const shortStructureOk =
    Number.isFinite(structureLow) &&
    confirmLast.close < structureLow &&
    confirmLast.close < confirmLast.open;

  const emaTolerance = params.pullbackTolerance;
  const pullbackTouchedLong =
    Number.isFinite(pullbackLow) &&
    Number.isFinite(entryEma) &&
    pullbackLow <= entryEma * (1 + emaTolerance);
  const pullbackTouchedShort =
    Number.isFinite(pullbackHigh) &&
    Number.isFinite(entryEma) &&
    pullbackHigh >= entryEma * (1 - emaTolerance);

  const longBreakout =
    Number.isFinite(entryEma) && entryLast.close > entryEma && entryLast.close > entryPrev.high;
  const shortBreakout =
    Number.isFinite(entryEma) && entryLast.close < entryEma && entryLast.close < entryPrev.low;

  const longPullbackOk = pullbackTouchedLong && longBreakout;
  const shortPullbackOk = pullbackTouchedShort && shortBreakout;

  const stopLong = pullbackSlice.length ? minLow(pullbackSlice) : NaN;
  const stopShort = pullbackSlice.length ? maxHigh(pullbackSlice) : NaN;

  const triggerLong = Number.isFinite(entryEma)
    ? Math.max(entryPrev.high, entryEma)
    : entryPrev.high;
  const triggerShort = Number.isFinite(entryEma)
    ? Math.min(entryPrev.low, entryEma)
    : entryPrev.low;

  const distanceToTriggerLong = Number.isFinite(triggerLong)
    ? Math.abs(entryLast.close - triggerLong) / Math.max(Math.abs(triggerLong), 1e-9)
    : NaN;
  const distanceToTriggerShort = Number.isFinite(triggerShort)
    ? Math.abs(entryLast.close - triggerShort) / Math.max(Math.abs(triggerShort), 1e-9)
    : NaN;

  const longReady = nearSupport && longTrendOk && longStructureOk && longPullbackOk;
  const shortReady = nearResistance && shortTrendOk && shortStructureOk && shortPullbackOk;

  const entrySlope = slope(entryEma, entryPrevEma);
  const confirmSlope = slope(confirmEma, confirmPrevEma);

  return {
    params,
    dailyLevels: {
      support: higherLevels.support,
      resistance: higherLevels.resistance,
      nearSupport,
      nearResistance,
      last: higherLast ?? null,
    },
    confirm: {
      ema: confirmEma,
      emaSlope: confirmSlope,
      structureHigh,
      structureLow,
      trendBull: trendSignals.bull,
      trendBear: trendSignals.bear,
      last: confirmLast ?? null,
    },
    entry: {
      ema: entryEma,
      emaSlope: entrySlope,
      pullbackLow,
      pullbackHigh,
      last: entryLast ?? null,
      prev: entryPrev ?? null,
    },
    long: {
      direction: 'LONG',
      zoneOk: nearSupport,
      trendOk: longTrendOk,
      structureOk: longStructureOk,
      pullbackOk: longPullbackOk,
      ready: longReady,
      triggerPrice: triggerLong,
      stopPrice: stopLong,
      distanceToTriggerPct: distanceToTriggerLong,
      ema: entryEma,
      emaSlope: entrySlope,
    },
    short: {
      direction: 'SHORT',
      zoneOk: nearResistance,
      trendOk: shortTrendOk,
      structureOk: shortStructureOk,
      pullbackOk: shortPullbackOk,
      ready: shortReady,
      triggerPrice: triggerShort,
      stopPrice: stopShort,
      distanceToTriggerPct: distanceToTriggerShort,
      ema: entryEma,
      emaSlope: entrySlope,
    },
  };
}

export const ImpulsePullbackContinuation: Strategy = {
  name: 'impulse_pullback_continuation',
  timeframe: '5m',

  async evaluate(ctx: StrategyContext) {
    const { exchange, symbol, config, logger } = ctx;

    const entryTf = (config.ENTRY_TIMEFRAME ?? '5m') as string;
    const confirmTf = ((config as any).IPC_CONFIRM_TF ?? '1h') as '15m' | '1h' | '4h';
    const higherTf = ((config as any).IPC_HIGHER_TF ?? '1d') as '4h' | '1d';

    const entryCandles = await exchange.getCandles(symbol, entryTf, 320);
    const confirmCandles = await exchange.getCandles(symbol, confirmTf, 200);
    const higherCandles = await exchange.getCandles(symbol, higherTf, 90);

    if (entryCandles.length < 80 || confirmCandles.length < 40 || higherCandles.length < 20) {
      return { action: 'IDLE', reason: 'ipc_few_candles' };
    }

    const analysis = analyzeImpulsePullback({
      entryCandles,
      confirmCandles,
      higherCandles,
      config,
    });

    if (analysis.long.ready) {
      if (logger) {
        logger.debug('ipc_long_signal', { analysis: analysis.long });
      }
      return {
        action: 'ENTER_LONG',
        reason: 'ipc_long',
        diagnostics: {
          trigger: analysis.long.triggerPrice,
          stop: analysis.long.stopPrice,
          zoneOk: analysis.long.zoneOk,
          trendOk: analysis.long.trendOk,
          structureOk: analysis.long.structureOk,
          pullbackOk: analysis.long.pullbackOk,
        },
      };
    }

    if (analysis.short.ready) {
      if (logger) {
        logger.debug('ipc_short_signal', { analysis: analysis.short });
      }
      return {
        action: 'ENTER_SHORT',
        reason: 'ipc_short',
        diagnostics: {
          trigger: analysis.short.triggerPrice,
          stop: analysis.short.stopPrice,
          zoneOk: analysis.short.zoneOk,
          trendOk: analysis.short.trendOk,
          structureOk: analysis.short.structureOk,
          pullbackOk: analysis.short.pullbackOk,
        },
      };
    }

    if (logger) {
      logger.debug('ipc_idle', {
        long: analysis.long,
        short: analysis.short,
        daily: analysis.dailyLevels,
      });
    }

    return {
      action: 'IDLE',
      reason: 'ipc_idle',
      diagnostics: {
        longReady: analysis.long.ready,
        shortReady: analysis.short.ready,
        nearSupport: analysis.dailyLevels.nearSupport,
        nearResistance: analysis.dailyLevels.nearResistance,
      },
    };
  },
};