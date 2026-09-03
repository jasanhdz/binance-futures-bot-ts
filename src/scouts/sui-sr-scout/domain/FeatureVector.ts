import type {
  FeatureVector,
  LevelGeometryFeatures,
  PriceVolatilityFeatures,
  OrderFlowFeatures,
  BookFeatures,
  FuturesContextFeatures,
  BtcContextFeatures,
  FeatureUnavailableReason,
  LevelCandidateEvent,
  SrZone,
  ScoutSymbol,
} from './ScoutTypes';
import { FEATURE_SCHEMA_VERSION } from './ScoutTypes';
import type { BuiltCandle } from '../market/ThreeMinuteCandleBuilder';
import type { RawAggTradeEvent, RawDepthEvent } from '../market/ScoutMarketDataRuntime';
import type { ScoutFuturesContext } from '../market/ScoutMarketDataRuntime';

export interface FeatureVectorBuilder {
  build(
    event: LevelCandidateEvent,
    candles1m: BuiltCandle[],
    candles3m: BuiltCandle[],
    aggTrades: RawAggTradeEvent[],
    depthBids: RawDepthEvent[],
    depthAsks: RawDepthEvent[],
    btcCandles1m: BuiltCandle[],
    btcCandles3m: BuiltCandle[],
    btcAggTrades: RawAggTradeEvent[],
    futuresContext: ScoutFuturesContext,
    zones: SrZone[],
    nowMs: number,
  ): FeatureVector;
}

function sma(values: number[], period: number): number {
  if (values.length < period) return 0;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function ema(values: number[], period: number): number {
  if (values.length === 0) return 0;
  const k = 2 / (period + 1);
  let result = values[0];
  for (let i = 1; i < values.length; i++) {
    result = values[i] * k + result * (1 - k);
  }
  return result;
}

function rsi(closes: number[], period: number): number {
  if (closes.length < period + 1) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

function calcAtr(candles: BuiltCandle[], period: number): number {
  if (candles.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1];
    const cur = candles[i];
    trs.push(
      Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close)),
    );
  }
  return sma(trs, period);
}

function calcRealizedVol(candles: BuiltCandle[]): number {
  if (candles.length < 2) return 0;
  const returns: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    if (candles[i - 1].close > 0) {
      returns.push(Math.log(candles[i].close / candles[i - 1].close));
    }
  }
  if (returns.length === 0) return 0;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance);
}

function takerBuyRatio(trades: RawAggTradeEvent[], windowMs: number, nowMs: number): number {
  const cutoff = nowMs - windowMs;
  const recent = trades.filter((t) => t.receivedAtMs >= cutoff);
  if (recent.length === 0) return 0.5;
  const buyVol = recent
    .filter((t) => !t.isBuyerMaker)
    .reduce((s, t) => s + t.quantity * t.price, 0);
  const totalVol = recent.reduce((s, t) => s + t.quantity * t.price, 0);
  return totalVol > 0 ? buyVol / totalVol : 0.5;
}

function buildLevelGeometry(
  event: LevelCandidateEvent,
  currentCandle3m: BuiltCandle | undefined,
  currentPrice: number,
  atr: number,
  zones: SrZone[],
): LevelGeometryFeatures {
  const zone = event.zone;
  const tickSize = 0.001;
  const distanceTicks = Math.abs(currentPrice - (zone.high + zone.low) / 2) / tickSize;
  const distanceAtr = atr > 0 ? Math.abs(currentPrice - (zone.high + zone.low) / 2) / atr : 0;

  const opposing = zones.find(
    (z) => z.id !== zone.id && z.side !== zone.side && !z.broken && z.touchCount >= 2,
  );

  const bodyWickRatio = currentCandle3m
    ? currentCandle3m.high - currentCandle3m.low > 0
      ? Math.abs(currentCandle3m.close - currentCandle3m.open) /
        (currentCandle3m.high - currentCandle3m.low)
      : 0.5
    : 0.5;

  const closeLocation = currentCandle3m
    ? currentCandle3m.high > currentCandle3m.low
      ? (currentCandle3m.close - currentCandle3m.low) / (currentCandle3m.high - currentCandle3m.low)
      : 0.5
    : 0.5;

  return {
    side: zone.side === 'SUPPORT' ? 'LONG' : 'SHORT',
    zoneHigh: zone.high,
    zoneLow: zone.low,
    zoneWidthTicks: (zone.high - zone.low) / tickSize,
    zoneScore: zone.score,
    touchCount: zone.touchCount,
    ageMs: event.timestamp - zone.firstTouchMs,
    timeSinceLastTouchMs: event.timestamp - zone.lastTouchMs,
    distanceTicks,
    distanceAtr,
    bodyWickRatio,
    closeLocation,
    compressionBefore: null,
    reclaimBeyond: currentCandle3m
      ? zone.side === 'SUPPORT'
        ? currentCandle3m.low <= zone.low && currentCandle3m.close >= zone.high
        : currentCandle3m.high >= zone.high && currentCandle3m.close <= zone.low
      : null,
    roomToTargetTicks: opposing
      ? Math.abs((opposing.low + opposing.high) / 2 - currentPrice) / tickSize
      : 100,
    roomToOpposingTicks: opposing
      ? Math.abs((opposing.low + opposing.high) / 2 - currentPrice) / tickSize
      : 100,
  };
}

function buildPriceVolatility(
  candles1m: BuiltCandle[],
  candles3m: BuiltCandle[],
): PriceVolatilityFeatures {
  const closes1m = candles1m.map((c) => c.close);
  const closes3m = candles3m.map((c) => c.close);

  const return1m =
    closes1m.length >= 2 && closes1m[closes1m.length - 2] > 0
      ? closes1m[closes1m.length - 1] / closes1m[closes1m.length - 2] - 1
      : 0;
  const return3m =
    closes3m.length >= 2 && closes3m[closes3m.length - 2] > 0
      ? closes3m[closes3m.length - 1] / closes3m[closes3m.length - 2] - 1
      : 0;
  const return5m =
    closes3m.length >= 3 && closes3m[closes3m.length - 3] > 0
      ? closes3m[closes3m.length - 1] / closes3m[closes3m.length - 3] - 1
      : 0;

  const atr = calcAtr(candles3m, 14);
  const ema20 = ema(closes3m, 20);
  const ema20Prev = closes3m.length > 20 ? ema(closes3m.slice(0, -1), 20) : ema20;

  const vols = candles3m.map((c) => c.volume);
  const medianVol = sma(vols, Math.min(vols.length, 20));

  return {
    return1m,
    return3m,
    return5m,
    realizedVol: calcRealizedVol(candles1m.slice(-60)),
    atr14_3m: atr,
    rangePercentile: 0.5,
    emaSlope: ema20 > 0 ? (ema20 - ema20Prev) / ema20 : 0,
    emaDistance: ema20 > 0 ? (closes1m[closes1m.length - 1] - ema20) / ema20 : 0,
    rsi14: rsi(closes1m, 14),
    volumeRelativeMedian: medianVol > 0 ? vols[vols.length - 1] / medianVol : 1,
    volumeAcceleration: 0,
    candleSequence: 0,
    higherHighLowerLow: 0,
    momentumAcceleration: 0,
  };
}

function buildOrderFlow(trades: RawAggTradeEvent[], nowMs: number): OrderFlowFeatures {
  return {
    takerBuyRatio5s: takerBuyRatio(trades, 5000, nowMs),
    takerBuyRatio30s: takerBuyRatio(trades, 30000, nowMs),
    takerBuyRatio1m: takerBuyRatio(trades, 60000, nowMs),
    takerBuyRatio3m: takerBuyRatio(trades, 180000, nowMs),
    signedNotional1m: 0,
    tradeIntensity1m: trades.filter((t) => t.receivedAtMs >= nowMs - 60000).length,
    consecutiveAggressiveFlow: 0,
  };
}

function buildBookFeatures(bids: RawDepthEvent[], asks: RawDepthEvent[]): BookFeatures {
  const lastBid = bids[bids.length - 1];
  const lastAsk = asks[asks.length - 1];
  if (!lastBid || !lastAsk) {
    return {
      spreadBps: 0,
      topBookImbalance: 0.5,
      multiLevelImbalance: 0.5,
      imbalanceChange: 0,
      bestBidDepletion: 0,
      bestAskDepletion: 0,
      visibleAbsorptionAtZone: 0,
    };
  }

  const bestBid = lastBid.bids[0]?.[0] ?? 0;
  const bestAsk = lastAsk.asks[0]?.[0] ?? 0;
  const bidQty = lastBid.bids[0]?.[1] ?? 0;
  const askQty = lastAsk.asks[0]?.[1] ?? 0;
  const totalQty = bidQty + askQty;

  return {
    spreadBps: bestBid > 0 && bestAsk > 0 ? ((bestAsk - bestBid) / bestBid) * 10000 : 0,
    topBookImbalance: totalQty > 0 ? bidQty / totalQty : 0.5,
    multiLevelImbalance: 0.5,
    imbalanceChange: 0,
    bestBidDepletion: 0,
    bestAskDepletion: 0,
    visibleAbsorptionAtZone: 0,
  };
}

function buildBtcContext(
  btc1m: BuiltCandle[],
  btc3m: BuiltCandle[],
  btcTrades: RawAggTradeEvent[],
  nowMs: number,
  proposedSide: 'LONG' | 'SHORT' | null,
): BtcContextFeatures {
  const closes = btc1m.map((c) => c.close);
  const return1m =
    closes.length >= 2 && closes[closes.length - 2] > 0
      ? closes[closes.length - 1] / closes[closes.length - 2] - 1
      : 0;
  const return3m =
    btc3m.length >= 2 && btc3m[btc3m.length - 2].close > 0
      ? btc3m[btc3m.length - 1].close / btc3m[btc3m.length - 2].close - 1
      : 0;

  const recentTrades = btcTrades.filter((t) => t.receivedAtMs >= nowMs - 30000);
  const buyVol = recentTrades
    .filter((t) => !t.isBuyerMaker)
    .reduce((s, t) => s + t.quantity * t.price, 0);
  const totalVol = recentTrades.reduce((s, t) => s + t.quantity * t.price, 0);
  const takerImbalance = totalVol > 0 ? buyVol / totalVol : 0.5;

  const rangeExpansion =
    btc1m.length >= 10
      ? (btc1m[btc1m.length - 1].high - btc1m[btc1m.length - 1].low) /
        (btc1m.slice(-10).reduce((s, c) => s + (c.high - c.low), 0) / 10 || 1)
      : 1;

  let aggressiveAgainstTrade = false;
  if (proposedSide === 'LONG') {
    aggressiveAgainstTrade = return1m < -0.001 && takerImbalance < 0.4 && rangeExpansion > 1.2;
  } else if (proposedSide === 'SHORT') {
    aggressiveAgainstTrade = return1m > 0.001 && takerImbalance > 0.6 && rangeExpansion > 1.2;
  }

  return {
    return1m,
    return3m,
    realizedVol: calcRealizedVol(btc1m.slice(-60)),
    takerImbalance,
    rangeExpansion,
    directionRelative: proposedSide === 'LONG' ? return1m : -return1m,
    aggressiveAgainstTrade,
    timestamp: nowMs,
  };
}

export function createFeatureVectorBuilder(): FeatureVectorBuilder {
  return {
    build(
      event,
      candles1m,
      candles3m,
      aggTrades,
      depthBids,
      depthAsks,
      btcCandles1m,
      btcCandles3m,
      btcAggTrades,
      futuresContext,
      zones,
      nowMs,
    ): FeatureVector {
      const currentPrice = event.priceAtEvent;
      const atr = calcAtr(candles3m, 14);
      const currentCandle3m = candles3m[candles3m.length - 1];
      const proposedSide = event.zone.side === 'SUPPORT' ? 'LONG' : 'SHORT';
      const unavailableFeatures: FeatureUnavailableReason[] = [];
      const ranges = candles3m.map((c) => c.high - c.low);
      const compressionBefore =
        ranges.length >= 20
          ? sma(ranges.slice(-5), 5) / Math.max(sma(ranges.slice(-20), 20), Number.EPSILON)
          : null;
      if (compressionBefore === null)
        unavailableFeatures.push({
          feature: 'compressionBefore',
          reason: 'MISSING',
          observedAtMs: null,
        });
      for (const unavailable of futuresContext.unavailable) {
        unavailableFeatures.push({
          feature: unavailable,
          reason: unavailable.includes('unsupported') ? 'UNSUPPORTED' : 'MISSING',
          observedAtMs: unavailable.includes('funding')
            ? futuresContext.fundingObservedAtMs
            : futuresContext.markPriceObservedAtMs,
        });
      }
      if (
        futuresContext.fundingObservedAtMs !== null &&
        nowMs - futuresContext.fundingObservedAtMs > 60 * 60_000
      ) {
        unavailableFeatures.push({
          feature: 'fundingRate',
          reason: 'STALE',
          observedAtMs: futuresContext.fundingObservedAtMs,
        });
      }

      return {
        schemaVersion: FEATURE_SCHEMA_VERSION,
        symbol: 'SUIUSDT',
        timestamp: nowMs,
        level: {
          ...buildLevelGeometry(event, currentCandle3m, currentPrice, atr, zones),
          compressionBefore,
        },
        price: buildPriceVolatility(candles1m, candles3m),
        flow: buildOrderFlow(aggTrades, nowMs),
        book: buildBookFeatures(depthBids, depthAsks),
        futures: {
          fundingRate: futuresContext.fundingRate,
          fundingTimestamp: futuresContext.fundingObservedAtMs,
          openInterestChange3m: null,
          openInterestTimestamp: null,
          basisPct: null,
          basisTimestamp: null,
        },
        btcContext: buildBtcContext(btcCandles1m, btcCandles3m, btcAggTrades, nowMs, proposedSide),
        unavailableFeatures,
      };
    },
  };
}
