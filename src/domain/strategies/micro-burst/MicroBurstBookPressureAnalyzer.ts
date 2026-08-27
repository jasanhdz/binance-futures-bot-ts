import { Side } from '../../types';
import { BookPressureSignal } from './MicroBurstTypes';

interface DepthLevel {
  price: number;
  qty: number;
}

interface DepthSnapshot {
  bidDepth: DepthLevel[];
  askDepth: DepthLevel[];
}

interface BookPressureConfig {
  anomalySpreadBps: number;
  minImbalance: number;
}

const DEFAULT_CONFIG: BookPressureConfig = {
  anomalySpreadBps: 20,
  minImbalance: 0.2,
};

function toBps(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return Math.abs(a - b) / Math.min(Math.abs(a), Math.abs(b)) * 10_000;
}

function computeSpreadBps(bids: DepthLevel[], asks: DepthLevel[]): number {
  if (bids.length === 0 || asks.length === 0) return Infinity;
  const bestBid = bids[0].price;
  const bestAsk = asks[0].price;
  return toBps(bestAsk, bestBid);
}

function computeImbalance(bids: DepthLevel[], asks: DepthLevel[]): number {
  const topBidQty = bids.slice(0, 5).reduce((s, l) => s + l.qty, 0);
  const topAskQty = asks.slice(0, 5).reduce((s, l) => s + l.qty, 0);
  const total = topBidQty + topAskQty;
  if (total === 0) return 0;
  return (topBidQty - topAskQty) / total;
}

function detectAbsorption(bids: DepthLevel[], asks: DepthLevel[], side: Side): boolean {
  if (side === 'LONG') {
    const topBid = bids[0];
    if (!topBid) return false;
    const avgBidQty = bids.slice(0, 5).reduce((s, l) => s + l.qty, 0) / Math.min(5, bids.length);
    return topBid.qty > avgBidQty * 2.5;
  } else {
    const topAsk = asks[0];
    if (!topAsk) return false;
    const avgAskQty = asks.slice(0, 5).reduce((s, l) => s + l.qty, 0) / Math.min(5, asks.length);
    return topAsk.qty > avgAskQty * 2.5;
  }
}

function detectSweep(bids: DepthLevel[], asks: DepthLevel[], side: Side): boolean {
  if (side === 'LONG') {
    if (asks.length < 3) return false;
    const topAskQty = asks[0].qty;
    const nextAskQty = asks[1].qty;
    return topAskQty > 0 && nextAskQty > 0 && nextAskQty / topAskQty > 3;
  } else {
    if (bids.length < 3) return false;
    const topBidQty = bids[0].qty;
    const nextBidQty = bids[1].qty;
    return topBidQty > 0 && nextBidQty > 0 && nextBidQty / topBidQty > 3;
  }
}

function detectAnomaly(spreadBps: number, config: BookPressureConfig): boolean {
  return spreadBps > config.anomalySpreadBps;
}

export function analyzeBookPressure(
  depth: DepthSnapshot | undefined,
  side: Side,
  config?: Partial<BookPressureConfig>,
): BookPressureSignal {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  if (!depth || depth.bidDepth.length === 0 || depth.askDepth.length === 0) {
    return {
      spreadBps: Infinity,
      topOfBookImbalance: 0,
      imbalanceSlope: 0,
      absorptionDetected: false,
      sweepDetected: false,
      anomalyFlag: true,
      degradedMode: true,
    };
  }

  const spreadBps = computeSpreadBps(depth.bidDepth, depth.askDepth);
  const imbalance = computeImbalance(depth.bidDepth, depth.askDepth);
  const absorption = detectAbsorption(depth.bidDepth, depth.askDepth, side);
  const sweep = detectSweep(depth.bidDepth, depth.askDepth, side);
  const anomaly = detectAnomaly(spreadBps, cfg) || Math.abs(imbalance) > 0.7;

  return {
    spreadBps,
    topOfBookImbalance: imbalance,
    imbalanceSlope: 0,
    absorptionDetected: absorption,
    sweepDetected: sweep,
    anomalyFlag: anomaly,
    degradedMode: false,
  };
}

export function isBookHealthy(signal: BookPressureSignal, side: Side): boolean {
  if (signal.degradedMode) return true;
  if (signal.anomalyFlag) return false;
  if (signal.sweepDetected) return false;

  if (side === 'LONG' && signal.topOfBookImbalance < -0.5) return false;
  if (side === 'SHORT' && signal.topOfBookImbalance > 0.5) return false;

  return true;
}
