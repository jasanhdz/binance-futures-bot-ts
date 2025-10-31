import { Exchange } from '../../core/ports/Exchange';
import { StateStore } from '../../core/ports/StateStore';
import { Logger } from '../../core/ports/Logger';
import { CONFIG } from '../../infra/config';
import { finalizeTrade } from '../trade-book-hooks';
import { ema } from '../../core/indicators/ema';
import { adx as adxCalc } from '../../core/indicators/adx';
import { computeFeatures } from '../../core/utils/features';
import {
  MlProbabilityServiceClient,
  MlProbabilityResponse,
  TimeframeProbability,
} from '../../ml/ml_probability_service';
import {
  computeWeightedScore,
  DirectionSignal,
  pickDirection,
  resolveBool,
  resolveExtraTimeframes,
} from '../../ml/ml_timeframe_utils';
import { Candle } from '../../core/types';

const mlClient = new MlProbabilityServiceClient();
const DEFAULT_HISTORY_BARS = Number(CONFIG.ML_HISTORY_BARS ?? 512);
const ML_PRIMARY_WEIGHT = 0.6;
const ML_CONFIRM_MARGIN_FACTOR = 0.5; // relative to base margin
const ML_CONFIRM_THRESHOLD_OFFSET = -0.05; // adjustment vs primary threshold
const ML_CONFIRM_THRESHOLD_MIN = 0.55;
const ML_EXIT_MARGIN_EXTRA = 0.05;
const ML_MOMENTUM_DELTA = 0.1;
const ML_ALLOW_OPPOSITE_HOLD = false;

const weightedScoreMemory = new Map<string, number>();

function computeRoe(opts: {
  side: 'LONG' | 'SHORT';
  entry: number;
  mark: number;
  qty: number;
  leverage: number;
}): number {
  const { side, entry, mark, qty, leverage } = opts;
  if (!entry || !qty || !leverage) return 0;
  const direction = side === 'LONG' ? 1 : -1;
  const pnl = (mark - entry) * qty * direction;
  const notional = mark * qty;
  const margin = notional / Math.max(1, leverage);
  return margin ? pnl / margin : 0;
}

function mapTimeframeProbabilities(
  response: MlProbabilityResponse,
): Map<string, TimeframeProbability> {
  const map = new Map<string, TimeframeProbability>();
  map.set(response.primary_timeframe, {
    long_prob: response.long_prob,
    short_prob: response.short_prob,
  });
  Object.entries(response.probabilities ?? {}).forEach(([tf, probs]) => {
    map.set(tf, probs);
  });
  return map;
}

async function loadCandles(
  ex: Exchange,
  symbol: string,
  timeframe: string,
  historyBars: number,
): Promise<Candle[] | null> {
  const candles = await ex.getCandles(symbol, timeframe, Math.max(historyBars, 160));
  if (!candles.length) return null;
  return candles;
}

async function fetchMlProbabilities(
  ex: Exchange,
  symbol: string,
  primaryTimeframe: string,
  historyBars: number,
): Promise<MlProbabilityResponse | null> {
  const primaryCandles = await loadCandles(ex, symbol, primaryTimeframe, historyBars);
  if (!primaryCandles) return null;

  const configAny = CONFIG as Record<string, unknown>;
  const extras = resolveExtraTimeframes(
    {
      extra: configAny['ML_EXTRA_TIMEFRAMES'],
      additional: configAny['ML_ADDITIONAL_TIMEFRAMES'],
    },
    primaryTimeframe,
  );
  const extraCandles: Record<string, Candle[]> = {};
  for (const tf of extras) {
    const candles = await loadCandles(ex, symbol, tf, historyBars);
    if (candles && candles.length >= Math.min(historyBars, 64)) {
      extraCandles[tf] = candles;
    }
  }

  try {
    const response = await mlClient.fetchProbabilities({
      symbol,
      candles: primaryCandles,
      timeframe: primaryTimeframe,
      extraCandles,
    });
    return response;
  } catch {
    return null;
  }
}

function selectHoldDecision(params: {
  side: 'LONG' | 'SHORT';
  drop: number;
  trailDrop: number;
  weightedScore: number;
  holdThreshold: number;
  consensusDirection: DirectionSignal;
  allowHoldOpposite: boolean;
}): boolean {
  const { side, drop, trailDrop, weightedScore, holdThreshold, consensusDirection, allowHoldOpposite } =
    params;
  if (drop >= trailDrop) return false;
  if (consensusDirection && consensusDirection !== side && !allowHoldOpposite) {
    return false;
  }
  if (side === 'LONG') {
    return weightedScore >= holdThreshold;
  }
  return weightedScore <= -holdThreshold;
}

function shouldExit(params: {
  side: 'LONG' | 'SHORT';
  weightedScore: number;
  exitThreshold: number;
  consensusDirection: DirectionSignal;
  trendStrong: boolean;
  momentumFlip: boolean;
}): boolean {
  const { side, weightedScore, exitThreshold, consensusDirection, trendStrong, momentumFlip } = params;
  if (consensusDirection && consensusDirection !== side) {
    return true;
  }
  if (side === 'LONG') {
    return weightedScore <= -exitThreshold || (!trendStrong && momentumFlip);
  }
  return weightedScore >= exitThreshold || (!trendStrong && momentumFlip);
}

export async function intelligentTakeProfitMl(
  symbol: string,
  ex: Exchange,
  st: StateStore,
  log: Logger,
) {
  const state = st.get();
  if (state.mode === 'IDLE' || !state.lastSide || !state.lastEntryPrice) return;

  const pos = await ex.readActivePosition(symbol, state.lastSide);
  if (!pos || !pos.qtyAbs) return;

  const mark = await ex.getMarkPrice(symbol);
  const leverage = pos.leverage ?? state.lastLeverage ?? CONFIG.LEVERAGE;
  const roe = computeRoe({
    side: state.lastSide,
    entry: state.lastEntryPrice,
    mark,
    qty: pos.qtyAbs,
    leverage: Math.max(leverage, 1),
  });

  const peak = state.peakRoe ?? roe;
  const newPeak = Math.max(peak, roe);
  if (newPeak !== peak) {
    st.set({ peakRoe: newPeak });
  }

  const minRoe = Number(CONFIG.INT_TP_MIN_ROE ?? 0.2);
  if (roe < minRoe) return;

  const now = Date.now();
  const cooldown = Number(CONFIG.INT_TP_COOLDOWN_MS ?? 15_000);
  if (state.lastIntelliTpAt && now - state.lastIntelliTpAt < cooldown) {
    return;
  }

  const lookback = Math.max(40, Number(CONFIG.INT_TP_LOOKBACK ?? 40));
  const tf = CONFIG.ENTRY_TIMEFRAME;
  const candles = await ex.getCandles(symbol, tf, Math.max(lookback * 2, 160));
  if (candles.length < lookback) return;

  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const emaFast = ema(closes, 13);
  const emaSlow = ema(closes, 34);
  const fast = emaFast[emaFast.length - 1];
  const slow = emaSlow[emaSlow.length - 1];
  const { adx } = adxCalc(highs, lows, closes, 14);
  const features = computeFeatures(candles);
  const rsi = features.rsi;
  const lastClose = closes[closes.length - 1];

  const adxMin = Number(CONFIG.INT_TP_TREND_ADX ?? 18);
  const trailDrop = Math.max(0, Math.min(1, Number(CONFIG.INT_TP_TRAIL_DROP ?? 0.35)));
  const drop = newPeak > 0 ? Math.max(0, (newPeak - roe) / Math.max(newPeak, 1e-9)) : 0;

  const trendStrongLong = fast > slow && adx >= adxMin && rsi >= 45 && lastClose >= slow;
  const trendStrongShort = fast < slow && adx >= adxMin && rsi <= 55 && lastClose <= slow;
  const trendStrong = state.lastSide === 'LONG' ? trendStrongLong : trendStrongShort;

  const primaryTimeframe = CONFIG.ML_MODEL_TIMEFRAME || CONFIG.ENTRY_TIMEFRAME;
  const baseMargin = Number(CONFIG.ML_MARGIN ?? 0.12);
  const baseLongThreshold = Number(CONFIG.ML_THRESHOLD_LONG ?? 0.5);
  const baseShortThreshold = Number(CONFIG.ML_THRESHOLD_SHORT ?? 0.5);
  const margin = baseMargin;
  const longThreshold = baseLongThreshold;
  const shortThreshold = baseShortThreshold;
  const confirmMargin = Math.max(baseMargin * ML_CONFIRM_MARGIN_FACTOR, 0.05);
  const confirmLongThreshold = Math.max(
    baseLongThreshold + ML_CONFIRM_THRESHOLD_OFFSET,
    ML_CONFIRM_THRESHOLD_MIN,
  );
  const confirmShortThreshold = Math.max(
    baseShortThreshold + ML_CONFIRM_THRESHOLD_OFFSET,
    ML_CONFIRM_THRESHOLD_MIN,
  );
  const primaryWeight = ML_PRIMARY_WEIGHT;
  const allowLongs = resolveBool(CONFIG.ALLOW_LONGS, true);
  const allowShorts = resolveBool(CONFIG.ALLOW_SHORTS, true);

  const historyBars = Math.max(DEFAULT_HISTORY_BARS, 256);
  const mlResponse = await fetchMlProbabilities(ex, symbol, primaryTimeframe, historyBars);
  if (!mlResponse) {
    log.debug('tp_ml_fallback', { symbol, reason: 'ml_unavailable' });
    return;
  }

  const tfMap = mapTimeframeProbabilities(mlResponse);
  const primaryProbs = tfMap.get(primaryTimeframe) ?? {
    long_prob: mlResponse.long_prob,
    short_prob: mlResponse.short_prob,
  };
  const extraEntries = Array.from(tfMap.entries())
    .filter(([tf]) => tf !== primaryTimeframe)
    .map(([tf, value]) => ({ timeframe: tf, ...value }));

  const extraDecisions = extraEntries.map((entry) => {
    const direction = pickDirection({
      longProb: entry.long_prob,
      shortProb: entry.short_prob,
      longThreshold: confirmLongThreshold,
      shortThreshold: confirmShortThreshold,
      margin: confirmMargin,
    });
    return {
      timeframe: entry.timeframe,
      long: entry.long_prob,
      short: entry.short_prob,
      direction,
      gap: Math.abs(entry.long_prob - entry.short_prob),
    };
  });

  const primaryDirection = pickDirection({
    longProb: primaryProbs.long_prob,
    shortProb: primaryProbs.short_prob,
    longThreshold,
    shortThreshold,
    margin,
  });

  const consensusDirection =
    primaryDirection && extraDecisions.length > 0 && extraDecisions.every((entry) => entry.direction === primaryDirection)
      ? primaryDirection
      : null;

  const weightedScore = computeWeightedScore(
    { long: primaryProbs.long_prob, short: primaryProbs.short_prob },
    extraEntries.map((entry) => ({ long: entry.long_prob, short: entry.short_prob })),
    primaryWeight,
  );

  const holdThreshold = baseMargin;
  const exitThreshold = Math.max(holdThreshold + ML_EXIT_MARGIN_EXTRA, baseMargin + ML_EXIT_MARGIN_EXTRA);
  const allowHoldOpposite = ML_ALLOW_OPPOSITE_HOLD;

  const previousScore = weightedScoreMemory.get(symbol) ?? weightedScore;
  const momentumDelta = ML_MOMENTUM_DELTA;
  const momentumFlip =
    Math.sign(previousScore) !== Math.sign(weightedScore) &&
    Math.abs(weightedScore - previousScore) >= momentumDelta;

  const holdDecision = selectHoldDecision({
    side: state.lastSide,
    drop,
    trailDrop,
    weightedScore,
    holdThreshold,
    consensusDirection,
    allowHoldOpposite,
  });

  const exitDecision = shouldExit({
    side: state.lastSide,
    weightedScore,
    exitThreshold,
    consensusDirection,
    trendStrong,
    momentumFlip,
  });

  const mlDiagnostics = {
    weightedScore,
    previousScore,
    momentumFlip,
    holdDecision,
    exitDecision,
    consensusDirection,
    primaryDirection,
    extraDecisions,
  };

  weightedScoreMemory.set(symbol, weightedScore);

  if (holdDecision && !exitDecision) {
    st.set({
      lastIntelliTpAt: now,
      intelliTpState: 'ride',
    });
    log.debug('tp_ml_hold', {
      symbol,
      side: state.lastSide,
      roe,
      peak: newPeak,
      drop,
      trendStrong,
      ...mlDiagnostics,
    });
    return;
  }

  if (!exitDecision) {
    log.debug('tp_ml_idle', {
      symbol,
      side: state.lastSide,
      roe,
      drop,
      trendStrong,
      ...mlDiagnostics,
    });
    return;
  }

  await ex.closeSideMarketSafe(symbol, state.lastSide, pos.qtyAbs, pos.sideMode);
  await (ex as any).cancelCloseOrdersForSide?.(symbol, state.lastSide);

  const resetPatch = await finalizeTrade({
    symbol,
    exchange: ex,
    state: st,
    logger: log,
    reason: 'tp_ml_guard',
    exitPrice: mark,
  });

  st.set({
    mode: 'IDLE',
    lastExitReason: 'tp_ml_guard',
    lastExitAt: now,
    lastIntelliTpAt: now,
    intelliTpState: 'exit',
    peakRoe: 0,
    ...resetPatch,
  });

  log.info('tp_ml_exit', {
    symbol,
    side: state.lastSide,
    roe,
    peak: newPeak,
    drop,
    trendStrong,
    ...mlDiagnostics,
  });
}
