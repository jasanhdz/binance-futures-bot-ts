import { describe, expect, it } from 'vitest';
import { calculateSizing, SizingInput } from './SizingEngine';

function baseInput(overrides: Partial<SizingInput> = {}): SizingInput {
  return {
    balance: 1000,
    riskFraction: 0.02,
    entryPrice: 1.0,
    stopPrice: 0.95,
    leverage: 20,
    feeBufferPct: 0.001,
    minNotional: 5,
    maxNotional: 5000,
    stepSize: 1,
    qtyPrecision: 1,
    ...overrides,
  };
}

describe('calculateSizing', () => {
  it('calculates quantity from risk budget', () => {
    const result = calculateSizing(baseInput());
    expect(result.valid).toBe(true);
    // distance = 0.05, riskPerUnit = 0.05 + 0.002 = 0.052
    // maxLossBudget = 1000 * 0.02 = 20
    // rawQty = 20 / 0.052 ≈ 384.6
    // Notional cap: 5000 / 1.0 = 5000
    // Margin cap: 1000 * 20 / 1.0 = 20000
    // min = 384.6, rounded to stepSize 1 = 384
    expect(result.quantity).toBe(384);
    expect(result.notional).toBeCloseTo(384);
    expect(result.riskPerUnit).toBeCloseTo(0.052);
    expect(result.maxLoss).toBeCloseTo(384 * 0.052);
  });

  it('caps by maxNotional', () => {
    const result = calculateSizing(baseInput({ maxNotional: 100 }));
    expect(result.valid).toBe(true);
    expect(result.notional).toBeLessThanOrEqual(100);
  });

  it('caps by available margin', () => {
    const result = calculateSizing(baseInput({ leverage: 1 }));
    expect(result.valid).toBe(true);
    // Margin cap: 1000 * 1 / 1.0 = 1000
    expect(result.notional).toBeLessThanOrEqual(1000);
  });

  it('rounds down to stepSize', () => {
    const result = calculateSizing(baseInput({ stepSize: 10 }));
    expect(result.valid).toBe(true);
    expect(result.quantity % 10).toBe(0);
  });

  it('rejects when below minNotional', () => {
    const result = calculateSizing(baseInput({ minNotional: 100000 }));
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('BELOW_MIN_NOTIONAL');
  });

  it('rejects when stop equals entry', () => {
    const result = calculateSizing(baseInput({ stopPrice: 1.0 }));
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('STOP_EQUALS_ENTRY');
  });

  it('rejects invalid balance', () => {
    expect(calculateSizing(baseInput({ balance: NaN })).valid).toBe(false);
    expect(calculateSizing(baseInput({ balance: -100 })).valid).toBe(false);
    expect(calculateSizing(baseInput({ balance: 0 })).valid).toBe(false);
  });

  it('rejects invalid risk fraction', () => {
    expect(calculateSizing(baseInput({ riskFraction: 0 })).valid).toBe(false);
    expect(calculateSizing(baseInput({ riskFraction: 1.5 })).valid).toBe(false);
  });

  it('rejects invalid entry price', () => {
    expect(calculateSizing(baseInput({ entryPrice: 0 })).valid).toBe(false);
    expect(calculateSizing(baseInput({ entryPrice: -1 })).valid).toBe(false);
  });

  it('rejects invalid leverage', () => {
    expect(calculateSizing(baseInput({ leverage: 0 })).valid).toBe(false);
  });

  it('handles SHORT side correctly', () => {
    const result = calculateSizing(baseInput({
      entryPrice: 1.0,
      stopPrice: 1.05, // Stop above entry for SHORT
    }));
    expect(result.valid).toBe(true);
    expect(result.quantity).toBeGreaterThan(0);
  });

  it('calculates correct maxLoss for different risk fractions', () => {
    const r1 = calculateSizing(baseInput({ riskFraction: 0.01 }));
    const r2 = calculateSizing(baseInput({ riskFraction: 0.05 }));
    expect(r2.maxLoss).toBeGreaterThan(r1.maxLoss);
  });

  it('handles high-leverage scenario', () => {
    const result = calculateSizing(baseInput({ leverage: 125 }));
    expect(result.valid).toBe(true);
    // With high leverage, margin cap becomes binding.
    expect(result.notional).toBeLessThanOrEqual(1000 * 125);
  });

  it('handles tight stop correctly', () => {
    const result = calculateSizing(baseInput({ stopPrice: 0.999 }));
    expect(result.valid).toBe(true);
    // Tight stop = small risk per unit = larger quantity.
    expect(result.quantity).toBeGreaterThan(384);
  });

  it('respects qtyPrecision', () => {
    const result = calculateSizing(baseInput({ qtyPrecision: 3, stepSize: 0.001 }));
    expect(result.valid).toBe(true);
    const decimals = result.quantity.toString().split('.')[1]?.length ?? 0;
    expect(decimals).toBeLessThanOrEqual(3);
  });
});
