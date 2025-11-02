import { Strategy } from './types';
import { Candle, Signal } from '../core/types';
import { last, volumeAvg, bodyPct, countStreak } from '../core/utils/candles';
import { ema } from '../core/indicators/ema';

interface StackingParams {
  timeframe: string;
  trendTimeframe: string;
  volAvgLen: number;
  entryEmaPeriod: number;
  trendEmaPeriod: number;
  entryMaxExtension: number;
  climaxBodyPct: number;
  climaxVolFactor: number;
  volFactorLong: number;
  volFactorShort: number;
  minGreenStreak: number;
  minRedStreak: number;
  maxEntryStreak: number;
  retestLookback: number;
  allowLongs: boolean;
  allowShorts: boolean;
}

function resolveNumber(value: unknown, fallback: number): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function resolveParams(config: any): StackingParams {
  const timeframe =
    (config?.STACKC_TIMEFRAME as string) || config?.ENTRY_TIMEFRAME || '5m';
  const trendTimeframe =
    (config?.STACKC_TREND_TIMEFRAME as string) || config?.TREND_TIMEFRAME || '15m';

  const allowLongs =
    typeof config?.ALLOW_LONGS === 'boolean' ? (config.ALLOW_LONGS as boolean) : true;
  const allowShorts =
    typeof config?.ALLOW_SHORTS === 'boolean' ? (config.ALLOW_SHORTS as boolean) : true;

  const volFactorLong = resolveNumber(config?.STACKC_VOL_FACTOR ?? config?.VOL_FACTOR_ENTRY, 1.8);
  const volFactorShort = resolveNumber(config?.STACKC_VOL_FACTOR_SHORT ?? volFactorLong, volFactorLong);

  return {
    timeframe,
    trendTimeframe,
    volAvgLen: resolveNumber(config?.STACKC_VOL_AVG_LEN ?? config?.VOL_AVG_LEN, 20),
    entryEmaPeriod: resolveNumber(config?.STACKC_ENTRY_EMA_PERIOD ?? config?.ENTRY_EMA_PERIOD, 20),
    trendEmaPeriod: resolveNumber(config?.STACKC_TREND_EMA_PERIOD, 50),
    entryMaxExtension: resolveNumber(
      config?.STACKC_ENTRY_MAX_EXTENSION ?? config?.ENTRY_MAX_EMA_EXTENSION,
      0.004,
    ),
    climaxBodyPct: resolveNumber(config?.STACKC_CLIMAX_BODY_PCT, 0.75),
    climaxVolFactor: resolveNumber(config?.STACKC_CLIMAX_VOL_FACTOR, 2.2),
    volFactorLong,
    volFactorShort,
    minGreenStreak: resolveNumber(config?.STACKC_GREEN_STREAK ?? config?.GREEN_STREAK_MIN, 3),
    minRedStreak: resolveNumber(config?.STACKC_RED_STREAK ?? config?.RED_STREAK_MIN, 3),
    maxEntryStreak: resolveNumber(
      config?.STACKC_ENTRY_MAX_STREAK ?? config?.ENTRY_MAX_STREAK,
      6,
    ),
    retestLookback: resolveNumber(config?.STACKC_RETEST_LOOKBACK, 30),
    allowLongs,
    allowShorts,
  };
}

function computePrevLevels(candles: Candle[], lookback: number) {
  const slice = candles.slice(-lookback - 1, -1);
  if (!slice.length) {
    return { prevHigh: Number.NaN, prevLow: Number.NaN };
  }
  let prevHigh = -Infinity;
  let prevLow = Infinity;
  for (const c of slice) {
    if (c.high > prevHigh) prevHigh = c.high;
    if (c.low < prevLow) prevLow = c.low;
  }
  return { prevHigh, prevLow };
}

function buildDiagnostics(opts: {
  candles: Candle[];
  trendCandles: Candle[];
  params: StackingParams;
  vAvg: number;
  bodyRatio: number;
  greens: number;
  reds: number;
  brokeUpPrev: boolean;
  brokeDnPrev: boolean;
  longRetest: boolean;
  shortRetest: boolean;
  distUp: number;
  distDn: number;
  trendUp: boolean;
  trendDown: boolean;
  reason: string;
}): Record<string, unknown> {
  const {
    candles,
    trendCandles,
    params,
    vAvg,
    bodyRatio,
    greens,
    reds,
    brokeUpPrev,
    brokeDnPrev,
    longRetest,
    shortRetest,
    distUp,
    distDn,
    trendUp,
    trendDown,
    reason,
  } = opts;
  const lastCandle = last(candles);
  return {
    reason,
    timeframe: params.timeframe,
    trendTimeframe: params.trendTimeframe,
    lastClose: lastCandle.close,
    volume: lastCandle.volume,
    volumeAvg: vAvg,
    bodyRatio,
    greens,
    reds,
    brokeUpPrev,
    brokeDnPrev,
    longRetest,
    shortRetest,
    distUp,
    distDn,
    trendUp,
    trendDown,
    candles: candles.length,
    trendCandles: trendCandles.length,
  };
}

async function evaluateStacking(ctx: Parameters<Strategy['evaluate']>[0]): Promise<Signal> {
  const { symbol, exchange, config, state, now, logger } = ctx;
  const params = resolveParams(config);

  if (state.mode !== 'IDLE') {
    return { action: 'IDLE', reason: `symbol=${symbol} position_active` };
  }

  const cooldown = resolveNumber(config?.REENTER_COOLDOWN_MS, 60_000);
  if (
    state.lastExitReason === 'tp' &&
    typeof state.lastTPAt === 'number' &&
    now - state.lastTPAt < cooldown
  ) {
    return { action: 'IDLE', reason: `symbol=${symbol} tp_cooldown` };
  }

  const minCandles = Math.max(60, params.retestLookback + 5, params.entryEmaPeriod + 2);
  const candles = await exchange.getCandles(symbol, params.timeframe, Math.max(minCandles, 300));
  if (candles.length < minCandles) {
    return { action: 'IDLE', reason: `symbol=${symbol} few_candles` };
  }

  const c0 = last(candles);
  const c1 = candles[candles.length - 2];
  const closes = candles.map((c) => c.close);
  const emaEntryArr = ema(closes, params.entryEmaPeriod);
  const emaEntry = emaEntryArr[emaEntryArr.length - 1];
  const emaEntrySafe = Number.isFinite(emaEntry) ? (emaEntry as number) : c0.close;

  const volumeAverage = volumeAvg(candles, params.volAvgLen);
  const bodyRatio = bodyPct(c0);

  const climax =
    bodyRatio >= params.climaxBodyPct && c0.volume >= params.climaxVolFactor * volumeAverage;

  const distUp = (c0.close - emaEntrySafe) / Math.max(1e-9, emaEntrySafe);
  const distDn = (emaEntrySafe - c0.close) / Math.max(1e-9, emaEntrySafe);

  const trendCandles = await exchange.getCandles(
    symbol,
    params.trendTimeframe,
    Math.max(params.trendEmaPeriod + 5, 200),
  );
  if (trendCandles.length < params.trendEmaPeriod + 2) {
    return { action: 'IDLE', reason: `symbol=${symbol} few_trend_candles` };
  }
  const trendEmaArr = ema(trendCandles.map((c) => c.close), params.trendEmaPeriod);
  const trendLast = trendEmaArr[trendEmaArr.length - 1];
  const trendPrev = trendEmaArr[trendEmaArr.length - 2];
  const trendUp = Number.isFinite(trendLast) && Number.isFinite(trendPrev) && trendLast > trendPrev;
  const trendDown =
    Number.isFinite(trendLast) && Number.isFinite(trendPrev) && trendLast < trendPrev;

  const greens = countStreak(candles, 'green');
  const reds = countStreak(candles, 'red');

  const { prevHigh, prevLow } = computePrevLevels(candles, params.retestLookback);
  const brokeUpPrev = Number.isFinite(prevHigh) && (c1.close > prevHigh || c1.high > prevHigh);
  const brokeDnPrev = Number.isFinite(prevLow) && (c1.close < prevLow || c1.low < prevLow);

  const longRetest =
    Number.isFinite(prevHigh) &&
    (c0.low <= Math.max(emaEntrySafe, prevHigh) || c0.close <= Math.max(emaEntrySafe, prevHigh));
  const shortRetest =
    Number.isFinite(prevLow) &&
    (c0.high >= Math.min(emaEntrySafe, prevLow) || c0.close >= Math.min(emaEntrySafe, prevLow));

  logger?.debug('stacking_classic_state', {
    climax,
    distUp,
    distDn,
    volumeAverage,
    bodyRatio,
    greens,
    reds,
    brokeUpPrev,
    brokeDnPrev,
    longRetest,
    shortRetest,
    trendUp,
    trendDown,
  });

  // Long entries
  if (
    params.allowLongs &&
    !climax &&
    trendUp &&
    distUp <= params.entryMaxExtension &&
    c0.volume >= params.volFactorLong * volumeAverage
  ) {
    if (brokeUpPrev && longRetest) {
      const diagnostics = buildDiagnostics({
        candles,
        trendCandles,
        params,
        vAvg: volumeAverage,
        bodyRatio,
        greens,
        reds,
        brokeUpPrev,
        brokeDnPrev,
        longRetest,
        shortRetest,
        distUp,
        distDn,
        trendUp,
        trendDown,
        reason: 'break_retest_long',
      });
      return { action: 'ENTER_LONG', reason: 'break_retest_long', diagnostics };
    }

    if (
      greens >= params.minGreenStreak &&
      greens <= params.maxEntryStreak &&
      c0.volume >= params.volFactorLong * volumeAverage
    ) {
      const diagnostics = buildDiagnostics({
        candles,
        trendCandles,
        params,
        vAvg: volumeAverage,
        bodyRatio,
        greens,
        reds,
        brokeUpPrev,
        brokeDnPrev,
        longRetest,
        shortRetest,
        distUp,
        distDn,
        trendUp,
        trendDown,
        reason: 'stack_long',
      });
      return { action: 'ENTER_LONG', reason: 'stack_long', diagnostics };
    }
  }

  // Short entries
  if (
    params.allowShorts &&
    !climax &&
    trendDown &&
    distDn <= params.entryMaxExtension &&
    c0.volume >= params.volFactorShort * volumeAverage
  ) {
    if (brokeDnPrev && shortRetest) {
      const diagnostics = buildDiagnostics({
        candles,
        trendCandles,
        params,
        vAvg: volumeAverage,
        bodyRatio,
        greens,
        reds,
        brokeUpPrev,
        brokeDnPrev,
        longRetest,
        shortRetest,
        distUp,
        distDn,
        trendUp,
        trendDown,
        reason: 'break_retest_short',
      });
      return { action: 'ENTER_SHORT', reason: 'break_retest_short', diagnostics };
    }

    if (
      reds >= params.minRedStreak &&
      reds <= params.maxEntryStreak &&
      c0.volume >= params.volFactorShort * volumeAverage
    ) {
      const diagnostics = buildDiagnostics({
        candles,
        trendCandles,
        params,
        vAvg: volumeAverage,
        bodyRatio,
        greens,
        reds,
        brokeUpPrev,
        brokeDnPrev,
        longRetest,
        shortRetest,
        distUp,
        distDn,
        trendUp,
        trendDown,
        reason: 'stack_short',
      });
      return { action: 'ENTER_SHORT', reason: 'stack_short', diagnostics };
    }
  }

  return { action: 'IDLE', reason: `symbol=${symbol} no_setup` };
}

export const StackingClassicStrategy: Strategy = {
  name: 'stacking_classic',
  timeframe: '5m',
  evaluate: evaluateStacking,
};

export function createStackingClassicStrategy(): Strategy {
  return StackingClassicStrategy;
}
