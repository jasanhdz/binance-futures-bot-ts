import type {
  CandleSeriesSnapshot,
  OrderBookHealth,
  OrderBookState,
  QuoteSnapshot,
} from '../../app/ports/MarketData';

export const SHARED_MARKET_FEATURES_V1 = 'SHARED_MARKET_FEATURES_V1' as const;
export const SHARED_MARKET_FEATURES_SCHEMA_VERSION = 1 as const;

export type NeutralFeatureHealth =
  | 'HEALTHY'
  | 'STALE'
  | 'UNSYNCED'
  | 'UNAVAILABLE'
  | 'ANOMALOUS'
  | 'GAPPED';

export interface QuoteFeaturesV1 {
  readonly schemaVersion: 1;
  readonly observedAtMs: number | null;
  readonly health: NeutralFeatureHealth;
  readonly spreadBps: number | null;
}

export interface OrderBookFeaturesV1 {
  readonly schemaVersion: 1;
  readonly observedAtMs: number | null;
  readonly health: NeutralFeatureHealth;
  readonly signedImbalanceTop5: number | null;
  readonly signedImbalanceTop10: number | null;
  readonly bidDepthTop5Levels: number | null;
  readonly askDepthTop5Levels: number | null;
  readonly bidDepthTop10Levels: number | null;
  readonly askDepthTop10Levels: number | null;
}

export interface AggTradeFlowInput {
  readonly buyVolume: number;
  readonly sellVolume: number;
  readonly netTakerVolume: number;
  readonly tradeCount: number;
  readonly requestedWindowMs: number;
  readonly observedWindowMs: number;
  readonly observedSampleCount: number;
  readonly eventWatermarkMs: number | null;
  readonly capacityTruncated: boolean;
  readonly coverageStartedAtMs: number | null;
  readonly windowComplete: boolean;
  readonly gapFree: boolean;
}

export interface AggTradeFeaturesV1 {
  readonly schemaVersion: 1;
  readonly observedAtMs: number | null;
  readonly health: NeutralFeatureHealth;
  readonly takerBuyVolume: number | null;
  readonly takerSellVolume: number | null;
  readonly netTakerVolume: number | null;
  readonly tradeCount: number | null;
  readonly observedWindowMs: number | null;
  readonly requestedWindowMs: number | null;
  readonly coverageRatio: number | null;
  readonly windowComplete: boolean;
  readonly gapFree: boolean;
  readonly capacityTruncated: boolean;
}

export interface CandleFeaturesV1 {
  readonly schemaVersion: 1;
  readonly observedAtMs: number | null;
  readonly exchangeSnapshotTimeMs: number | null;
  readonly health: NeutralFeatureHealth;
  readonly return1m: number | null;
  readonly return3m: number | null;
  readonly return5m: number | null;
}

export interface OrderBookFeatureInput {
  readonly state: OrderBookState;
  readonly health?: OrderBookHealth;
}

function emptyQuote(quote: QuoteSnapshot): QuoteFeaturesV1 {
  return Object.freeze({
    schemaVersion: SHARED_MARKET_FEATURES_SCHEMA_VERSION,
    observedAtMs: quote.observedAtMs,
    health: quote.health,
    spreadBps: null,
  });
}

export function calculateQuoteFeaturesV1(quote: QuoteSnapshot): QuoteFeaturesV1 {
  if (quote.health !== 'HEALTHY') return emptyQuote(quote);
  if (quote.spreadBps === null || !Number.isFinite(quote.spreadBps))
    return Object.freeze({
      schemaVersion: SHARED_MARKET_FEATURES_SCHEMA_VERSION,
      observedAtMs: quote.observedAtMs,
      health: 'ANOMALOUS' as const,
      spreadBps: null,
    });
  return Object.freeze({
    schemaVersion: SHARED_MARKET_FEATURES_SCHEMA_VERSION,
    observedAtMs: quote.observedAtMs,
    health: 'HEALTHY' as const,
    spreadBps: quote.spreadBps,
  });
}

function emptyBook(
  input: OrderBookFeatureInput,
  health: NeutralFeatureHealth,
): OrderBookFeaturesV1 {
  return Object.freeze({
    schemaVersion: SHARED_MARKET_FEATURES_SCHEMA_VERSION,
    observedAtMs: input.state.observedAtMs,
    health,
    signedImbalanceTop5: null,
    signedImbalanceTop10: null,
    bidDepthTop5Levels: null,
    askDepthTop5Levels: null,
    bidDepthTop10Levels: null,
    askDepthTop10Levels: null,
  });
}

function signedImbalance(bidQty: number, askQty: number): number | null {
  const total = bidQty + askQty;
  return total > 0 ? (bidQty - askQty) / total : null;
}

export function calculateOrderBookFeaturesV1(input: OrderBookFeatureInput): OrderBookFeaturesV1 {
  const health = input.health ?? input.state.health;
  if (health !== 'HEALTHY') return emptyBook(input, health);
  const bids = [...input.state.bids].sort((a, b) => b.price - a.price).slice(0, 10);
  const asks = [...input.state.asks].sort((a, b) => a.price - b.price).slice(0, 10);
  if (bids.length === 0 || asks.length === 0) return emptyBook(input, 'ANOMALOUS');
  if (
    [...bids, ...asks].some(
      (level) =>
        !Number.isFinite(level.price) ||
        level.price <= 0 ||
        !Number.isFinite(level.qty) ||
        level.qty < 0,
    )
  )
    return emptyBook(input, 'ANOMALOUS');

  const bidTop5Qty = bids.slice(0, 5).reduce((sum, level) => sum + level.qty, 0);
  const askTop5Qty = asks.slice(0, 5).reduce((sum, level) => sum + level.qty, 0);
  const bidTop10Qty = bids.reduce((sum, level) => sum + level.qty, 0);
  const askTop10Qty = asks.reduce((sum, level) => sum + level.qty, 0);
  const imbalanceTop5 = signedImbalance(bidTop5Qty, askTop5Qty);
  const imbalanceTop10 = signedImbalance(bidTop10Qty, askTop10Qty);
  if (imbalanceTop5 === null || imbalanceTop10 === null) return emptyBook(input, 'ANOMALOUS');

  return Object.freeze({
    schemaVersion: SHARED_MARKET_FEATURES_SCHEMA_VERSION,
    observedAtMs: input.state.observedAtMs,
    health: 'HEALTHY' as const,
    signedImbalanceTop5: imbalanceTop5,
    signedImbalanceTop10: imbalanceTop10,
    bidDepthTop5Levels: bids.slice(0, 5).length,
    askDepthTop5Levels: asks.slice(0, 5).length,
    bidDepthTop10Levels: bids.length,
    askDepthTop10Levels: asks.length,
  });
}

function emptyFlow(input: AggTradeFlowInput, health: NeutralFeatureHealth): AggTradeFeaturesV1 {
  return Object.freeze({
    schemaVersion: SHARED_MARKET_FEATURES_SCHEMA_VERSION,
    observedAtMs: input.eventWatermarkMs,
    health,
    takerBuyVolume: null,
    takerSellVolume: null,
    netTakerVolume: null,
    tradeCount: null,
    observedWindowMs: null,
    requestedWindowMs: null,
    coverageRatio: null,
    windowComplete: input.windowComplete,
    gapFree: input.gapFree,
    capacityTruncated: input.capacityTruncated,
  });
}

export function calculateAggTradeFeaturesV1(input: AggTradeFlowInput): AggTradeFeaturesV1 {
  if (!input.windowComplete || !input.gapFree || input.capacityTruncated)
    return emptyFlow(input, 'UNAVAILABLE');
  if (!Number.isFinite(input.requestedWindowMs) || input.requestedWindowMs <= 0)
    return emptyFlow(input, 'ANOMALOUS');
  const coverageRatio = Math.min(1, Math.max(0, input.observedWindowMs / input.requestedWindowMs));
  return Object.freeze({
    schemaVersion: SHARED_MARKET_FEATURES_SCHEMA_VERSION,
    observedAtMs: input.eventWatermarkMs,
    health: 'HEALTHY' as const,
    takerBuyVolume: input.buyVolume,
    takerSellVolume: input.sellVolume,
    netTakerVolume: input.netTakerVolume,
    tradeCount: input.tradeCount,
    observedWindowMs: input.observedWindowMs,
    requestedWindowMs: input.requestedWindowMs,
    coverageRatio,
    windowComplete: true,
    gapFree: true,
    capacityTruncated: false,
  });
}

function returnAtOrBefore(
  candles: CandleSeriesSnapshot['candles'],
  currentCloseTime: number,
  windowMs: number,
): number | null {
  let current: CandleSeriesSnapshot['candles'][number] | undefined;
  let target: CandleSeriesSnapshot['candles'][number] | undefined;
  for (let index = candles.length - 1; index >= 0; index--) {
    const candle = candles[index];
    if (!current && candle.closeTime === currentCloseTime) current = candle;
    if (!target && candle.closeTime <= currentCloseTime - windowMs) target = candle;
    if (current && target) break;
  }
  if (!current || !target || target.close === 0) return null;
  return (current.close - target.close) / target.close;
}

export function calculateCandleFeaturesV1(series: CandleSeriesSnapshot): CandleFeaturesV1 {
  const base = {
    schemaVersion: SHARED_MARKET_FEATURES_SCHEMA_VERSION,
    observedAtMs: series.observedAtMs,
    exchangeSnapshotTimeMs: series.exchangeSnapshotTimeMs,
  };
  if (series.health !== 'HEALTHY')
    return Object.freeze({
      ...base,
      health: series.health,
      return1m: null,
      return3m: null,
      return5m: null,
    });
  const closed = series.candles.filter(
    (candle) =>
      candle.status === 'CLOSED' &&
      (series.exchangeSnapshotTimeMs === null || candle.closeTime <= series.exchangeSnapshotTimeMs),
  );
  const latest = closed[closed.length - 1];
  if (!latest)
    return Object.freeze({
      ...base,
      health: 'UNAVAILABLE' as const,
      return1m: null,
      return3m: null,
      return5m: null,
    });
  return Object.freeze({
    ...base,
    health: 'HEALTHY' as const,
    return1m: returnAtOrBefore(closed, latest.closeTime, 60_000),
    return3m: returnAtOrBefore(closed, latest.closeTime, 180_000),
    return5m: returnAtOrBefore(closed, latest.closeTime, 300_000),
  });
}
