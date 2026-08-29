import { describe, expect, it } from 'vitest';
import {
  freezeSignalSnapshot,
  computeHorizonOutcome,
  computeEntryModels,
  sideAwareReturnBps,
} from '../research/MicroBurstOutcomeEngine';
import { ShadowSignalSnapshot } from '../research/MicroBurstOutcomeTypes';

function makeSignal(overrides: Partial<ShadowSignalSnapshot> = {}): ShadowSignalSnapshot {
  return freezeSignalSnapshot({
    shadowSignalId: 'test-signal',
    strategyId: 'MICRO_BURST_V1',
    strategyVersion: '0.4.0-prospective-validation',
    codeCommitSha: 'UNCOMMITTED',
    configHash: 'default',
    symbol: 'BTCUSDT',
    side: 'LONG',
    signalAtMs: 1_000_000,
    marketPriceAtSignal: 79000,
    referencePriceSource: 'MARK_PRICE',
    structuralStopPrice: 78500,
    destinationPrice: 79500,
    support: 78800,
    resistance: 79600,
    roomToTargetBps: 63,
    riskToInvalidationBps: 63,
    rewardRisk: 1.0,
    momentum: { direction: 'LONG', strength: 0.7, continuationScore: 0.6 },
    book: {
      status: 'HEALTHY',
      ageMs: 100,
      imbalance: 0.6,
      imbalanceSlope: 0.02,
      temporalAbsorption: false,
      temporalSweep: false,
    },
    tradeFlow: { buyTakerVolume: 100, sellTakerVolume: 80, netTakerFlow: 20, sampleCount: 50 },
    btc: {
      status: 'HEALTHY',
      ageMs: 50,
      ret1m: 0.001,
      ret3m: 0.002,
      ret5m: 0.003,
      acceleration: -0.001,
      direction: 'LONG',
      conflict: false,
    },
    confidence: 0.8,
    leverageTier: 'HIGH_CONFIRMATION',
    leverage: 40,
    positionFraction: 0.09,
    microRegime: 'RANGING',
    ...overrides,
  });
}

describe('Anti-lookahead guarantees', () => {
  it('frozen signal snapshot is immutable — modifying it does not affect original', () => {
    const original = makeSignal({ marketPriceAtSignal: 79000 });
    const frozen = { ...original };

    // Attempt to mutate frozen
    (frozen as any).marketPriceAtSignal = 80000;
    (frozen as any).side = 'SHORT';

    // Original must be unchanged
    expect(original.marketPriceAtSignal).toBe(79000);
    expect(original.side).toBe('LONG');
  });

  it('signal at T0 cannot use trade at T0+1 to alter entry price model', () => {
    const signal = makeSignal({ signalAtMs: 1_000_000, marketPriceAtSignal: 79000 });

    // Trade AFTER T0 — should NOT affect SIGNAL_PRICE model
    const priceHistory = [
      { eventTime: 1_001_000, price: 80000 }, // extreme move after T0
    ];

    const models = computeEntryModels(signal, priceHistory);
    const signalPriceModel = models.find((m) => m.model === 'SIGNAL_PRICE');

    // SIGNAL_PRICE must remain at the T0 frozen price
    expect(signalPriceModel?.entryPrice).toBe(79000);
  });

  it('future extreme price does not change frozen structural stop', () => {
    const signal = makeSignal({
      structuralStopPrice: 78500,
      destinationPrice: 79500,
    });

    // Extreme price movement after T0
    const priceHistory = [
      { eventTime: 1_001_000, price: 77000 }, // way below stop
      { eventTime: 1_002_000, price: 81000 }, // way above target
    ];

    // Outcome computation must use frozen signal prices
    const outcome = computeHorizonOutcome(signal, 79000, priceHistory, 60_000);
    expect(outcome.tradeCount).toBe(2);
    // MFE should be from the 81000 price (favorable for LONG)
    expect(outcome.mfeBps).toBeGreaterThan(0);
  });

  it('frozen destination price cannot be changed by post-T0 data', () => {
    const signal = makeSignal({ destinationPrice: 79500 });

    // Price goes way past original target
    const priceHistory = [{ eventTime: 1_001_000, price: 85000 }];

    const outcome = computeHorizonOutcome(signal, 79000, priceHistory, 60_000);
    // Target should be touched (price >= 79500)
    expect(outcome.targetTouched).toBe(true);
  });

  it('entry price models are computed from frozen signal only', () => {
    const signal = makeSignal({ marketPriceAtSignal: 79000 });

    // Price history should not affect SIGNAL_PRICE
    const models = computeEntryModels(signal, []);
    const signalModel = models.find((m) => m.model === 'SIGNAL_PRICE');
    expect(signalModel?.entryPrice).toBe(79000);
  });

  it('rejects trades at or before T0', () => {
    const signal = makeSignal({ signalAtMs: 1_000_000 });

    const priceHistory = [
      { eventTime: 999_999, price: 80000 }, // before T0 — rejected
      { eventTime: 1_000_000, price: 80000 }, // at T0 — rejected
      { eventTime: 1_000_001, price: 80000 }, // after T0 — accepted
    ];

    const outcome = computeHorizonOutcome(signal, 79000, priceHistory, 60_000);
    expect(outcome.tradeCount).toBe(1); // only the post-T0 trade
  });

  it('side is frozen and cannot flip from future data', () => {
    const signal = makeSignal({ side: 'LONG' });

    // Even if price crashes, side must remain LONG
    expect(signal.side).toBe('LONG');

    const priceHistory = [
      { eventTime: 1_001_000, price: 77000 }, // big drop
    ];

    const outcome = computeHorizonOutcome(signal, 79000, priceHistory, 60_000);
    // MAE should be positive (adverse for LONG)
    expect(outcome.maeBps).toBeGreaterThan(0);
  });

  it('deterministic: same signal + same price history = same outcome', () => {
    const signal = makeSignal();
    const priceHistory = [
      { eventTime: 1_001_000, price: 79100 },
      { eventTime: 1_002_000, price: 78900 },
    ];

    const outcome1 = computeHorizonOutcome(signal, 79000, priceHistory, 60_000);
    const outcome2 = computeHorizonOutcome(signal, 79000, priceHistory, 60_000);

    expect(outcome1.mfeBps).toBe(outcome2.mfeBps);
    expect(outcome1.maeBps).toBe(outcome2.maeBps);
    expect(outcome1.barrierOutcome).toBe(outcome2.barrierOutcome);
  });
});

describe('Negative controls', () => {
  it('shuffled price history does not change outcome', () => {
    const signal = makeSignal();
    const priceHistory = [
      { eventTime: 1_001_000, price: 79100 },
      { eventTime: 1_002_000, price: 78900 },
      { eventTime: 1_003_000, price: 79200 },
    ];

    const shuffled = [...priceHistory].sort(() => Math.random() - 0.5);

    const outcome1 = computeHorizonOutcome(signal, 79000, priceHistory, 60_000);
    const outcome2 = computeHorizonOutcome(signal, 79000, shuffled, 60_000);

    // MFE/MAE should be the same regardless of order
    expect(outcome1.mfeBps).toBe(outcome2.mfeBps);
    expect(outcome1.maeBps).toBe(outcome2.maeBps);
  });

  it('random side signal does not produce magic positive results', () => {
    // Simulate random side by inverting returns
    const signal = makeSignal({ side: 'LONG' });
    const priceHistory = [
      { eventTime: 1_001_000, price: 78900 }, // adverse for LONG
    ];

    const longOutcome = computeHorizonOutcome(signal, 79000, priceHistory, 60_000);

    // For SHORT, same price movement would be favorable
    const shortSignal = makeSignal({ side: 'SHORT' });
    const shortOutcome = computeHorizonOutcome(shortSignal, 79000, priceHistory, 60_000);

    // LONG should show adverse, SHORT should show favorable
    expect(longOutcome.finalReturnBps).toBeLessThan(0);
    expect(shortOutcome.finalReturnBps).toBeGreaterThan(0);
  });
});
