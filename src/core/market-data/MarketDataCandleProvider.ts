import type { Candle } from '../types';
import type {
  CandleGapCheck,
  CandleHealth,
  CandleObservation,
  CandlePort,
  CandleSeriesSnapshot,
} from '../../app/ports/MarketData';

export interface CandleSource {
  getCandles(symbol: string, interval: string, limit: number): Promise<Candle[]>;
  getServerTime(): Promise<number>;
}

export interface CandleClock {
  now(): number;
}

type IntervalDefinition = {
  gapCheck: CandleGapCheck;
  nextOpenTime(openTime: number): number;
  durationMs?: number;
};

const FIXED_INTERVALS: Record<string, number> = {
  '1m': 60_000,
  '3m': 3 * 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '30m': 30 * 60_000,
  '1h': 60 * 60_000,
  '2h': 2 * 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '6h': 6 * 60 * 60_000,
  '8h': 8 * 60 * 60_000,
  '12h': 12 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
  '3d': 3 * 24 * 60 * 60_000,
  '1w': 7 * 24 * 60 * 60_000,
};

/** Wraps existing REST candle reads into a causal, neutral observation. */
export class MarketDataCandleProvider implements CandlePort {
  constructor(
    private readonly source: CandleSource,
    private readonly clock: CandleClock,
  ) {}

  async getSeries(symbol: string, interval: string, limit: number): Promise<CandleSeriesSnapshot> {
    const normalizedSymbol = symbol.toUpperCase();
    const definition = intervalDefinition(interval);
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      return unavailable(normalizedSymbol, interval, definition.gapCheck);
    }

    let sourceCandles: Candle[];
    let exchangeSnapshotTimeMs: number;
    try {
      exchangeSnapshotTimeMs = await this.source.getServerTime();
      sourceCandles = await this.source.getCandles(normalizedSymbol, interval, limit);
    } catch {
      return unavailable(normalizedSymbol, interval, definition.gapCheck);
    }

    const observedAtMs = this.clock.now();
    if (
      !Number.isFinite(exchangeSnapshotTimeMs) ||
      exchangeSnapshotTimeMs < 0 ||
      !Number.isFinite(observedAtMs) ||
      observedAtMs < 0
    ) {
      return anomalous(normalizedSymbol, interval, definition.gapCheck, null, null);
    }
    if (!Array.isArray(sourceCandles) || sourceCandles.length === 0) {
      return unavailable(
        normalizedSymbol,
        interval,
        definition.gapCheck,
        observedAtMs,
        exchangeSnapshotTimeMs,
      );
    }

    const observations: CandleObservation[] = [];
    const openTimes = new Set<number>();
    const closeTimes = new Set<number>();
    for (const candle of sourceCandles) {
      if (
        !validCandle(candle) ||
        candle.openTime > exchangeSnapshotTimeMs ||
        openTimes.has(candle.openTime) ||
        closeTimes.has(candle.closeTime)
      ) {
        return anomalous(
          normalizedSymbol,
          interval,
          definition.gapCheck,
          observedAtMs,
          exchangeSnapshotTimeMs,
        );
      }
      openTimes.add(candle.openTime);
      closeTimes.add(candle.closeTime);
      observations.push(
        Object.freeze({
          symbol: normalizedSymbol,
          interval,
          openTime: candle.openTime,
          closeTime: candle.closeTime,
          open: candle.open,
          high: candle.high,
          low: candle.low,
          close: candle.close,
          volume: candle.volume,
          buyVolume: candle.buyVolume,
          status:
            candle.closeTime <= exchangeSnapshotTimeMs ? ('CLOSED' as const) : ('OPEN' as const),
          observedAtMs,
          source: 'REST' as const,
        }),
      );
    }

    for (let index = 1; index < sourceCandles.length; index++) {
      if (sourceCandles[index - 1].openTime >= sourceCandles[index].openTime) {
        return anomalous(
          normalizedSymbol,
          interval,
          definition.gapCheck,
          observedAtMs,
          exchangeSnapshotTimeMs,
        );
      }
    }

    let gapCount = 0;
    if (definition.gapCheck === 'CHECKED') {
      for (let index = 1; index < observations.length; index++) {
        if (
          definition.nextOpenTime(observations[index - 1].openTime) !== observations[index].openTime
        )
          gapCount++;
      }
    }

    const latest = observations[observations.length - 1];
    const stale =
      definition.durationMs !== undefined &&
      exchangeSnapshotTimeMs - (latest.status === 'OPEN' ? latest.openTime : latest.closeTime) >=
        definition.durationMs;
    const health: CandleHealth = gapCount > 0 ? 'GAPPED' : stale ? 'STALE' : 'HEALTHY';
    return snapshot(
      normalizedSymbol,
      interval,
      observations,
      health,
      observedAtMs,
      exchangeSnapshotTimeMs,
      gapCount,
      definition.gapCheck === 'CHECKED' ? gapCount > 0 : null,
      definition.gapCheck,
    );
  }
}

function intervalDefinition(interval: string): IntervalDefinition {
  const durationMs = FIXED_INTERVALS[interval];
  if (durationMs !== undefined) {
    return {
      durationMs,
      gapCheck: 'CHECKED',
      nextOpenTime: (openTime) => openTime + durationMs,
    };
  }
  if (interval === '1M') {
    return {
      gapCheck: 'CHECKED',
      nextOpenTime: (openTime) => {
        const date = new Date(openTime);
        return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
      },
    };
  }
  return {
    gapCheck: 'UNSUPPORTED',
    nextOpenTime: (openTime) => openTime,
  };
}

function validCandle(candle: Candle): boolean {
  return Boolean(
    candle &&
      Number.isFinite(candle.openTime) &&
      Number.isFinite(candle.closeTime) &&
      candle.openTime >= 0 &&
      candle.openTime <= candle.closeTime &&
      validPrice(candle.open) &&
      validPrice(candle.high) &&
      validPrice(candle.low) &&
      validPrice(candle.close) &&
      candle.high >= Math.max(candle.open, candle.close, candle.low) &&
      candle.low <= Math.min(candle.open, candle.close, candle.high) &&
      validNonNegative(candle.volume) &&
      validNonNegative(candle.buyVolume),
  );
}

function validPrice(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function validNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function snapshot(
  symbol: string,
  interval: string,
  candles: readonly CandleObservation[],
  health: CandleHealth,
  observedAtMs: number | null,
  exchangeSnapshotTimeMs: number | null,
  gapCount: number,
  hasGaps: boolean | null,
  gapCheck: CandleGapCheck,
): CandleSeriesSnapshot {
  return Object.freeze({
    symbol,
    interval,
    candles: Object.freeze([...candles]),
    health,
    observedAtMs,
    exchangeSnapshotTimeMs,
    gapCount,
    hasGaps,
    gapCheck,
    source: 'REST' as const,
  });
}

function unavailable(
  symbol: string,
  interval: string,
  gapCheck: CandleGapCheck,
  observedAtMs: number | null = null,
  exchangeSnapshotTimeMs: number | null = null,
): CandleSeriesSnapshot {
  return snapshot(
    symbol,
    interval,
    [],
    'UNAVAILABLE',
    observedAtMs,
    exchangeSnapshotTimeMs,
    0,
    null,
    gapCheck,
  );
}

function anomalous(
  symbol: string,
  interval: string,
  gapCheck: CandleGapCheck,
  observedAtMs: number | null,
  exchangeSnapshotTimeMs: number | null,
): CandleSeriesSnapshot {
  return snapshot(
    symbol,
    interval,
    [],
    'ANOMALOUS',
    observedAtMs,
    exchangeSnapshotTimeMs,
    0,
    null,
    gapCheck,
  );
}
