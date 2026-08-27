import { describe, expect, it } from 'vitest';
import {
  buildRegimeMetrics,
  buildRegimeSideMetrics,
  buildConfirmationSegments,
  buildSymbolMetrics,
  calculateIndicators,
  calculateOutcome,
  CandleRow,
  detectMomentumPattern,
  hitThresholdBeforeAdverse,
  RegimeAuditEvaluation,
} from './regimeGuardAuditCore';

function candle(
  minute: number,
  open: number,
  high: number,
  low: number,
  close: number,
  volume = 100,
): CandleRow {
  const base = Date.parse('2026-05-21T00:00:00Z');
  return {
    timestampMs: base + minute * 60_000,
    open,
    high,
    low,
    close,
    volume,
  };
}

describe('regimeGuardAuditCore', () => {
  it('calculates LONG MFE, MAE and future return', () => {
    const candles = [
      candle(0, 100, 101, 99, 100),
      candle(5, 100, 103, 99, 102),
      candle(10, 102, 104, 98, 101),
      candle(15, 101, 105, 100, 104),
    ];

    const result = calculateOutcome(candles, candles[0].timestampMs, 'LONG', 20, 15);

    expect(result.entryPrice).toBe(100);
    expect(result.futureHigh).toBe(105);
    expect(result.futureLow).toBe(98);
    expect(result.mfeRoe).toBeCloseTo(1);
    expect(result.maeRoe).toBeCloseTo(-0.4);
    expect(result.returnRoe).toBeCloseTo(0.8);
  });

  it('calculates SHORT MFE, MAE and future return', () => {
    const candles = [
      candle(0, 100, 101, 99, 100),
      candle(5, 100, 101, 96, 98),
      candle(10, 98, 103, 95, 97),
    ];

    const result = calculateOutcome(candles, candles[0].timestampMs, 'SHORT', 10, 15);

    expect(result.futureHigh).toBe(103);
    expect(result.futureLow).toBe(95);
    expect(result.mfeRoe).toBeCloseTo(0.5);
    expect(result.maeRoe).toBeCloseTo(-0.3);
    expect(result.returnRoe).toBeCloseTo(0.3);
  });

  it('detects target threshold before adverse threshold', () => {
    const future = [candle(5, 100, 100.3, 99.9, 100.2), candle(10, 100.2, 100.5, 99.7, 100.4)];

    const result = hitThresholdBeforeAdverse(future, 100, 'LONG', 20, 0.08, 0.08);

    expect(result).toBe('TARGET_FIRST');
  });

  it('detects adverse threshold before target threshold', () => {
    const future = [candle(5, 100, 100.1, 99.4, 99.8), candle(10, 99.8, 100.7, 99.7, 100.5)];

    const result = hitThresholdBeforeAdverse(future, 100, 'LONG', 20, 0.08, 0.08);

    expect(result).toBe('ADVERSE_FIRST');
  });

  it('detects same-candle ambiguity conservatively', () => {
    const future = [candle(5, 100, 100.7, 99.3, 100.1)];

    const result = hitThresholdBeforeAdverse(future, 100, 'LONG', 20, 0.08, 0.08);

    expect(result).toBe('BOTH_SAME_CANDLE');
  });

  it('groups regime metrics with hit rates and conclusions', () => {
    const rows = [
      evaluation('ETHUSDT', 'MOMENTUM_UP', 0.3, -0.1, 'TARGET_FIRST'),
      evaluation('BTCUSDT', 'MOMENTUM_UP', 0.2, -0.1, 'TARGET_FIRST'),
      evaluation('ADAUSDT', 'CHOP', 0.05, -0.2, 'ADVERSE_FIRST'),
    ];

    const metrics = buildRegimeMetrics(rows);

    const momentum = metrics.find((row) => row.regime === 'MOMENTUM_UP');
    expect(momentum?.count).toBe(2);
    expect(momentum?.hit5BeforeMinus5Rate).toBe(1);
    expect(momentum?.avgMfe60).toBeCloseTo(0.25);
  });

  it('groups symbol metrics and picks best/worst labels', () => {
    const rows = [
      evaluation('ETHUSDT', 'MOMENTUM_UP', 0.3, -0.1, 'TARGET_FIRST'),
      evaluation('ETHUSDT', 'CHOP', 0.05, -0.2, 'ADVERSE_FIRST'),
      evaluation('BTCUSDT', 'MOMENTUM_DOWN', 0.2, -0.08, 'TARGET_FIRST'),
    ];

    const metrics = buildSymbolMetrics(rows);

    const eth = metrics.find((row) => row.symbol === 'ETHUSDT');
    expect(eth?.countMomentum).toBe(1);
    expect(eth?.countChop).toBe(1);
    expect(eth?.bestLabel).toBe('MOMENTUM_UP');
    expect(eth?.worstLabel).toBe('CHOP');
  });

  it('detects a LONG candle-derived momentum pattern', () => {
    const candles = [
      ...Array.from({ length: 20 }, (_, index) => candle(index * 5, 100, 100.2, 99.8, 100.05, 100)),
      candle(100, 100, 101, 99.9, 100.8, 100),
      candle(105, 100.8, 102, 100.7, 101.7, 150),
      candle(110, 101.7, 103, 101.6, 102.8, 180),
    ];

    const result = detectMomentumPattern(candles, candles.length - 1, 3, 1.3);

    expect(result?.side).toBe('LONG');
    expect(result?.snapshot.candles).toBe(3);
    expect(result?.snapshot.volumeRatio).toBeGreaterThanOrEqual(1.3);
    expect(result?.snapshot.closeLocation).toBeGreaterThan(0.5);
  });

  it('rejects momentum patterns below the volume ratio threshold', () => {
    const candles = [
      ...Array.from({ length: 20 }, (_, index) => candle(index * 5, 100, 100.2, 99.8, 100.05, 100)),
      candle(100, 100, 101, 99.9, 100.8, 100),
      candle(105, 100.8, 102, 100.7, 101.7, 100),
      candle(110, 101.7, 103, 101.6, 102.8, 100),
    ];

    const result = detectMomentumPattern(candles, candles.length - 1, 3, 1.3);

    expect(result).toBeUndefined();
  });

  it('builds regime side and confirmation segment metrics', () => {
    const rows = [
      evaluation('ETHUSDT', 'MOMENTUM_UP', 0.3, -0.1, 'TARGET_FIRST'),
      evaluation('BTCUSDT', 'MOMENTUM_DOWN', 0.2, -0.08, 'TARGET_FIRST'),
      evaluation('ADAUSDT', 'CHOP', 0.05, -0.2, 'ADVERSE_FIRST'),
    ];

    const bySide = buildRegimeSideMetrics(rows);
    const segments = buildConfirmationSegments(rows);

    expect(bySide.find((row) => row.side === 'LONG' && row.regime === 'MOMENTUM_UP')?.count).toBe(
      1,
    );
    expect(segments.find((row) => row.segment === 'momentum_pattern_only')?.count).toBe(3);
  });

  it('calculates local indicators for a clear uptrend', () => {
    const candles = Array.from({ length: 130 }, (_, index) => {
      const price = 100 + index * 0.2;
      return candle(index * 5, price, price + 0.3, price - 0.2, price + 0.1, 100 + index);
    });

    const result = calculateIndicators(candles, candles[candles.length - 1].timestampMs);

    expect(result.ema7).toBeGreaterThan(result.ema25 ?? 0);
    expect(result.ema25).toBeGreaterThan(result.ema99 ?? 0);
    expect(['TREND_UP', 'HIGH_VOL_RISK']).toContain(result.classification);
  });
});

function evaluation(
  symbol: string,
  regime: 'MOMENTUM_UP' | 'MOMENTUM_DOWN' | 'CHOP',
  mfe60: number,
  mae60: number,
  hit5: 'TARGET_FIRST' | 'ADVERSE_FIRST',
): RegimeAuditEvaluation {
  return {
    timestamp: '2026-05-21T00:00:00.000Z',
    timestampMs: Date.parse('2026-05-21T00:00:00Z'),
    symbol,
    side: regime === 'MOMENTUM_DOWN' ? 'SHORT' : 'LONG',
    regime,
    confidence: 0.8,
    reason: 'regime_trade_allowed',
    wouldBlock: regime === 'CHOP',
    allowed: regime !== 'CHOP',
    source: 'HYBRID_HEURISTIC',
    outcomes: {
      '15m': { minutes: 15, mfeRoe: mfe60 / 2, maeRoe: mae60 / 2, returnRoe: mfe60 / 4 },
      '30m': { minutes: 30, mfeRoe: mfe60 * 0.75, maeRoe: mae60 * 0.75, returnRoe: mfe60 / 3 },
      '60m': {
        minutes: 60,
        mfeRoe: mfe60,
        maeRoe: mae60,
        returnRoe: mfe60 + mae60,
        hit5BeforeMinus5: hit5,
        hit8BeforeMinus8: hit5,
      },
    },
  };
}
