import { describe, expect, it } from 'vitest';
import { Candle, Side } from '../types';
import { evaluateMainStackingMomentum, MAIN_STACKING_MOMENTUM_AUTHORITY } from './MainStackingMomentumStrategy';

function momentumCandles(side: Side): Candle[] {
  const direction = side === 'LONG' ? 1 : -1;
  return Array.from({ length: 80 }, (_, index) => {
    const close = 100 + direction * index * 0.01;
    const isMomentum = index >= 77;
    const open = isMomentum ? close - direction * 0.2 : close - direction * 0.05;
    return {
      openTime: index * 300_000,
      timestamp: index * 300_000,
      open,
      high: Math.max(open, close) + 0.1,
      low: Math.min(open, close) - 0.1,
      close,
      volume: isMomentum ? 120 + (index - 77) * 2 : 100,
      buyVolume: 50,
      closeTime: (index + 1) * 300_000 - 1,
    };
  });
}

describe('MainStackingMomentumStrategy', () => {
  it.each(['LONG', 'SHORT'] as Side[])('reproduces origin/main %s entry checks', (side) => {
    const result = evaluateMainStackingMomentum(momentumCandles(side), side);

    expect(result.allowed).toBe(true);
    expect(result.reason).toBe('main_stacking_momentum_confirmed');
    expect(Object.values(result.diagnostics.checks).every(Boolean)).toBe(true);
    expect(MAIN_STACKING_MOMENTUM_AUTHORITY).toContain('3a6dbc3');
  });

  it('requires all three momentum candles to exceed the frozen volume threshold', () => {
    const candles = momentumCandles('LONG');
    candles[77].volume = 50;

    const result = evaluateMainStackingMomentum(candles, 'LONG');

    expect(result.allowed).toBe(false);
    expect(result.diagnostics.checks.volume).toBe(false);
  });

  it('rejects fewer than 80 candles', () => {
    expect(evaluateMainStackingMomentum(momentumCandles('LONG').slice(-79), 'LONG')).toMatchObject({
      allowed: false,
      reason: 'few_candles',
    });
  });
});
