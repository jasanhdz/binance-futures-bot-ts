import { Candle } from '../../types';
import {
  NearestLevels,
  SupportResistanceLevel,
  SupportResistanceResult,
  StructuralPosition,
} from './MicroBurstTypes';

interface SROptions {
  lookbackBars: number;
  pivotLeftBars: number;
  pivotRightBars: number;
  clusterToleranceBps: number;
  minStrength: number;
  nearLevelThresholdBps: number;
}

const DEFAULT_OPTIONS: SROptions = {
  lookbackBars: 20,
  pivotLeftBars: 3,
  pivotRightBars: 3,
  clusterToleranceBps: 15,
  minStrength: 0.3,
  nearLevelThresholdBps: 50,
};

function toBps(a: number, b: number): number {
  return (Math.abs(a - b) / Math.min(Math.abs(a), Math.abs(b))) * 10_000;
}

function findSwingHighs(
  candles: Candle[],
  leftBars: number,
  rightBars: number,
): Array<{ price: number; pivotIndex: number; availableAtCandleIndex: number }> {
  const results: Array<{ price: number; pivotIndex: number; availableAtCandleIndex: number }> = [];
  for (let i = leftBars; i < candles.length - rightBars; i++) {
    let isSwingHigh = true;
    for (let j = 1; j <= leftBars; j++) {
      if (candles[i - j].high >= candles[i].high) {
        isSwingHigh = false;
        break;
      }
    }
    if (!isSwingHigh) continue;
    for (let j = 1; j <= rightBars; j++) {
      if (candles[i + j].high >= candles[i].high) {
        isSwingHigh = false;
        break;
      }
    }
    if (isSwingHigh) {
      results.push({
        price: candles[i].high,
        pivotIndex: i,
        availableAtCandleIndex: i + rightBars,
      });
    }
  }
  return results;
}

function findSwingLows(
  candles: Candle[],
  leftBars: number,
  rightBars: number,
): Array<{ price: number; pivotIndex: number; availableAtCandleIndex: number }> {
  const results: Array<{ price: number; pivotIndex: number; availableAtCandleIndex: number }> = [];
  for (let i = leftBars; i < candles.length - rightBars; i++) {
    let isSwingLow = true;
    for (let j = 1; j <= leftBars; j++) {
      if (candles[i - j].low <= candles[i].low) {
        isSwingLow = false;
        break;
      }
    }
    if (!isSwingLow) continue;
    for (let j = 1; j <= rightBars; j++) {
      if (candles[i + j].low <= candles[i].low) {
        isSwingLow = false;
        break;
      }
    }
    if (isSwingLow) {
      results.push({
        price: candles[i].low,
        pivotIndex: i,
        availableAtCandleIndex: i + rightBars,
      });
    }
  }
  return results;
}

function countTouches(candles: Candle[], level: number, toleranceBps: number): number {
  let touches = 0;
  for (const c of candles) {
    const highBps = toBps(c.high, level);
    const lowBps = toBps(c.low, level);
    if (highBps <= toleranceBps || lowBps <= toleranceBps) touches++;
  }
  return touches;
}

function volumeAtLevel(candles: Candle[], level: number, toleranceBps: number): number {
  let total = 0;
  for (const c of candles) {
    if (toBps(c.high, level) <= toleranceBps || toBps(c.low, level) <= toleranceBps) {
      total += c.volume;
    }
  }
  return total;
}

interface PivotWithMeta {
  price: number;
  pivotIndex: number;
  availableAtCandleIndex: number;
}

function clusterPivots(
  pivots: PivotWithMeta[],
  type: 'support' | 'resistance',
  candles: Candle[],
  toleranceBps: number,
  minStrength: number,
): SupportResistanceLevel[] {
  if (pivots.length === 0) return [];

  const sorted = [...pivots].sort((a, b) => a.price - b.price);
  const clusters: PivotWithMeta[][] = [[sorted[0]]];

  for (let i = 1; i < sorted.length; i++) {
    const currentCluster = clusters[clusters.length - 1];
    const clusterAvg = currentCluster.reduce((s, v) => s + v.price, 0) / currentCluster.length;
    if (toBps(sorted[i].price, clusterAvg) <= toleranceBps) {
      currentCluster.push(sorted[i]);
    } else {
      clusters.push([sorted[i]]);
    }
  }

  return clusters
    .map((cluster) => {
      const avgPrice = cluster.reduce((s, v) => s + v.price, 0) / cluster.length;
      const touches = countTouches(candles, avgPrice, toleranceBps);
      const vol = volumeAtLevel(candles, avgPrice, toleranceBps);
      const strength = Math.min(
        1,
        (touches / 5) * 0.5 + (cluster.length / 3) * 0.3 + (vol > 0 ? 0.2 : 0),
      );
      const lastTouchIdx = findLastTouchIndex(candles, avgPrice, toleranceBps);
      const availableAt = Math.max(...cluster.map((p) => p.availableAtCandleIndex));
      return {
        price: avgPrice,
        type,
        strength,
        touches,
        lastTouchIndex: lastTouchIdx,
        availableAtCandleIndex: availableAt,
        volumeAtLevel: vol,
      };
    })
    .filter((l) => l.strength >= minStrength);
}

function findLastTouchIndex(candles: Candle[], level: number, toleranceBps: number): number {
  for (let i = candles.length - 1; i >= 0; i--) {
    const c = candles[i];
    if (toBps(c.high, level) <= toleranceBps || toBps(c.low, level) <= toleranceBps) return i;
  }
  return -1;
}

function findNearest(
  price: number,
  levels: SupportResistanceLevel[],
  nearLevelThresholdBps: number,
): NearestLevels {
  let nearestSupport: SupportResistanceLevel | null = null;
  let nearestResistance: SupportResistanceLevel | null = null;
  let minSupportDist = Infinity;
  let minResistanceDist = Infinity;

  for (const level of levels) {
    const dist = Math.abs(price - level.price);
    if (level.type === 'support' && level.price < price && dist < minSupportDist) {
      minSupportDist = dist;
      nearestSupport = level;
    } else if (level.type === 'resistance' && level.price > price && dist < minResistanceDist) {
      minResistanceDist = dist;
      nearestResistance = level;
    }
  }

  const distToSupport = nearestSupport ? toBps(price, nearestSupport.price) : Infinity;
  const distToResistance = nearestResistance ? toBps(price, nearestResistance.price) : Infinity;
  const corridorWidth =
    nearestSupport && nearestResistance
      ? toBps(nearestResistance.price, nearestSupport.price)
      : Infinity;

  let structuralPosition: StructuralPosition = 'mid_range';
  if (distToSupport <= nearLevelThresholdBps) structuralPosition = 'near_support';
  else if (distToResistance <= nearLevelThresholdBps) structuralPosition = 'near_resistance';

  return {
    support: nearestSupport,
    resistance: nearestResistance,
    distanceToSupportBps: distToSupport,
    distanceToResistanceBps: distToResistance,
    corridorWidthBps: corridorWidth,
    structuralPosition,
  };
}

export function detectSupportResistance(
  candles: Candle[],
  options?: Partial<SROptions>,
): SupportResistanceResult {
  const opts = { ...DEFAULT_OPTIONS, ...options };

  const sliced = candles.slice(-opts.lookbackBars);

  const swingHighs = findSwingHighs(sliced, opts.pivotLeftBars, opts.pivotRightBars);
  const swingLows = findSwingLows(sliced, opts.pivotLeftBars, opts.pivotRightBars);

  const resistanceLevels = clusterPivots(
    swingHighs,
    'resistance',
    sliced,
    opts.clusterToleranceBps,
    opts.minStrength,
  );
  const supportLevels = clusterPivots(
    swingLows,
    'support',
    sliced,
    opts.clusterToleranceBps,
    opts.minStrength,
  );

  const allLevels = [...supportLevels, ...resistanceLevels];
  const currentPrice = sliced[sliced.length - 1]?.close ?? 0;
  const nearest = findNearest(currentPrice, allLevels, opts.nearLevelThresholdBps);

  return { levels: allLevels, nearest };
}
