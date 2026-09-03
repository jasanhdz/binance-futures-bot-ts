import type { SrZone, LevelCandidateEvent, ScoutSymbol } from '../domain/ScoutTypes';
import type { BuiltCandle } from '../market/ThreeMinuteCandleBuilder';

let zoneIdCounter = 0;
function nextZoneId(): string {
  return `sr_${++zoneIdCounter}_${Date.now().toString(36)}`;
}

export interface LevelDetector {
  detectPivots(candles: BuiltCandle[]): { highs: number[]; lows: number[] };
  clusterZones(
    pivots: { highs: number[]; lows: number[] },
    atr: number,
    toleranceTicks: number,
  ): SrZone[];
  updateZones(zones: SrZone[], candle: BuiltCandle, atr: number, nowMs: number): SrZone[];
  findCandidateEvent(
    zones: SrZone[],
    currentPrice: number,
    atr: number,
    nowMs: number,
  ): LevelCandidateEvent | null;
  getActiveZones(zones: SrZone[], currentPrice: number, atr: number): SrZone[];
}

export function createLevelDetector(config: {
  srZoneAtrTolerance: number;
  srMinTouchCount: number;
  srZoneScoreMin: number;
  breakConfirmationCandles: number;
}): LevelDetector {
  const { srZoneAtrTolerance, srMinTouchCount, srZoneScoreMin, breakConfirmationCandles } = config;

  function detectPivots(candles: BuiltCandle[]): { highs: number[]; lows: number[] } {
    const highs: number[] = [];
    const lows: number[] = [];
    for (let i = 1; i < candles.length - 1; i++) {
      const prev = candles[i - 1];
      const cur = candles[i];
      const next = candles[i + 1];
      if (cur.high > prev.high && cur.high > next.high) {
        highs.push(cur.high);
      }
      if (cur.low < prev.low && cur.low < next.low) {
        lows.push(cur.low);
      }
    }
    return { highs, lows };
  }

  function clusterZones(
    pivots: { highs: number[]; lows: number[] },
    atr: number,
    toleranceTicks: number,
  ): SrZone[] {
    const tolerance = Math.max(2 * toleranceTicks, srZoneAtrTolerance * atr);
    const zones: SrZone[] = [];

    const clusterSide = (values: number[], side: 'SUPPORT' | 'RESISTANCE'): void => {
      const sorted = [...values].sort((a, b) => a - b);
      const clusters: number[][] = [];
      let current: number[] = [];

      for (const v of sorted) {
        if (current.length === 0 || v - current[0] <= tolerance) {
          current.push(v);
        } else {
          clusters.push(current);
          current = [v];
        }
      }
      if (current.length > 0) clusters.push(current);

      for (const cluster of clusters) {
        const avg = cluster.reduce((a, b) => a + b, 0) / cluster.length;
        const width = Math.max(...cluster) - Math.min(...cluster);
        zones.push({
          id: nextZoneId(),
          side,
          high: avg + width / 2,
          low: avg - width / 2,
          score: Math.min(1, cluster.length / 5),
          touchCount: cluster.length,
          firstTouchMs: Date.now(),
          lastTouchMs: Date.now(),
          lastCloseMs: Date.now(),
          avgRejectionMagnitude: 0,
          totalVolume: 0,
          broken: false,
          brokenAtMs: null,
        });
      }
    };

    clusterSide(pivots.lows, 'SUPPORT');
    clusterSide(pivots.highs, 'RESISTANCE');
    return zones;
  }

  function updateZones(zones: SrZone[], candle: BuiltCandle, atr: number, nowMs: number): SrZone[] {
    const tolerance = Math.max(2, srZoneAtrTolerance * atr);
    return zones.map((z) => {
      if (z.broken) return z;

      const touched = candle.low <= z.high + tolerance && candle.high >= z.low - tolerance;
      if (touched) {
        const rejectionMag = z.side === 'RESISTANCE' ? z.high - candle.low : candle.high - z.low;
        return {
          ...z,
          touchCount: z.touchCount + 1,
          lastTouchMs: nowMs,
          lastCloseMs: candle.closeTime,
          avgRejectionMagnitude:
            (z.avgRejectionMagnitude * (z.touchCount - 1) + rejectionMag) / z.touchCount,
          totalVolume: z.totalVolume + candle.volume,
          score: Math.min(1, (z.touchCount + 1) / 5),
        };
      }

      const brokenAbove =
        z.side === 'RESISTANCE' && candle.close > z.high + tolerance && candle.isClosed;
      const brokenBelow =
        z.side === 'SUPPORT' && candle.close < z.low - tolerance && candle.isClosed;

      if (brokenAbove || brokenBelow) {
        return { ...z, broken: true, brokenAtMs: nowMs };
      }

      return z;
    });
  }

  function findCandidateEvent(
    zones: SrZone[],
    currentPrice: number,
    atr: number,
    nowMs: number,
  ): LevelCandidateEvent | null {
    const tolerance = Math.max(2, srZoneAtrTolerance * atr);

    const sorted = [...zones]
      .filter((z) => !z.broken && z.touchCount >= srMinTouchCount && z.score >= srZoneScoreMin)
      .sort((a, b) => {
        const distA = Math.min(Math.abs(currentPrice - a.high), Math.abs(currentPrice - a.low));
        const distB = Math.min(Math.abs(currentPrice - b.high), Math.abs(currentPrice - b.low));
        return distA - distB;
      });

    for (const zone of sorted) {
      const distHigh = Math.abs(currentPrice - zone.high);
      const distLow = Math.abs(currentPrice - zone.low);
      const dist = Math.min(distHigh, distLow);

      if (dist > tolerance * 3) continue;

      const nearZone =
        currentPrice >= zone.low - tolerance && currentPrice <= zone.high + tolerance;

      if (nearZone) {
        const eventType = zone.side === 'RESISTANCE' ? 'TOUCH' : 'TOUCH';
        return {
          timestamp: nowMs,
          symbol: 'SUIUSDT',
          zone,
          eventType,
          priceAtEvent: currentPrice,
          atr,
        };
      }

      if (
        zone.side === 'RESISTANCE' &&
        currentPrice < zone.low &&
        currentPrice > zone.low - tolerance * 2
      ) {
        return {
          timestamp: nowMs,
          symbol: 'SUIUSDT',
          zone,
          eventType: 'APPROACH',
          priceAtEvent: currentPrice,
          atr,
        };
      }

      if (
        zone.side === 'SUPPORT' &&
        currentPrice > zone.high &&
        currentPrice < zone.high + tolerance * 2
      ) {
        return {
          timestamp: nowMs,
          symbol: 'SUIUSDT',
          zone,
          eventType: 'APPROACH',
          priceAtEvent: currentPrice,
          atr,
        };
      }
    }

    return null;
  }

  function getActiveZones(zones: SrZone[], currentPrice: number, atr: number): SrZone[] {
    const tolerance = Math.max(2, srZoneAtrTolerance * atr);
    return zones.filter(
      (z) =>
        !z.broken &&
        z.touchCount >= srMinTouchCount &&
        z.score >= srZoneScoreMin &&
        Math.abs(currentPrice - (z.high + z.low) / 2) < atr * 5,
    );
  }

  return { detectPivots, clusterZones, updateZones, findCandidateEvent, getActiveZones };
}
