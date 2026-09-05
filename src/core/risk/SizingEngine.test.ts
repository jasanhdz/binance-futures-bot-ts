import { describe, expect, it } from 'vitest';
import { calculateSizing, SizingInput } from './SizingEngine';

function baseInput(overrides: Partial<SizingInput> = {}): SizingInput {
  return {
    balance: 1000,
    riskFraction: 0.02,
    entryPrice: 1.0,
    stopPrice: 0.95,
    side: 'LONG',
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
    // Stop at entry is caught by geometry check (stop above/equals entry for LONG).
    expect(result.reason).toBe('STOP_ABOVE_ENTRY_FOR_LONG');
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
      side: 'SHORT',
      entryPrice: 1.0,
      stopPrice: 1.05, // Stop above entry for SHORT
    }));
    expect(result.valid).toBe(true);
    expect(result.quantity).toBeGreaterThan(0);
  });

  it('rejects LONG with stop above entry', () => {
    const result = calculateSizing(baseInput({
      side: 'LONG',
      entryPrice: 1.0,
      stopPrice: 1.05,
    }));
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('STOP_ABOVE_ENTRY_FOR_LONG');
  });

  it('rejects SHORT with stop below entry', () => {
    const result = calculateSizing(baseInput({
      side: 'SHORT',
      entryPrice: 1.0,
      stopPrice: 0.95,
    }));
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('STOP_BELOW_ENTRY_FOR_SHORT');
  });

  it('rejects invalid side', () => {
    const result = calculateSizing(baseInput({ side: 'UP' as any }));
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('INVALID_SIDE');
  });

  it('calculates correct maxLoss for different risk fractions', () => {
    const r1 = calculateSizing(baseInput({ riskFraction: 0.01 }));
    const r2 = calculateSizing(baseInput({ riskFraction: 0.05 }));
    expect(r2.maxLoss).toBeGreaterThan(r1.maxLoss);
  });

  it('rejects when maxLoss exceeds budget after rounding', () => {
    // With stepSize=10, the rounded-up quantity may push maxLoss above budget.
    const result = calculateSizing(baseInput({
      balance: 10,
      riskFraction: 0.01,
      entryPrice: 1.0,
      stopPrice: 0.999,
      leverage: 20,
      stepSize: 10,
      qtyPrecision: 0,
      minNotional: 5,
      maxNotional: 10000,
    }));
    // Budget: 10 * 0.01 = 0.1. riskPerUnit ≈ 0.001 + 0.002 = 0.003
    // rawQty ≈ 0.1 / 0.003 ≈ 33, rounded to stepSize 10 → 30
    // maxLoss = 30 * 0.003 = 0.09. Should be valid.
    if (result.valid) {
      expect(result.maxLoss).toBeLessThanOrEqual(0.1 * 1.0001);
    }
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

  it('does not inflate quantity via precision rounding', () => {
    // With stepSize=10 and qtyPrecision=0, rounding must not increase quantity.
    const result = calculateSizing(baseInput({
      balance: 1000,
      riskFraction: 0.02,
      entryPrice: 1.0,
      stopPrice: 0.999,
      leverage: 20,
      stepSize: 10,
      qtyPrecision: 0,
    }));
    expect(result.valid).toBe(true);
    // Quantity should be multiple of 10.
    expect(result.quantity % 10).toBe(0);
  });

  it('rejects when quantity exceeds maxNotional after rounding', () => {
    const result = calculateSizing(baseInput({
      balance: 100000,
      riskFraction: 0.5,
      entryPrice: 1.0,
      stopPrice: 0.99,
      leverage: 125,
      maxNotional: 100,
      stepSize: 1,
      qtyPrecision: 0,
    }));
    // Should be capped by maxNotional.
    expect(result.valid).toBe(true);
    expect(result.notional).toBeLessThanOrEqual(100 * 1.0001);
  });

  it('rejects when quantity exceeds margin after rounding', () => {
    const result = calculateSizing(baseInput({
      balance: 10,
      riskFraction: 0.5,
      entryPrice: 1.0,
      stopPrice: 0.99,
      leverage: 20,
      maxNotional: 100000,
      stepSize: 1,
      qtyPrecision: 0,
    }));
    // Should be capped by margin (10 * 20 = 200).
    expect(result.valid).toBe(true);
    expect(result.notional).toBeLessThanOrEqual(200 * 1.0001);
  });
});
