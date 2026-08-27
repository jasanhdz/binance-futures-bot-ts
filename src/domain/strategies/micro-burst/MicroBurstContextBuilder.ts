import { Candle, Side } from '../../types';
import {
  BtcContext,
  BtcDataStatus,
  DataQualityDiagnostics,
  MicroBurstCandleSet,
  MicroBurstConfig,
  MicroBurstContext,
  MicroRegime,
  OrderBookSnapshot,
  defaultMicroBurstConfig,
} from './MicroBurstTypes';
import { MicroBurstReferencePrice } from './MicroBurstMarketDataTypes';
import { analyzeBookPressure, isBookHealthy } from './MicroBurstBookPressureAnalyzer';
import { hasBtcConflict } from './MicroBurstBtcContext';
import { analyzeMicroMomentum } from './MicroBurstMomentumAnalyzer';
import { classifyMicroRegime } from './MicroBurstMicroRegime';
import { detectSupportResistance } from './MicroBurstSupportResistance';

export interface CandleSnapshotProvider {
  getCandles(symbol: string, interval: string, limit: number): Promise<Candle[]>;
}

export interface BtcMicroContextProvider {
  getBtcContext(): BtcContext | undefined;
}

export interface OrderBookSnapshotProvider {
  getDepthSnapshot(symbol: string): OrderBookSnapshot | undefined;
}

export interface ReferencePriceProvider {
  getReferencePrice(symbol: string, bookSnapshot?: {
    bidDepth: { price: number }[];
    askDepth: { price: number }[];
  }): MicroBurstReferencePrice | undefined;
}

export interface AggTradeFlowProvider {
  getTakerFlow(symbol: string): { buyVolume: number; sellVolume: number; netTakerVolume: number; tradeCount: number };
}

export interface MicroBurstContextBuilderDeps {
  candles: CandleSnapshotProvider;
  btc?: BtcMicroContextProvider;
  book?: OrderBookSnapshotProvider;
  referencePrice?: ReferencePriceProvider;
  aggTradeFlow?: AggTradeFlowProvider;
}

export interface MicroBurstContextBuildOptions {
  snapshotAtMs: number;
  config?: Partial<MicroBurstConfig>;
}

export function filterClosedCandles(candles: Candle[], snapshotAtMs: number): Candle[] {
  return candles.filter((candle) => candle.closeTime <= snapshotAtMs);
}

function isStrictlyOrdered(candles: Candle[]): boolean {
  return candles.every(
    (candle, index) =>
      Number.isFinite(candle.openTime) &&
      Number.isFinite(candle.closeTime) &&
      candle.closeTime >= candle.openTime &&
      (index === 0 || candles[index - 1].closeTime < candle.closeTime),
  );
}

function freshnessMs(snapshotAtMs: number, candles: Candle[]): number {
  const latestCloseTime = candles[candles.length - 1]?.closeTime;
  return latestCloseTime === undefined ? Infinity : snapshotAtMs - latestCloseTime;
}

function btcStatusAt(
  btcContext: BtcContext | undefined,
  snapshotAtMs: number,
  freshnessMaxMs: number,
): BtcDataStatus {
  if (!btcContext) return 'UNAVAILABLE';
  const ageMs = snapshotAtMs - btcContext.observedAtMs;
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > freshnessMaxMs) return 'STALE';
  return 'HEALTHY';
}

function getDataQuality(
  snapshotAtMs: number,
  rawCandleSets: MicroBurstCandleSet,
  closedCandleSets: MicroBurstCandleSet,
  bookSnapshot: OrderBookSnapshot | undefined,
  btcContext: BtcContext | undefined,
  levelsAvailableAt: number | null,
  config: MicroBurstConfig,
  bookStatus: DataQualityDiagnostics['bookStatus'],
): DataQualityDiagnostics {
  const freshness1mMs = freshnessMs(snapshotAtMs, closedCandleSets.candles1m);
  const freshness3mMs = freshnessMs(snapshotAtMs, closedCandleSets.candles3m);
  const freshness5mMs = freshnessMs(snapshotAtMs, closedCandleSets.candles5m);
  const btcStatus = btcStatusAt(btcContext, snapshotAtMs, config.btcFreshnessMaxMs);
  const bookAgeMs = bookSnapshot ? snapshotAtMs - bookSnapshot.observedAtMs : null;
  const btcAgeMs = btcContext ? snapshotAtMs - btcContext.observedAtMs : null;
  const invalidReasons: string[] = [];

  if (!isStrictlyOrdered(rawCandleSets.candles1m)) invalidReasons.push('invalid_1m_order');
  if (!isStrictlyOrdered(rawCandleSets.candles3m)) invalidReasons.push('invalid_3m_order');
  if (!isStrictlyOrdered(rawCandleSets.candles5m)) invalidReasons.push('invalid_5m_order');
  if (closedCandleSets.candles1m.length < 30) invalidReasons.push('insufficient_1m_candles');
  if (closedCandleSets.candles3m.length < 20) invalidReasons.push('insufficient_3m_candles');
  if (closedCandleSets.candles5m.length < 15) invalidReasons.push('insufficient_5m_candles');
  if (freshness1mMs > config.candleFreshness1mMaxMs) invalidReasons.push('stale_1m_candles');
  if (freshness3mMs > config.candleFreshness3mMaxMs) invalidReasons.push('stale_3m_candles');
  if (freshness5mMs > config.candleFreshness5mMaxMs) invalidReasons.push('stale_5m_candles');
  if (bookStatus !== 'HEALTHY') invalidReasons.push(`book_${bookStatus.toLowerCase()}`);
  if (btcStatus !== 'HEALTHY') invalidReasons.push(`btc_${btcStatus.toLowerCase()}`);
  if (levelsAvailableAt !== null && levelsAvailableAt > snapshotAtMs)
    invalidReasons.push('future_support_resistance_level');

  const closedCandlesOnly = Object.values(closedCandleSets)
    .flat()
    .every((candle) => candle.closeTime <= snapshotAtMs);

  return {
    snapshotAtMs,
    latestClosed1mAt:
      closedCandleSets.candles1m[closedCandleSets.candles1m.length - 1]?.closeTime ?? 0,
    latestClosed3mAt:
      closedCandleSets.candles3m[closedCandleSets.candles3m.length - 1]?.closeTime ?? 0,
    latestClosed5mAt:
      closedCandleSets.candles5m[closedCandleSets.candles5m.length - 1]?.closeTime ?? 0,
    freshness1mMs,
    freshness3mMs,
    freshness5mMs,
    bookAgeMs,
    btcAgeMs,
    bookStatus,
    btcStatus,
    closedCandlesOnly,
    levelsAvailableAt,
    contextValid: invalidReasons.length === 0,
    invalidReasons,
  };
}

function computeStructuralClarity(
  regime: MicroRegime,
  nearSupport: boolean,
  nearResistance: boolean,
  momentumDirection: Side | 'NEUTRAL',
  momentumStrength: number,
  bookHealthy: boolean,
): boolean {
  // EXPERIMENTAL_DEFAULT: volatile-regime avoidance is not a correctness invariant.
  if (regime === 'VOLATILE') return false;
  return (
    (nearSupport || nearResistance) &&
    momentumDirection !== 'NEUTRAL' &&
    momentumStrength >= 0.3 &&
    bookHealthy
  );
}

export async function buildMicroBurstContext(
  symbol: string,
  deps: MicroBurstContextBuilderDeps,
  options: MicroBurstContextBuildOptions,
): Promise<MicroBurstContext> {
  const config = { ...defaultMicroBurstConfig(), ...options.config };
  const snapshotAtMs = options.snapshotAtMs;
  if (!Number.isFinite(snapshotAtMs) || snapshotAtMs <= 0) {
    throw new Error('MICRO_BURST_INVALID_SNAPSHOT_AT');
  }

  const [rawCandles1m, rawCandles3m, rawCandles5m] = await Promise.all([
    deps.candles.getCandles(symbol, '1m', 100),
    deps.candles.getCandles(symbol, '3m', 80),
    deps.candles.getCandles(symbol, '5m', 60),
  ]);
  const rawCandleSets = {
    candles1m: rawCandles1m,
    candles3m: rawCandles3m,
    candles5m: rawCandles5m,
  };
  const candles: MicroBurstCandleSet = {
    candles1m: filterClosedCandles(rawCandles1m, snapshotAtMs),
    candles3m: filterClosedCandles(rawCandles3m, snapshotAtMs),
    candles5m: filterClosedCandles(rawCandles5m, snapshotAtMs),
  };
  const currentPrice = candles.candles1m[candles.candles1m.length - 1]?.close ?? 0;
  const levels = detectSupportResistance(candles.candles5m, {
    lookbackBars: config.srLookbackBars,
    pivotLeftBars: config.srPivotLeftBars,
    pivotRightBars: config.srPivotRightBars,
    clusterToleranceBps: config.srClusterToleranceBps,
    minStrength: config.srMinStrength,
    nearLevelThresholdBps: config.nearLevelThresholdBps,
    snapshotAtMs,
  });
  const levelsAvailableAt = levels.levels.length
    ? Math.max(...levels.levels.map((level) => level.availableAtMs))
    : null;
  const momentum = analyzeMicroMomentum(
    candles.candles1m,
    candles.candles3m,
    candles.candles5m,
    config.momentumSlopePeriod,
  );
  const bookSnapshot = deps.book?.getDepthSnapshot(symbol);
  const bookPressure = analyzeBookPressure(bookSnapshot, snapshotAtMs, {
    anomalySpreadBps: config.bookAnomalySpreadBps,
    minImbalance: config.bookMinImbalance,
    freshnessMaxMs: config.bookFreshnessMaxMs,
  });
  const refPrice = deps.referencePrice?.getReferencePrice(symbol, bookSnapshot);
  const btcRaw = deps.btc?.getBtcContext();
  const candidateSide: Side | 'NEUTRAL' =
    levels.nearest.structuralPosition === 'near_support'
      ? 'LONG'
      : levels.nearest.structuralPosition === 'near_resistance'
        ? 'SHORT'
        : 'NEUTRAL';
  const btcContext = btcRaw
    ? {
        ...btcRaw,
        conflictFlag: hasBtcConflict(candidateSide, btcRaw, config.btcConflictThresholdBps),
      }
    : null;
  const microRegime = classifyMicroRegime(candles.candles5m);
  const structuralClarity = computeStructuralClarity(
    microRegime,
    levels.nearest.structuralPosition === 'near_support',
    levels.nearest.structuralPosition === 'near_resistance',
    momentum.direction,
    momentum.strength,
    isBookHealthy(bookPressure),
  );
  const dataQuality = getDataQuality(
    snapshotAtMs,
    rawCandleSets,
    candles,
    bookSnapshot,
    btcRaw,
    levelsAvailableAt,
    config,
    bookPressure.status,
  );
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
    dataQuality.contextValid = false;
    dataQuality.invalidReasons.push('invalid_reference_price');
  }

  if (refPrice && (!Number.isFinite(refPrice.price) || refPrice.price <= 0)) {
    dataQuality.contextValid = false;
    dataQuality.invalidReasons.push('invalid_market_price');
  }

  const aggTradeFlow = deps.aggTradeFlow?.getTakerFlow(symbol);

  return {
    symbol,
    timestamp: snapshotAtMs,
    currentPrice,
    marketPriceAtSnapshot: refPrice?.price,
    candles,
    levels,
    momentum,
    bookPressure,
    btcContext,
    structuralClarity,
    microRegime,
    dataQuality,
    ...(aggTradeFlow && aggTradeFlow.tradeCount > 0
      ? { aggTradeFlow: {
          buyTakerVolume: aggTradeFlow.buyVolume,
          sellTakerVolume: aggTradeFlow.sellVolume,
          netTakerFlow: aggTradeFlow.netTakerVolume,
          tradeCount: aggTradeFlow.tradeCount,
        }}
      : {}),
  };
}
