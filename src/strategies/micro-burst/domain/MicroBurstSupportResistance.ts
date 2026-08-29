import { Candle } from '../../../core/types';
import {
  NearestLevels,
  SupportResistanceLevel,
  SupportResistanceResult,
  StructuralPosition,
} from './MicroBurstTypes';
import { priceDistanceToBps } from './MicroBurstUnits';

export interface SupportResistanceOptions {
  lookbackBars: number;
  pivotLeftBars: number;
  pivotRightBars: number;
  clusterToleranceBps: number;
  minStrength: number;
  nearLevelThresholdBps: number;
  snapshotAtMs?: number;
}

interface IndexedCandle {
  candle: Candle;
  sourceIndex: number;
}

interface PivotWithMeta {
  price: number;
  pivotCandleIndex: number;
  availableAtCandleIndex: number;
  pivotAtMs: number;
  availableAtMs: number;
}

const DEFAULT_OPTIONS: SupportResistanceOptions = {
  lookbackBars: 20,
  pivotLeftBars: 3,
  pivotRightBars: 3,
  clusterToleranceBps: 15,
  minStrength: 0.3,
  nearLevelThresholdBps: 50,
};

function findPivots(
  candles: IndexedCandle[],
  leftBars: number,
  rightBars: number,
  type: 'support' | 'resistance',
): PivotWithMeta[] {
  const pivots: PivotWithMeta[] = [];
  for (let i = leftBars; i < candles.length - rightBars; i++) {
    const pivot = candles[i].candle;
    const left = candles.slice(i - leftBars, i);
    const right = candles.slice(i + 1, i + rightBars + 1);
    const isPivot =
      type === 'resistance'
        ? left.every(({ candle }) => candle.high < pivot.high) &&
          right.every(({ candle }) => candle.high < pivot.high)
        : left.every(({ candle }) => candle.low > pivot.low) &&
          right.every(({ candle }) => candle.low > pivot.low);

    if (!isPivot) continue;
    const confirmation = candles[i + rightBars];
    pivots.push({
      price: type === 'resistance' ? pivot.high : pivot.low,
      pivotCandleIndex: candles[i].sourceIndex,
      availableAtCandleIndex: confirmation.sourceIndex,
      pivotAtMs: pivot.closeTime,
      availableAtMs: confirmation.candle.closeTime,
    });
  }
  return pivots;
}

function countTouches(candles: IndexedCandle[], level: number, toleranceBps: number): number {
  return candles.filter(
    ({ candle }) =>
      priceDistanceToBps(level, candle.high) <= toleranceBps ||
      priceDistanceToBps(level, candle.low) <= toleranceBps,
  ).length;
}

function volumeAtLevel(candles: IndexedCandle[], level: number, toleranceBps: number): number {
  return candles.reduce((total, { candle }) => {
    const touches =
      priceDistanceToBps(level, candle.high) <= toleranceBps ||
      priceDistanceToBps(level, candle.low) <= toleranceBps;
    return total + (touches ? candle.volume : 0);
  }, 0);
}

function findLastTouchIndex(candles: IndexedCandle[], level: number, toleranceBps: number): number {
  for (let i = candles.length - 1; i >= 0; i--) {
    const { candle, sourceIndex } = candles[i];
    if (
      priceDistanceToBps(level, candle.high) <= toleranceBps ||
      priceDistanceToBps(level, candle.low) <= toleranceBps
    ) {
      return sourceIndex;
    }
  }
  return -1;
}

function clusterPivots(
  pivots: PivotWithMeta[],
  type: 'support' | 'resistance',
  candles: IndexedCandle[],
  toleranceBps: number,
  minStrength: number,
): SupportResistanceLevel[] {
  if (pivots.length === 0) return [];
  const sorted = [...pivots].sort((a, b) => a.price - b.price);
  const clusters: PivotWithMeta[][] = [[sorted[0]]];

  for (const pivot of sorted.slice(1)) {
    const cluster = clusters[clusters.length - 1];
    const average = cluster.reduce((sum, item) => sum + item.price, 0) / cluster.length;
    if (priceDistanceToBps(pivot.price, average) <= toleranceBps) cluster.push(pivot);
    else clusters.push([pivot]);
  }

  return clusters
    .map((cluster): SupportResistanceLevel => {
      const price = cluster.reduce((sum, item) => sum + item.price, 0) / cluster.length;
      const touches = countTouches(candles, price, toleranceBps);
      const volume = volumeAtLevel(candles, price, toleranceBps);
      const strength = Math.min(
        1,
        (touches / 5) * 0.5 + (cluster.length / 3) * 0.3 + (volume > 0 ? 0.2 : 0),
      );
      const latestConfirmation = cluster.reduce((latest, item) =>
        item.availableAtMs > latest.availableAtMs ? item : latest,
      );
      return {
        price,
        type,
        strength,
        touches,
        lastTouchIndex: findLastTouchIndex(candles, price, toleranceBps),
        pivotCandleIndex: latestConfirmation.pivotCandleIndex,
        availableAtCandleIndex: latestConfirmation.availableAtCandleIndex,
        pivotAtMs: latestConfirmation.pivotAtMs,
        availableAtMs: latestConfirmation.availableAtMs,
        volumeAtLevel: volume,
      };
    })
    .filter((level) => level.strength >= minStrength);
}

function findNearest(
  price: number,
  levels: SupportResistanceLevel[],
  nearLevelThresholdBps: number,
): NearestLevels {
  const supports = levels.filter((level) => level.type === 'support' && level.price < price);
  const resistances = levels.filter((level) => level.type === 'resistance' && level.price > price);
  const support = supports.sort((a, b) => b.price - a.price)[0] ?? null;
  const resistance = resistances.sort((a, b) => a.price - b.price)[0] ?? null;
  const distanceToSupportBps = support ? priceDistanceToBps(price, support.price) : Infinity;
  const distanceToResistanceBps = resistance
    ? priceDistanceToBps(price, resistance.price)
    : Infinity;
  const corridorWidthBps =
    support && resistance ? priceDistanceToBps(support.price, resistance.price) : Infinity;

  let structuralPosition: StructuralPosition = 'mid_range';
  if (distanceToSupportBps <= nearLevelThresholdBps) structuralPosition = 'near_support';
  else if (distanceToResistanceBps <= nearLevelThresholdBps) structuralPosition = 'near_resistance';

  return {
    support,
    resistance,
    distanceToSupportBps,
    distanceToResistanceBps,
    corridorWidthBps,
    structuralPosition,
  };
}

export function detectSupportResistance(
  candles: Candle[],
  options?: Partial<SupportResistanceOptions>,
): SupportResistanceResult {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const deterministicSnapshotAtMs =
    opts.snapshotAtMs ?? candles.reduce((latest, candle) => Math.max(latest, candle.closeTime), 0);
  const availableCandles = candles
    .map((candle, sourceIndex) => ({ candle, sourceIndex }))
    .filter(({ candle }) => candle.closeTime <= deterministicSnapshotAtMs)
    .slice(-opts.lookbackBars);

  const resistance = findPivots(
    availableCandles,
    opts.pivotLeftBars,
    opts.pivotRightBars,
    'resistance',
  );
  const support = findPivots(availableCandles, opts.pivotLeftBars, opts.pivotRightBars, 'support');
  const levels = [
    ...clusterPivots(
      support,
      'support',
      availableCandles,
      opts.clusterToleranceBps,
      opts.minStrength,
    ),
    ...clusterPivots(
      resistance,
      'resistance',
      availableCandles,
      opts.clusterToleranceBps,
      opts.minStrength,
    ),
  ].filter((level) => level.availableAtMs <= deterministicSnapshotAtMs);
  const currentPrice = availableCandles[availableCandles.length - 1]?.candle.close ?? 0;

  return {
    levels,
    nearest: findNearest(currentPrice, levels, opts.nearLevelThresholdBps),
  };
}
