import { describe, expect, it } from 'vitest';
import {
  calculateMicroBurstEconomicContract,
  resolveMicroBurstExecutablePrice,
  roundEconomicAmount,
  type EconomicDatum,
  type MicroBurstEconomicInput,
} from './MicroBurstEconomicContract';

const datum = <T>(value: T, source = 'test', observedAtMs = 1_000, quality: EconomicDatum<T>['quality'] = 'ACTUAL'): EconomicDatum<T> => ({
  value,
  source,
  observedAtMs,
  receivedAtMs: observedAtMs,
  quality,
});

function input(side: 'LONG' | 'SHORT', overrides: Partial<MicroBurstEconomicInput> = {}): MicroBurstEconomicInput {
  return {
    asOfMs: 2_000,
    side,
    entry: {
      price: datum(100, 'entry-vwap'),
      quantity: datum(2, 'entry-fills'),
      priceIncludesSlippage: true,
    },
    exit: {
      price: datum(100, 'exit-book'),
      quantity: datum(2, 'exit-coverage'),
      priceIncludesSlippage: true,
    },
    funding: datum(0, 'funding-query'),
    entryCommission: datum(1, 'entry-fee'),
    exitCommission: datum(1, 'exit-fee', 1_000, 'ESTIMATED'),
    structuralInvalidationPrice: datum(side === 'LONG' ? 98 : 102, 'stop'),
    favorableObstaclePrice: datum(side === 'LONG' ? 104 : 96, 'obstacle'),
    maxAgeMs: 2_000,
    ...overrides,
  };
}

describe('MicroBurst shared economic contract', () => {
  it.each(['LONG', 'SHORT'] as const)('charges both commissions at unchanged prices for %s', (side) => {
    const result = calculateMicroBurstEconomicContract(input(side));
    expect(result).toMatchObject({ status: 'AVAILABLE' });
    if (result.status === 'AVAILABLE') {
      expect(result.value.grossPnlUsdt).toBe(0);
      expect(result.value.netPnlUsdt).toBe(-2);
      expect(result.value.incremental.closeNowNetUsdt).toBe(-1);
      expect(result.value.breakEvenExitPrice).toBe(side === 'LONG' ? 101 : 99);
    }
  });

  it.each(['LONG', 'SHORT'] as const)('does not treat an insufficient favorable move as profit after costs for %s', (side) => {
    const result = calculateMicroBurstEconomicContract(input(side, {
      favorableObstaclePrice: datum(side === 'LONG' ? 100.5 : 99.5, 'near-obstacle'),
    }));
    expect(result.status).toBe('AVAILABLE');
    if (result.status === 'AVAILABLE') {
      expect(result.value.favorablePathGrossUsdt).toBe(1);
      expect(result.value.favorablePathNetUsdt).toBe(0);
    }
  });

  it('uses signed funding cashflow exactly once', () => {
    const positive = calculateMicroBurstEconomicContract(input('LONG', { funding: datum(0.5, 'funding-rebate') }));
    const negative = calculateMicroBurstEconomicContract(input('LONG', { funding: datum(-0.5, 'funding-charge') }));
    expect(positive.status === 'AVAILABLE' && positive.value.netPnlUsdt).toBe(-1.5);
    expect(negative.status === 'AVAILABLE' && negative.value.netPnlUsdt).toBe(-2.5);
  });

  it('prices complete depth and rejects uncovered depth', () => {
    const priced = resolveMicroBurstExecutablePrice({
      side: 'LONG', quantity: 3, depth: [{ price: 100, qty: 1 }, { price: 99, qty: 2 }],
      observedAtMs: 1_000, asOfMs: 2_000, maxAgeMs: 2_000,
    });
    expect(priced).toEqual({ status: 'AVAILABLE', value: 99.33333333333333 });
    expect(resolveMicroBurstExecutablePrice({
      side: 'SHORT', quantity: 4, depth: [{ price: 100, qty: 3 }],
      observedAtMs: 1_000, asOfMs: 2_000, maxAgeMs: 2_000,
    })).toMatchObject({ status: 'UNAVAILABLE', reason: 'INSUFFICIENT_DEPTH' });
  });

  it.each([
    ['missing', undefined],
    ['stale', datum(100, 'stale', -1)],
    ['future', datum(100, 'future', 3_000)],
    ['invalid', datum(Number.NaN, 'invalid')],
  ] as const)('returns UNAVAILABLE for %s prices', (_label, price) => {
    const result = calculateMicroBurstEconomicContract(input('LONG', {
      exit: { price: price as EconomicDatum<number>, quantity: datum(2), priceIncludesSlippage: true },
    }));
    expect(result.status).toBe('UNAVAILABLE');
  });

  it('does not double count slippage already present in executable prices', () => {
    const included = calculateMicroBurstEconomicContract(input('LONG', {
      entry: { price: datum(101), quantity: datum(2), slippageBps: datum(5), priceIncludesSlippage: true },
      exit: { price: datum(99), quantity: datum(2), slippageBps: datum(5), priceIncludesSlippage: true },
    }));
    const applied = calculateMicroBurstEconomicContract(input('LONG', {
      entry: { price: datum(100), quantity: datum(2), slippageBps: datum(5), priceIncludesSlippage: false },
      exit: { price: datum(100), quantity: datum(2), slippageBps: datum(5), priceIncludesSlippage: false },
    }));
    expect(included.status === 'AVAILABLE' && included.value.slippageUsdt).toBe(0);
    expect(applied.status === 'AVAILABLE' && applied.value.slippageUsdt).toBeCloseTo(-0.2, 12);
  });

  it('preserves provenance, estimated quality, and explicit rounding', () => {
    const result = calculateMicroBurstEconomicContract(input('LONG'));
    expect(result.status === 'AVAILABLE' && result.value.provenance.exitCommission.quality).toBe('ESTIMATED');
    expect(roundEconomicAmount(1 / 3, 4)).toBe(0.3333);
    expect(roundEconomicAmount(1.005, 2)).toBe(1.01);
  });

  it('does not invent slippage when an input price excludes it', () => {
    const result = calculateMicroBurstEconomicContract(input('LONG', {
      exit: { price: datum(100), quantity: datum(2), priceIncludesSlippage: false },
    }));
    expect(result).toMatchObject({ status: 'UNAVAILABLE', reason: 'MISSING_INPUT' });
  });

  it('reconciles the five local Binance-derived settlements without double charging', () => {
    const settlements = [
      ['SUI', 'SHORT', 779, 0.8132, 0.8127, 0.3167414, 0.31654665, 0.3895, -0.24378805],
      ['LTC', 'SHORT', 10.71, 58.55509710550887, 58.56, 0.31356254, 0.3135888, -0.05250998, -0.67966132],
      ['DOGE', 'SHORT', 6877, 0.08864, 0.08888, 0.30478863, 0.30561387, -1.65048, -2.2608825],
      ['AVAX', 'SHORT', 58, 9.337, 9.314, 0.270773, 0.270106, 1.334, 0.793121],
      ['XRP', 'LONG', 398.5, 1.4324, 1.4312, 0.28540568, 0.2851666, -0.4782, -1.04877228],
    ] as const;
    for (const [symbol, side, quantity, entryPrice, exitPrice, entryFee, exitFee, gross, net] of settlements) {
      const result = calculateMicroBurstEconomicContract(input(side, {
        entry: { price: datum(entryPrice, `local-ledger:${symbol}:entry`), quantity: datum(quantity), priceIncludesSlippage: true },
        exit: { price: datum(exitPrice, `local-ledger:${symbol}:exit`), quantity: datum(quantity), priceIncludesSlippage: true },
        entryCommission: datum(entryFee, `local-ledger:${symbol}:entry-fee`),
        exitCommission: datum(exitFee, `local-ledger:${symbol}:exit-fee`),
        funding: datum(0, `local-ledger:${symbol}:funding`),
      }));
      expect(result.status).toBe('AVAILABLE');
      if (result.status === 'AVAILABLE') {
        expect(result.value.grossPnlUsdt).toBeCloseTo(gross, 6);
        expect(result.value.netPnlUsdt).toBeCloseTo(net, 6);
      }
    }
  });
});
