import { describe, expect, it } from 'vitest';
import {
  RegimeEngineV2Decision,
  RegimeEngineV2InputCandle,
} from '../../domain/services/regime-v2/RegimeEngineV2.types';
import {
  buildRegimeEngineV2AuditReport,
  buildRegimeEngineV2AuditSamples,
  calculateRegimeEngineV2Outcome,
  detectLegacyXrpLongPattern,
  detectMomentumRidePattern,
  directionalEnvironmentBucket,
} from './regimeEngineV2AuditCore';

describe('regimeEngineV2AuditCore', () => {
  it('groups samples by momentumEnvironment', () => {
    const candlesBySymbol = new Map<string, RegimeEngineV2InputCandle[]>([
      ['BTCUSDT', testCandles('UP', 190)],
      ['ETHUSDT', testCandles('UP', 190)],
    ]);

    const report = buildRegimeEngineV2AuditReport(candlesBySymbol, {
      symbols: ['BTCUSDT', 'ETHUSDT'],
      sampleEvery: 12,
      writeReports: false,
    });

    expect(report.counts.samples).toBeGreaterThan(0);
    expect(report.byMomentumEnvironment.length).toBeGreaterThan(0);
    expect(Object.keys(report.distributions.momentumEnvironment).length).toBeGreaterThan(0);
  });

  it('calculates MFE MAE and hit8 metrics', () => {
    const candlesBySymbol = new Map<string, RegimeEngineV2InputCandle[]>([
      ['BTCUSDT', testCandles('UP', 190)],
      ['ETHUSDT', testCandles('UP', 190, { finalBurst: true })],
    ]);

    const report = buildRegimeEngineV2AuditReport(candlesBySymbol, {
      symbols: ['BTCUSDT', 'ETHUSDT'],
      sampleEvery: 12,
      writeReports: false,
    });
    const rows60 = report.byMomentumEnvironment.filter((row) => row.horizon === '60m');

    expect(rows60.some((row) => row.avgMfeRoe !== undefined)).toBe(true);
    expect(rows60.some((row) => row.avgMaeRoe !== undefined)).toBe(true);
    expect(rows60.some((row) => row.hit8BeforeMinus5Rate !== undefined)).toBe(true);
  });

  it('tolerates samples without enough future candles', () => {
    const candlesBySymbol = new Map<string, RegimeEngineV2InputCandle[]>([
      ['BTCUSDT', testCandles('UP', 123)],
      ['ETHUSDT', testCandles('UP', 123)],
    ]);

    const report = buildRegimeEngineV2AuditReport(candlesBySymbol, {
      symbols: ['BTCUSDT', 'ETHUSDT'],
      sampleEvery: 1,
      writeReports: false,
    });

    expect(report.counts.samples).toBeGreaterThan(0);
    expect(report.byMomentumEnvironment.length).toBeGreaterThan(0);
  });

  it('detects offline Momentum Ride-like long and short patterns', () => {
    const longCandles = patternCandles('LONG');
    const shortCandles = patternCandles('SHORT');

    expect(detectMomentumRidePattern(longCandles, longCandles.length - 1)?.side).toBe('LONG');
    expect(detectMomentumRidePattern(shortCandles, shortCandles.length - 1)?.side).toBe('SHORT');
  });

  it('calculates outcomes by side', () => {
    const candles = [
      candle(0, 100, 101, 99, 100, 100),
      candle(1, 100, 103, 99.5, 102, 120),
      candle(2, 102, 104, 101, 103, 120),
    ];
    const longOutcome = calculateRegimeEngineV2Outcome(
      candles,
      0,
      'LONG',
      20,
      15,
      testDecision('BREAKOUT_UP_EARLY'),
    );
    const shortOutcome = calculateRegimeEngineV2Outcome(
      candles,
      0,
      'SHORT',
      20,
      15,
      testDecision('BREAKOUT_DOWN_EARLY'),
    );

    expect(longOutcome.mfeRoe).toBeGreaterThan(0);
    expect(shortOutcome.maeRoe).toBeLessThan(0);
  });

  it('does not use future candles for offline momentum pattern detection', () => {
    const candles = testCandles('UP', 40);
    const index = 30;
    candles[index + 1] = {
      ...candles[index + 1],
      close: candles[index + 1].close + 20,
      high: candles[index + 1].high + 20,
      volume: 1000,
    };

    expect(detectMomentumRidePattern(candles, index)).toBeUndefined();
  });

  it('separates AVOID buckets by side', () => {
    expect(directionalEnvironmentBucket('AVOID_MOMENTUM', 'LONG')).toBe('AVOID_FOR_LONG');
    expect(directionalEnvironmentBucket('AVOID_MOMENTUM', 'SHORT')).toBe('AVOID_FOR_SHORT');
    expect(directionalEnvironmentBucket('UNKNOWN', 'LONG')).toBe('UNKNOWN_FOR_LONG');
  });

  it('supports pattern-only audit rows', () => {
    const candlesBySymbol = new Map<string, RegimeEngineV2InputCandle[]>([
      ['BTCUSDT', patternCandles('LONG', 180)],
      ['ETHUSDT', patternCandles('SHORT', 180)],
    ]);

    const report = buildRegimeEngineV2AuditReport(candlesBySymbol, {
      symbols: ['BTCUSDT', 'ETHUSDT'],
      sampleEvery: 6,
      momentumPatternOnly: true,
      writeReports: false,
    });

    expect(report.counts.samples).toBeGreaterThan(0);
    expect(report.byPatternSideEnvironment.length).toBeGreaterThan(0);
    expect(
      report.byDirectionalEnvironment.every((row) => !row.bucket.includes('AVOID_MOMENTUM')),
    ).toBe(true);
  });

  it('filters audit samples by requested side', () => {
    const candlesBySymbol = new Map<string, RegimeEngineV2InputCandle[]>([
      ['BTCUSDT', patternCandles('LONG', 180)],
      ['ETHUSDT', patternCandles('SHORT', 180)],
    ]);

    const longOnly = buildRegimeEngineV2AuditSamples(candlesBySymbol, {
      symbols: ['BTCUSDT', 'ETHUSDT'],
      sampleEvery: 6,
      momentumPatternOnly: true,
      side: 'LONG',
    });
    const shortOnly = buildRegimeEngineV2AuditSamples(candlesBySymbol, {
      symbols: ['BTCUSDT', 'ETHUSDT'],
      sampleEvery: 6,
      momentumPatternOnly: true,
      side: 'SHORT',
    });
    const both = buildRegimeEngineV2AuditSamples(candlesBySymbol, {
      symbols: ['BTCUSDT', 'ETHUSDT'],
      sampleEvery: 6,
      momentumPatternOnly: true,
    });

    expect(longOnly.samples.length).toBeGreaterThan(0);
    expect(longOnly.samples.every((sample) => sample.side === 'LONG')).toBe(true);
    expect(shortOnly.samples.length).toBeGreaterThan(0);
    expect(shortOnly.samples.every((sample) => sample.side === 'SHORT')).toBe(true);
    expect(both.samples.some((sample) => sample.side === 'LONG')).toBe(true);
    expect(both.samples.some((sample) => sample.side === 'SHORT')).toBe(true);
  });

  it('reports AVOID and UNKNOWN as side-specific buckets with a LONG filter', () => {
    const candlesBySymbol = new Map<string, RegimeEngineV2InputCandle[]>([
      ['BTCUSDT', choppyCandles(190)],
    ]);

    const report = buildRegimeEngineV2AuditReport(candlesBySymbol, {
      symbols: ['BTCUSDT'],
      sampleEvery: 12,
      side: 'LONG',
      writeReports: false,
    });

    expect(report.counts.samples).toBeGreaterThan(0);
    expect(report.byDirectionalEnvironment.every((row) => !row.bucket.endsWith('_FOR_SHORT'))).toBe(
      true,
    );
    expect(
      report.byDirectionalEnvironment.some(
        (row) => row.bucket === 'AVOID_FOR_LONG' || row.bucket === 'UNKNOWN_FOR_LONG',
      ),
    ).toBe(true);
  });

  it('detects legacy XRP long-streak pattern without using short samples', () => {
    const candlesBySymbol = new Map<string, RegimeEngineV2InputCandle[]>([
      ['XRPUSDT', legacyXrpLongCandles(180)],
    ]);

    expect(detectLegacyXrpLongPattern(legacyXrpLongCandles(100), 99)?.side).toBe('LONG');

    const result = buildRegimeEngineV2AuditSamples(candlesBySymbol, {
      symbols: ['XRPUSDT'],
      sampleEvery: 3,
      legacyXrpLongPattern: true,
    });

    expect(result.samples.length).toBeGreaterThan(0);
    expect(result.samples.every((sample) => sample.side === 'LONG')).toBe(true);
    expect(
      result.samples.every((sample) =>
        sample.pattern?.reasons.some((reason) => reason.startsWith('legacy_xrp_')),
      ),
    ).toBe(true);
  });

  it('treats date-only --to as an inclusive end date', () => {
    const candlesBySymbol = new Map<string, RegimeEngineV2InputCandle[]>([
      ['BTCUSDT', datedCandles()],
    ]);

    const result = buildRegimeEngineV2AuditSamples(candlesBySymbol, {
      symbols: ['BTCUSDT'],
      sampleEvery: 1,
      from: '2026-05-02',
      to: '2026-05-02',
      side: 'LONG',
    });

    expect(result.samples.length).toBeGreaterThan(0);
    expect(result.samples.every((sample) => sample.timestamp.startsWith('2026-05-02'))).toBe(true);
  });

  it('applies fee and slippage sensitivity without breaking outcomes', () => {
    const candles = patternCandles('LONG', 40);
    const noCost = calculateRegimeEngineV2Outcome(
      candles,
      30,
      'LONG',
      20,
      30,
      testDecision('BREAKOUT_UP_EARLY'),
    );
    const withCost = calculateRegimeEngineV2Outcome(
      candles,
      30,
      'LONG',
      20,
      30,
      testDecision('BREAKOUT_UP_EARLY'),
      {
        feeBps: 8,
        slippageBps: 3,
      },
    );

    expect(withCost.totalCostRoe).toBeGreaterThan(0);
    expect(withCost.forwardReturnRoe ?? 0).toBeLessThan(noCost.forwardReturnRoe ?? 0);
  });

  it('supports progress and max samples per symbol options', () => {
    const candlesBySymbol = new Map<string, RegimeEngineV2InputCandle[]>([
      ['BTCUSDT', patternCandles('LONG', 180)],
      ['ETHUSDT', patternCandles('SHORT', 180)],
    ]);

    const result = buildRegimeEngineV2AuditSamples(candlesBySymbol, {
      symbols: ['BTCUSDT', 'ETHUSDT'],
      sampleEvery: 1,
      momentumPatternOnly: true,
      maxSamplesPerSymbol: 2,
      progressEvery: 1,
      horizons: [60],
      engineLookbackCandles: 160,
    });

    expect(result.samples.length).toBeLessThanOrEqual(4);
    expect(result.horizons).toEqual([60]);
    expect(result.engineLookbackCandles).toBe(160);
  });

  it('groups SHORT V2.3 breakdown quality and degradation reasons', () => {
    const candlesBySymbol = new Map<string, RegimeEngineV2InputCandle[]>([
      ['BTCUSDT', patternCandles('SHORT', 190)],
      ['ETHUSDT', patternCandles('SHORT', 190)],
    ]);

    const report = buildRegimeEngineV2AuditReport(candlesBySymbol, {
      symbols: ['BTCUSDT', 'ETHUSDT'],
      sampleEvery: 6,
      momentumPatternOnly: true,
      writeReports: false,
    });

    expect(report.byShortBreakdownQuality.length).toBeGreaterThan(0);
    expect(report.byShortRetestContext.length).toBeGreaterThan(0);
    expect(report.byShortDegradationReason.every((row) => row.horizon)).toBe(true);
  });
});

function testCandles(
  direction: 'UP' | 'DOWN',
  count: number,
  options: { finalBurst?: boolean } = {},
): RegimeEngineV2InputCandle[] {
  const rows: RegimeEngineV2InputCandle[] = [];
  let price = 100;
  for (let index = 0; index < count; index++) {
    const step = direction === 'UP' ? 0.06 : -0.06;
    const burst = options.finalBurst && index > count - 20 ? 0.12 : 0;
    const open = price;
    const close = price + step + (direction === 'UP' ? burst : -burst);
    const high = Math.max(open, close) + 0.05;
    const low = Math.min(open, close) - 0.04;
    rows.push({
      timestamp: Date.parse('2026-05-01T00:00:00.000Z') + index * 5 * 60_000,
      open,
      high,
      low,
      close,
      volume: 100 + (index % 10) * 5 + (options.finalBurst && index > count - 20 ? 90 : 0),
    });
    price = close;
  }
  return rows;
}

function candle(
  index: number,
  open: number,
  high: number,
  low: number,
  close: number,
  volume: number,
): RegimeEngineV2InputCandle {
  return {
    timestamp: Date.parse('2026-05-01T00:00:00.000Z') + index * 5 * 60_000,
    open,
    high,
    low,
    close,
    volume,
  };
}

function patternCandles(side: 'LONG' | 'SHORT', count = 80): RegimeEngineV2InputCandle[] {
  const direction = side === 'LONG' ? 'UP' : 'DOWN';
  const rows = testCandles(direction, count);
  for (let i = Math.max(30, count - 5); i < count; i++) {
    const previous = rows[i - 1];
    const impulse = side === 'LONG' ? 0.35 : -0.35;
    rows[i] = candle(
      i,
      previous.close,
      Math.max(previous.close, previous.close + impulse) + 0.03,
      Math.min(previous.close, previous.close + impulse) - 0.03,
      previous.close + impulse,
      260,
    );
  }
  return rows;
}

function legacyXrpLongCandles(count = 100): RegimeEngineV2InputCandle[] {
  const rows = testCandles('UP', count);
  for (let i = Math.max(80, count - 4); i < count; i++) {
    const previous = rows[i - 1];
    rows[i] = candle(
      i,
      previous.close,
      previous.close + 0.22,
      previous.close - 0.02,
      previous.close + 0.18,
      240 + i,
    );
  }
  return rows;
}

function choppyCandles(count = 190): RegimeEngineV2InputCandle[] {
  const rows: RegimeEngineV2InputCandle[] = [];
  let price = 100;
  for (let index = 0; index < count; index++) {
    const close = price + (index % 2 === 0 ? 0.03 : -0.03);
    rows.push(
      candle(
        index,
        price,
        Math.max(price, close) + 0.08,
        Math.min(price, close) - 0.08,
        close,
        100 + (index % 5),
      ),
    );
    price = close;
  }
  return rows;
}

function datedCandles(): RegimeEngineV2InputCandle[] {
  const rows = testCandles('UP', 400);
  const start = Date.parse('2026-05-01T00:00:00.000Z');
  return rows.map((row, index) => ({
    ...row,
    timestamp: start + index * 5 * 60_000,
  }));
}

function testDecision(regime: RegimeEngineV2Decision['technicalRegime']): RegimeEngineV2Decision {
  return {
    symbol: 'ETHUSDT',
    timestamp: '2026-05-01T00:00:00.000Z',
    timeframe: '5m',
    technicalRegime: regime,
    technicalDirection: regime.includes('DOWN') ? 'SHORT' : 'LONG',
    momentumEnvironment: regime.includes('DOWN') ? 'ALLOW_SHORT_MOMENTUM' : 'ALLOW_LONG_MOMENTUM',
    confidence: 0.8,
    scores: {
      trendStrength: 0.7,
      momentumQuality: 0.7,
      chopRisk: 0.2,
      exhaustionRisk: 0.2,
      transitionRisk: 0.2,
      volatilityRisk: 0.3,
      marketConfirmationScore: 0.55,
    },
    marketConfirmation: { state: 'NEUTRAL' },
    transition: { risk: 'LOW', reasons: [] },
    indicators: {},
    reasons: [],
  };
}
