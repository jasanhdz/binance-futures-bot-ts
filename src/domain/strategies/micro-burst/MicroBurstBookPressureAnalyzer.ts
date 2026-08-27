import { Side } from '../../types';
import { BookDataStatus, BookPressureSignal } from './MicroBurstTypes';

interface DepthLevel {
  price: number;
  qty: number;
}

interface DepthSnapshot {
  bidDepth: DepthLevel[];
  askDepth: DepthLevel[];
}

interface BookPressureOptions {
  anomalySpreadBps: number;
  minImbalance: number;
}

const DEFAULT_OPTIONS: BookPressureOptions = {
  anomalySpreadBps: 20,
  minImbalance: 0.2,
};

function medianPrice(levels: DepthLevel[], count: number): number {
  const sorted = [...levels].sort((a, b) => b.qty - a.qty);
  const top = sorted.slice(0, count);
  if (top.length === 0) return 0;
  return top.reduce((s, l) => s + l.price, 0) / top.length;
}

function totalQty(levels: DepthLevel[], count: number): number {
  return [...levels]
    .sort((a, b) => b.price - a.price)
    .slice(0, count)
    .reduce((s, l) => s + l.qty, 0);
}

function toBps(a: number, b: number): number {
  if (b === 0) return Infinity;
  return (Math.abs(a - b) / Math.min(Math.abs(a), Math.abs(b))) * 10_000;
}

export function analyzeBookPressure(
  depth: DepthSnapshot | undefined,
  bookStatus: BookDataStatus,
  options?: Partial<BookPressureOptions>,
): BookPressureSignal {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  if (!depth || depth.bidDepth.length === 0 || depth.askDepth.length === 0) {
    return {
      spreadBps: Infinity,
      topOfBookImbalance: 0,
      imbalanceSlope: null,
      staticBidConcentration: false,
      staticAskConcentration: false,
      anomalyFlag: true,
      status: bookStatus,
    };
  }

  const bestBid = depth.bidDepth[0].price;
  const bestAsk = depth.askDepth[0].price;
  const mid = (bestBid + bestAsk) / 2;
  const spreadBps = toBps(bestAsk, bestBid);

  const bidTop5 = totalQty(depth.bidDepth, 5);
  const askTop5 = totalQty(depth.askDepth, 5);
  const totalDepth = bidTop5 + askTop5;
  const topOfBookImbalance = totalDepth > 0 ? Math.abs(bidTop5 - askTop5) / totalDepth : 0;

  const anomalyFlag = spreadBps > opts.anomalySpreadBps || topOfBookImbalance > opts.minImbalance;

  const bidConcentration = depth.bidDepth.length > 0 ? depth.bidDepth[0].qty / (bidTop5 || 1) : 0;
  const askConcentration = depth.askDepth.length > 0 ? depth.askDepth[0].qty / (askTop5 || 1) : 0;

  const bidDistToMid = mid > 0 ? toBps(mid, bestBid) : Infinity;
  const askDistToMid = mid > 0 ? toBps(bestAsk, mid) : Infinity;
  const bidDepthGap =
    depth.bidDepth.length >= 2 ? toBps(depth.bidDepth[0].price, depth.bidDepth[1].price) : Infinity;
  const askDepthGap =
    depth.askDepth.length >= 2 ? toBps(depth.askDepth[0].price, depth.askDepth[1].price) : Infinity;

  const staticBidConcentration = bidConcentration > 0.5 || bidDistToMid < 5;
  const staticAskConcentration = askConcentration > 0.5 || askDistToMid < 5;

  return {
    spreadBps,
    topOfBookImbalance,
    imbalanceSlope: null,
    staticBidConcentration,
    staticAskConcentration,
    anomalyFlag,
    status: bookStatus,
  };
}

export function isBookHealthy(signal: BookPressureSignal): boolean {
  if (signal.status !== 'HEALTHY') return false;
  if (signal.anomalyFlag) return false;
  return true;
}
