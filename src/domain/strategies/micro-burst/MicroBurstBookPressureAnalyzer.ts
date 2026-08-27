import {
  BookDataStatus,
  BookPressureSignal,
  OrderBookDepthLevel,
  OrderBookSnapshot,
} from './MicroBurstTypes';
import { priceDistanceToBps } from './MicroBurstUnits';

interface BookPressureOptions {
  anomalySpreadBps: number;
  minImbalance: number;
  freshnessMaxMs: number;
}

const DEFAULT_OPTIONS: BookPressureOptions = {
  anomalySpreadBps: 20,
  minImbalance: 0.2,
  freshnessMaxMs: 30_000,
};

function unavailableSignal(status: BookDataStatus): BookPressureSignal {
  return {
    spreadBps: Infinity,
    topOfBookImbalance: 0,
    imbalanceSlope: null,
    staticBidConcentration: false,
    staticAskConcentration: false,
    anomalyFlag: status === 'ANOMALOUS',
    status,
  };
}

function isFiniteLevel(level: OrderBookDepthLevel): boolean {
  return (
    Number.isFinite(level.price) &&
    level.price > 0 &&
    Number.isFinite(level.qty) &&
    level.qty >= 0
  );
}

function hasExpectedSorting(snapshot: OrderBookSnapshot): boolean {
  return (
    snapshot.bidDepth.every((level, index, levels) => index === 0 || levels[index - 1].price >= level.price) &&
    snapshot.askDepth.every((level, index, levels) => index === 0 || levels[index - 1].price <= level.price)
  );
}

export function validateOrderBookSnapshot(snapshot: OrderBookSnapshot): BookDataStatus {
  if (snapshot.status !== 'HEALTHY') return snapshot.status;
  if (
    snapshot.bidDepth.length === 0 ||
    snapshot.askDepth.length === 0 ||
    !snapshot.bidDepth.every(isFiniteLevel) ||
    !snapshot.askDepth.every(isFiniteLevel) ||
    !hasExpectedSorting(snapshot)
  ) {
    return 'UNSYNCED';
  }
  const bestBid = snapshot.bidDepth[0].price;
  const bestAsk = snapshot.askDepth[0].price;
  return bestBid < bestAsk ? 'HEALTHY' : 'UNSYNCED';
}

function totalQty(levels: OrderBookDepthLevel[], count: number): number {
  return levels.slice(0, count).reduce((sum, level) => sum + level.qty, 0);
}

export function analyzeBookPressure(
  snapshot: OrderBookSnapshot | undefined,
  snapshotAtMs: number,
  options?: Partial<BookPressureOptions>,
): BookPressureSignal {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  if (!snapshot) return unavailableSignal('UNAVAILABLE');

  const baseStatus = validateOrderBookSnapshot(snapshot);
  if (baseStatus !== 'HEALTHY') return unavailableSignal(baseStatus);
  const ageMs = snapshotAtMs - snapshot.observedAtMs;
  if (!Number.isFinite(ageMs) || ageMs < 0) return unavailableSignal('UNSYNCED');
  if (ageMs > opts.freshnessMaxMs) return unavailableSignal('STALE');

  const bestBid = snapshot.bidDepth[0].price;
  const bestAsk = snapshot.askDepth[0].price;
  const spreadBps = priceDistanceToBps(bestBid, bestAsk);
  const bidTop5 = totalQty(snapshot.bidDepth, 5);
  const askTop5 = totalQty(snapshot.askDepth, 5);
  const totalDepth = bidTop5 + askTop5;
  const topOfBookImbalance = totalDepth > 0 ? Math.abs(bidTop5 - askTop5) / totalDepth : 0;
  const status: BookDataStatus =
    spreadBps > opts.anomalySpreadBps || topOfBookImbalance > opts.minImbalance
      ? 'ANOMALOUS'
      : 'HEALTHY';

  return {
    spreadBps,
    topOfBookImbalance,
    imbalanceSlope: null,
    staticBidConcentration: snapshot.bidDepth[0].qty / (bidTop5 || 1) > 0.5,
    staticAskConcentration: snapshot.askDepth[0].qty / (askTop5 || 1) > 0.5,
    anomalyFlag: status === 'ANOMALOUS',
    status,
  };
}

export function isBookHealthy(signal: BookPressureSignal): boolean {
  return signal.status === 'HEALTHY' && !signal.anomalyFlag;
}
