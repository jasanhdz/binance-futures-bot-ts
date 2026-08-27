import { describe, expect, it } from 'vitest';
import { CandleRow, classifyTechnicalRegime } from './regimeDetectorDeepAuditCore';

function candle(index: number, close: number, volume = 100): CandleRow {
  const timestampMs = Date.parse('2026-01-01T00:00:00.000Z') + index * 5 * 60_000;
  return {
    timestampMs,
    open: close - 0.5,
    high: close + 1,
    low: close - 1,
    close,
    volume,
  };
}

function trendUpCandles(): CandleRow[] {
  return Array.from({ length: 160 }, (_, index) => {
    const close = 100 + index * 0.35 + Math.sin(index / 4) * 0.2;
    return candle(index, close, index > 135 ? 180 : 100);
  });
}

function chopCandles(): CandleRow[] {
  return Array.from({ length: 160 }, (_, index) => {
    const close = 100 + Math.sin(index) * 0.6;
    return candle(index, close, 100);
  });
}

describe('regimeDetectorDeepAuditCore', () => {
  it('clasifica estructura alcista como regimen direccional LONG', () => {
    const candles = trendUpCandles();
    const snapshot = classifyTechnicalRegime(candles, candles.length - 1);

    expect(['MOMENTUM_UP', 'TREND_UP', 'BREAKOUT_UP']).toContain(snapshot.technicalRegime);
    expect(snapshot.direction).toBe('LONG');
    expect(snapshot.confidence).toBeGreaterThan(0);
  });

  it('clasifica estructura lateral como CHOP o UNKNOWN sin direccion', () => {
    const candles = chopCandles();
    const snapshot = classifyTechnicalRegime(candles, candles.length - 1);

    expect(['CHOP', 'UNKNOWN', 'HIGH_VOL_RISK']).toContain(snapshot.technicalRegime);
    expect(snapshot.direction).toBe('NONE');
  });

  it('marca UNKNOWN cuando no hay historial suficiente', () => {
    const candles = trendUpCandles().slice(0, 50);
    const snapshot = classifyTechnicalRegime(candles, candles.length - 1);

    expect(snapshot.technicalRegime).toBe('UNKNOWN');
    expect(snapshot.reason).toBe('insufficient_history');
  });
});
