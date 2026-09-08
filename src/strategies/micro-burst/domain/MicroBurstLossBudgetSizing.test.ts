import { describe, expect, it } from 'vitest';
import {
  sizeMicroBurstLossBudget,
  type MicroBurstLossBudgetInput,
  type MicroBurstMarginFractionInput,
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

describe('Micro explicit margin-fraction proposal', () => {
  function marginFixture(side: 'LONG' | 'SHORT' = 'LONG'): MicroBurstMarginFractionInput {
    const { marginBudget, lossBudget, sizingMode, ...input } = fixture(side);
    return {
      ...input,
      sizingMode: 'MARGIN_FRACTION',
      availableWallet: 25,
      marginFraction: 0.9,
      feeReserveBps: 14,
      approvedLeverageCap: 30,
    };
  }

  it.each(['LONG', 'SHORT'] as const)('funds %s margin and costs without a loss cap', (side) => {
    const input = marginFixture(side);
    const before = structuredClone(input);
    const result = sizeMicroBurstLossBudget(input, config);
    expect(result.valid).toBe(true);
    expect(
      result.marginRequired + (result.notional * input.feeReserveBps) / 10_000,
    ).toBeLessThanOrEqual(25 * 0.9);
    expect(result.maxLoss).toBeGreaterThan(2);
    expect(input).toEqual(before);
  });

  it('reports greater estimated loss at 30x, not a fabricated fixed loss budget', () => {
    const input = marginFixture();
    const at20 = sizeMicroBurstLossBudget(input, config);
    input.intent.leverage = 30;
    const at30 = sizeMicroBurstLossBudget(input, config);
    expect(at30.valid).toBe(true);
    expect(at30.quantity).toBeGreaterThan(at20.quantity);
    expect(at30.maxLoss).toBeGreaterThan(at20.maxLoss!);
    expect(
      at30.marginRequired + (at30.notional * input.feeReserveBps) / 10_000,
    ).toBeLessThanOrEqual(22.5);
  });

  it.each([1, 19, 21, 29, 40])('rejects unapproved tier %s', (leverage) => {
    const input = marginFixture();
    input.intent.leverage = leverage;
    expect(sizeMicroBurstLossBudget(input, config).reason).toBe('MICRO_LEVERAGE_NOT_APPROVED');
  });

  it.each([
    { availableWallet: NaN },
    { availableWallet: Infinity },
    { availableWallet: 0 },
    { marginFraction: 0.91 },
    { marginFraction: 0 },
    { marginFraction: NaN },
    { feeReserveBps: 0 },
    { feeReserveBps: 13 },
    { feeReserveBps: NaN },
  ])('rejects invalid allocation or unfunded costs %j', (override) => {
    expect(sizeMicroBurstLossBudget({ ...marginFixture(), ...override }, config).reason).toBe(
      'MICRO_MARGIN_FRACTION_INVALID',
    );
  });

  it('rejects conflicting or unknown sizing modes at the runtime boundary', () => {
    for (const override of [{ lossBudget: 2 }, { marginBudget: 22.5 }]) {
      const input = { ...marginFixture(), ...override } as unknown as MicroBurstMarginFractionInput;
      expect(sizeMicroBurstLossBudget(input, config).reason).toBe('MICRO_SIZING_MODE_CONFLICT');
    }
    const input = {
      ...marginFixture(),
      sizingMode: 'AUTO',
    } as unknown as MicroBurstMarginFractionInput;
    expect(sizeMicroBurstLossBudget(input, config).reason).toBe('MICRO_SIZING_MODE_INVALID');
  });

  it('retains liquidation, book freshness, depth, retry and minimum filters', () => {
    const input = marginFixture();
    input.liquidationPrice = 99.45;
    expect(sizeMicroBurstLossBudget(input, config).reason).toBe('MICRO_LIQUIDATION_BOUND_UNSAFE');
    input.liquidationPrice = 95;
    input.maxQuantity = 0.5;
    expect(sizeMicroBurstLossBudget(input, config).quantity).toBe(0.5);
    input.book!.askDepth[0].qty = 0.3;
    expect(sizeMicroBurstLossBudget(input, config).quantity).toBe(0.3);
    input.minNotional = 31;
    expect(sizeMicroBurstLossBudget(input, config).reason).toBe('BELOW_MIN_NOTIONAL');
    input.minNotional = 5;
    input.book!.observedAtMs -= config.bookFreshnessMaxMs + 1;
    expect(sizeMicroBurstLossBudget(input, config).reason).toBe('MICRO_EXECUTABLE_BOOK_NOT_FRESH');
  });
});
