import { describe, expect, it } from 'vitest';
import {
  sizeMicroBurstLossBudget,
  type MicroBurstLossBudgetInput,
} from './MicroBurstLossBudgetSizing';
import { createMicroBurstExecutionIntent } from './MicroBurstExecutionIntentFactory';
import { createMicroBurstV1Identity } from './MicroBurstIdentity';
import { defaultMicroBurstConfig } from './MicroBurstTypes';

const now = 1_700_000_000_000;
const config = defaultMicroBurstConfig();
function fixture(side: 'LONG' | 'SHORT' = 'LONG'): MicroBurstLossBudgetInput {
  return {
    intent: createMicroBurstExecutionIntent({
      identity: createMicroBurstV1Identity(),
      symbol: 'ETHUSDT',
      side,
      requestedAt: now,
      signalSnapshotAtMs: now - 1000,
      tradeId: 'sizing',
      leverage: 20,
      positionFraction: 0.9,
      stopInvalidationPrice: side === 'LONG' ? 99.5 : 100.5,
      targetPrice: side === 'LONG' ? 102 : 98,
    }),
    book: {
      observedAtMs: now,
      status: 'HEALTHY',
      askDepth: [{ price: 100.01, qty: 100 }],
      bidDepth: [{ price: 99.99, qty: 100 }],
    },
    now,
    marginBudget: 100,
    lossBudget: 2,
    approvedLeverageCap: 20,
    liquidationPrice: side === 'LONG' ? 95 : 105,
    stopStressBps: 10,
    residualCostBps: 14,
    stepSize: 0.001,
    qtyPrecision: 3,
    minNotional: 5,
  };
}
describe('Micro explicit loss-budget proposal', () => {
  it.each(['LONG', 'SHORT'] as const)(
    'bounds %s stressed monetary loss, margin and depth',
    (side) => {
      const input = fixture(side);
      const before = structuredClone(input);
      const result = sizeMicroBurstLossBudget(input, config);
      expect(result.valid).toBe(true);
      expect(result.maxLoss).toBeLessThanOrEqual(input.lossBudget);
      expect(result.marginRequired).toBeLessThanOrEqual(input.marginBudget);
      expect(result.quantity).toBeLessThanOrEqual(100);
      expect(input).toEqual(before);
    },
  );
  it('20x to explicitly approved 30x changes margin, not the loss-sized quantity', () => {
    const input = fixture();
    const at20 = sizeMicroBurstLossBudget(input, config);
    input.intent.leverage = 30;
    expect(sizeMicroBurstLossBudget(input, config).reason).toBe('MICRO_LEVERAGE_NOT_APPROVED');
    input.approvedLeverageCap = 30;
    const at30 = sizeMicroBurstLossBudget(input, config);
    expect(at30.valid).toBe(true);
    expect(at30.quantity).toBe(at20.quantity);
    expect(at30.maxLoss).toBe(at20.maxLoss);
    expect(at30.marginRequired).toBeLessThan(at20.marginRequired);
    input.intent.leverage = 40;
    input.approvedLeverageCap = 40;
    expect(sizeMicroBurstLossBudget(input, config).valid).toBe(false);
  });
  it.each([undefined, NaN, 0, -1, Infinity])('requires a finite explicit budget %s', (budget) => {
    expect(
      sizeMicroBurstLossBudget({ ...fixture(), lossBudget: budget as number }, config).reason,
    ).toBe('MICRO_EXPLICIT_LOSS_BUDGET_REQUIRED');
  });
  it('higher stress cannot increase size and never moves structural stop', () => {
    const input = fixture();
    const base = sizeMicroBurstLossBudget(input, config);
    input.stopStressBps = 30;
    input.residualCostBps = 28;
    const stress = sizeMicroBurstLossBudget(input, config);
    expect(stress.valid).toBe(true);
    expect(stress.quantity).toBeLessThan(base.quantity);
    expect(input.intent.structuralStopPrice).toBe(99.5);
  });
  it('rejects liquidation before the stressed stop and never rounds up to minimum', () => {
    const input = fixture();
    input.liquidationPrice = 99.45;
    expect(sizeMicroBurstLossBudget(input, config).reason).toBe('MICRO_LIQUIDATION_BOUND_UNSAFE');
    input.liquidationPrice = 95;
    input.lossBudget = 0.00001;
    expect(sizeMicroBurstLossBudget(input, config).valid).toBe(false);
  });
  it('caps retries and final visible depth and rejects stale executable inputs', () => {
    const input = fixture();
    input.maxQuantity = 0.5;
    expect(sizeMicroBurstLossBudget(input, config).quantity).toBe(0.5);
    input.book!.askDepth[0].qty = 0.3;
    expect(sizeMicroBurstLossBudget(input, config).quantity).toBe(0.3);
    input.book!.observedAtMs -= config.bookFreshnessMaxMs + 1;
    expect(sizeMicroBurstLossBudget(input, config).reason).toBe('MICRO_EXECUTABLE_BOOK_NOT_FRESH');
  });
});
