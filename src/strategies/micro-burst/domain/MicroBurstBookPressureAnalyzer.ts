import {
  BookDataStatus,
  BookPressureSignal,
  OrderBookDepthLevel,
  OrderBookSnapshot,
} from './MicroBurstTypes';
import type { TemporalOrderBookObservation as TemporalBookSnapshot } from '../../../app/ports/MarketData';
import { priceDistanceToBps } from './MicroBurstUnits';

interface BookPressureOptions {
  anomalySpreadBps: number;
  minImbalance: number;
  freshnessMaxMs: number;
  /** Minimum temporal observations needed to compute slope. */
  minTemporalObservations: number;
  /** Number of observations for slope calculation window. */
  slopeWindow: number;
}

const DEFAULT_OPTIONS: BookPressureOptions = {
  anomalySpreadBps: 20,
  minImbalance: 0.2,
  freshnessMaxMs: 30_000,
  minTemporalObservations: 3,
  slopeWindow: 5,
};

function unavailableSignal(status: BookDataStatus): BookPressureSignal {
  return {
    spreadBps: Infinity,
    signedTopOfBookImbalance: 0,
    topOfBookImbalance: 0,
    imbalanceSlope: null,
    temporalAbsorptionDetected: false,
    temporalSweepDetected: false,
    staticBidConcentration: false,
    staticAskConcentration: false,
    anomalyFlag: status === 'ANOMALOUS',
    status,
  };
}

function isFiniteLevel(level: OrderBookDepthLevel): boolean {
  return (
    Number.isFinite(level.price) && level.price > 0 && Number.isFinite(level.qty) && level.qty >= 0
  );
}

function hasExpectedSorting(snapshot: OrderBookSnapshot): boolean {
  return (
    snapshot.bidDepth.every(
      (level, index, levels) => index === 0 || levels[index - 1].price >= level.price,
    ) &&
    snapshot.askDepth.every(
      (level, index, levels) => index === 0 || levels[index - 1].price <= level.price,
    )
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

function computeLinearSlope(values: number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += i;
    sumY += values[i];
    sumXY += i * values[i];
    sumX2 += i * i;
  }
  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) return 0;
  return (n * sumXY - sumX * sumY) / denom;
}

function computeImbalanceSlope(
  temporalHistory: TemporalBookSnapshot[],
  windowSize: number,
): number | null {
  if (temporalHistory.length < 2) return null;
  const recent = temporalHistory.slice(-windowSize);
  if (recent.length < 2) return null;
  const imbalances = recent.map((s) => s.signedTopOfBookImbalance);
  return computeLinearSlope(imbalances);
}

function detectTemporalAbsorption(
  temporalHistory: TemporalBookSnapshot[],
  currentSnapshot: TemporalBookSnapshot,
): boolean {
  if (temporalHistory.length < 3) return false;

  const recent = temporalHistory.slice(-5);
  const prevAvgImbalance =
    recent.slice(0, -1).reduce((s, h) => s + h.topOfBookImbalance, 0) / (recent.length - 1);
  const currentImbalance = currentSnapshot.topOfBookImbalance;

  const bidQtyGrowth = currentSnapshot.bestBidQty / (recent[0]?.bestBidQty || 1);
  const askQtyGrowth = currentSnapshot.bestAskQty / (recent[0]?.bestAskQty || 1);

  return (
    currentImbalance > prevAvgImbalance * 1.5 &&
    (bidQtyGrowth > 2.0 || askQtyGrowth > 2.0) &&
    currentSnapshot.spreadBps < 10
  );
}

function detectTemporalSweep(
  temporalHistory: TemporalBookSnapshot[],
  currentSnapshot: TemporalBookSnapshot,
): boolean {
  if (temporalHistory.length < 3) return false;

  const recent = temporalHistory.slice(-5);
  const prevAvgImbalance =
    recent.slice(0, -1).reduce((s, h) => s + h.topOfBookImbalance, 0) / (recent.length - 1);
  const currentImbalance = currentSnapshot.topOfBookImbalance;

  const bidQtyDrop = currentSnapshot.bestBidQty / (recent[0]?.bestBidQty || 1);
  const askQtyDrop = currentSnapshot.bestAskQty / (recent[0]?.bestAskQty || 1);

  return (
    currentImbalance > prevAvgImbalance * 2.0 &&
    (bidQtyDrop < 0.3 || askQtyDrop < 0.3) &&
    currentSnapshot.spreadBps > 15
  );
}

export function analyzeBookPressure(
  snapshot: OrderBookSnapshot | undefined,
  snapshotAtMs: number,
  options?: Partial<BookPressureOptions>,
  temporalHistory?: TemporalBookSnapshot[],
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
  const signedTopOfBookImbalance = totalDepth > 0 ? (bidTop5 - askTop5) / totalDepth : 0;
  const topOfBookImbalance = Math.abs(signedTopOfBookImbalance);
  const status: BookDataStatus = spreadBps > opts.anomalySpreadBps ? 'ANOMALOUS' : 'HEALTHY';

  const currentTemporalSnapshot: TemporalBookSnapshot = {
    observedAtMs: snapshotAtMs,
    signedTopOfBookImbalance,
    topOfBookImbalance,
    bestBidQty: snapshot.bidDepth[0]?.qty ?? 0,
    bestAskQty: snapshot.askDepth[0]?.qty ?? 0,
    bidTop5Qty: bidTop5,
    askTop5Qty: askTop5,
    spreadBps,
  };

  let imbalanceSlope: number | null = null;
  let temporalAbsorptionDetected = false;
  let temporalSweepDetected = false;

  const causalHistory = (temporalHistory ?? [])
    .filter(
      (item) =>
        Number.isFinite(item.observedAtMs) &&
        item.observedAtMs < snapshot.observedAtMs &&
        item.observedAtMs <= snapshotAtMs,
    )
    .sort((a, b) => a.observedAtMs - b.observedAtMs);
  if (causalHistory.length >= opts.minTemporalObservations) {
    const combined = [...causalHistory, currentTemporalSnapshot];
    imbalanceSlope = computeImbalanceSlope(combined, opts.slopeWindow);
    temporalAbsorptionDetected = detectTemporalAbsorption(combined, currentTemporalSnapshot);
    temporalSweepDetected = detectTemporalSweep(combined, currentTemporalSnapshot);
  }

  return {
    spreadBps,
    signedTopOfBookImbalance,
    topOfBookImbalance,
    imbalanceSlope,
    temporalAbsorptionDetected,
    temporalSweepDetected,
    staticBidConcentration: snapshot.bidDepth[0].qty / (bidTop5 || 1) > 0.5,
    staticAskConcentration: snapshot.askDepth[0].qty / (askTop5 || 1) > 0.5,
    anomalyFlag: status === 'ANOMALOUS',
    status,
  };
}

export function isBookHealthy(signal: BookPressureSignal): boolean {
  return signal.status === 'HEALTHY' && !signal.anomalyFlag;
}
