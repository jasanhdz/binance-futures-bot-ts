import { describe, expect, it } from 'vitest';
import { microBurstExecutableExitEconomics } from './MicroBurstExecutableExitEconomics';
import { defaultMicroBurstConfig, type OrderBookSnapshot } from './MicroBurstTypes';

const config = defaultMicroBurstConfig();
const book: OrderBookSnapshot = {
  observedAtMs: 1000,
  status: 'HEALTHY',
  bidDepth: [
    { price: 100, qty: 1 },
    { price: 99.9, qty: 1 },
  ],
  askDepth: [
    { price: 100.01, qty: 1 },
    { price: 100.1, qty: 1 },
  ],
};
describe('Micro executable exit economics', () => {
  it.each(['LONG', 'SHORT'] as const)(
    'prices the full %s liquidation side, not the last trade',
    (side) => {
      const result = microBurstExecutableExitEconomics(
        { book, side, quantity: 2, observedAtMs: 2000, residualCostBps: 14, volatilityBps: 3 },
        config,
      );
      expect(result?.exitPrice).toBeCloseTo(side === 'LONG' ? 99.95 : 100.055);
      expect(result?.observedAtMs).toBe(1000);
      expect(result?.residualCostBps).toBe(14);
    },
  );
  it.each([3, NaN, 0, -1])(
    'does not fabricate a quote for uncovered or invalid quantity %s',
    (quantity) => {
      expect(
        microBurstExecutableExitEconomics(
          {
            book,
            side: 'LONG',
            quantity,
            observedAtMs: 2000,
            residualCostBps: 14,
            volatilityBps: 3,
          },
          config,
        ),
      ).toBeNull();
    },
  );
  it('fails closed for stale/future books and unspecified costs/volatility', () => {
    for (const overrides of [
      { observedAtMs: 0 },
      { observedAtMs: 20_000 },
      { residualCostBps: NaN },
      { volatilityBps: NaN },
    ]) {
      expect(
        microBurstExecutableExitEconomics(
          {
            book,
            side: 'LONG',
            quantity: 1,
            observedAtMs: 2000,
            residualCostBps: 14,
            volatilityBps: 3,
            ...overrides,
          },
          config,
        ),
      ).toBeNull();
    }
  });
});
