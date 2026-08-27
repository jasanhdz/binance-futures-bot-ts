import { describe, expect, it } from 'vitest';
import {
  sideAwareReturnBps,
  computeHorizonOutcome,
  computeAllHorizons,
  aggregateBarrierOutcome,
  computeCostScenarios,
  computeEntryModels,
  simulateDynamicExit,
  createPendingOutcome,
  freezeSignalSnapshot,
  OUTCOME_HORIZONS_MS,
} from './MicroBurstOutcomeEngine';
import { ShadowSignalSnapshot, CostScenario } from './MicroBurstOutcomeTypes';
import { defaultMicroBurstConfig } from './MicroBurstTypes';

// ── Fixtures ───────────────────────────────────────────────

function makeSignal(overrides: Partial<ShadowSignalSnapshot> = {}): ShadowSignalSnapshot {
  return freezeSignalSnapshot({
    shadowSignalId: 'shadow-MICRO_BURST_V1-BTCUSDT-LONG-79000-1700000000',
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

function makeShortSignal(overrides: Partial<ShadowSignalSnapshot> = {}): ShadowSignalSnapshot {
  return makeSignal({
    side: 'SHORT',
    shadowSignalId: 'shadow-MICRO_BURST_V1-BTCUSDT-SHORT-79000-1700000000',
    structuralStopPrice: 79500,
    destinationPrice: 78500,
    support: 78400,
    resistance: 79200,
    momentum: { direction: 'SHORT', strength: 0.7, continuationScore: 0.6 },
    ...overrides,
  });
}

// ── Side-Aware Returns ─────────────────────────────────────

describe('MicroBurstOutcomeEngine side-aware returns', () => {
  it('LONG: positive return when price goes up', () => {
    expect(sideAwareReturnBps(100, 101, 'LONG')).toBeCloseTo(100, 1);
  });

  it('LONG: negative return when price goes down', () => {
    expect(sideAwareReturnBps(100, 99, 'LONG')).toBeCloseTo(-100, 1);
  });

  it('SHORT: positive return when price goes down', () => {
    expect(sideAwareReturnBps(100, 99, 'SHORT')).toBeCloseTo(100, 1);
  });

  it('SHORT: negative return when price goes up', () => {
    expect(sideAwareReturnBps(100, 101, 'SHORT')).toBeCloseTo(-100, 1);
  });

  it('returns NaN for invalid prices', () => {
    expect(Number.isNaN(sideAwareReturnBps(0, 100, 'LONG'))).toBe(true);
    expect(Number.isNaN(sideAwareReturnBps(100, 0, 'LONG'))).toBe(true);
    expect(Number.isNaN(sideAwareReturnBps(NaN, 100, 'LONG'))).toBe(true);
  });
});

// ── Horizon MFE/MAE ────────────────────────────────────────

describe('MicroBurstOutcomeEngine horizon outcomes', () => {
  it('computes MFE and MAE correctly for LONG', () => {
    const signal = makeSignal();
    const entryPrice = 79000;
    const priceHistory = [
      { eventTime: 1_001_000, price: 79100 }, // +12.6 bps favorable
      { eventTime: 1_002_000, price: 78800 }, // -25.3 bps adverse
      { eventTime: 1_003_000, price: 79200 }, // +25.3 bps favorable (new MFE)
    ];

    const outcome = computeHorizonOutcome(signal, entryPrice, priceHistory, 60_000);

    expect(outcome.mfeBps).toBeCloseTo(25.3, 0);
    expect(outcome.maeBps).toBeCloseTo(25.3, 0);
    expect(outcome.tradeCount).toBe(3);
  });

  it('computes MFE and MAE correctly for SHORT', () => {
    const signal = makeShortSignal();
    const entryPrice = 79000;
    const priceHistory = [
      { eventTime: 1_001_000, price: 78900 }, // favorable (down)
      { eventTime: 1_002_000, price: 79100 }, // adverse (up)
      { eventTime: 1_003_000, price: 78700 }, // more favorable (new MFE)
    ];

    const outcome = computeHorizonOutcome(signal, entryPrice, priceHistory, 60_000);

    expect(outcome.mfeBps).toBeGreaterThan(0);
    expect(outcome.maeBps).toBeGreaterThan(0);
    expect(outcome.tradeCount).toBe(3);
  });

  it('returns zero outcome when no trades in horizon', () => {
    const signal = makeSignal();
    const outcome = computeHorizonOutcome(signal, 79000, [], 60_000);

    expect(outcome.mfeBps).toBe(0);
    expect(outcome.maeBps).toBe(0);
    expect(outcome.tradeCount).toBe(0);
    expect(outcome.barrierOutcome).toBe('NEITHER');
  });

  it('filters trades outside horizon window', () => {
    const signal = makeSignal({ signalAtMs: 1_000_000 });
    const priceHistory = [
      { eventTime: 900_000, price: 80000 }, // before T0
      { eventTime: 1_001_000, price: 79100 }, // within 15s
      { eventTime: 1_020_000, price: 79200 }, // beyond 15s
    ];

    const outcome = computeHorizonOutcome(signal, 79000, priceHistory, 15_000);
    expect(outcome.tradeCount).toBe(1); // only the 1_001_000 trade
  });
});

// ── First Touch Detection ──────────────────────────────────

describe('MicroBurstOutcomeEngine first-touch', () => {
  it('TARGET_FIRST: target reached before stop for LONG', () => {
    const signal = makeSignal({ structuralStopPrice: 78500, destinationPrice: 79500 });
    const priceHistory = [
      { eventTime: 1_001_000, price: 79600 }, // target touched
      { eventTime: 1_002_000, price: 78400 }, // stop touched later
    ];

    const outcome = computeHorizonOutcome(signal, 79000, priceHistory, 60_000);
    expect(outcome.barrierOutcome).toBe('TARGET_FIRST');
    expect(outcome.targetTouched).toBe(true);
    expect(outcome.stopTouched).toBe(true);
  });

  it('STOP_FIRST: stop reached before target for LONG', () => {
    const signal = makeSignal({ structuralStopPrice: 78500, destinationPrice: 79500 });
    const priceHistory = [
      { eventTime: 1_001_000, price: 78400 }, // stop touched first
      { eventTime: 1_002_000, price: 79600 }, // target touched later
    ];

    const outcome = computeHorizonOutcome(signal, 79000, priceHistory, 60_000);
    expect(outcome.barrierOutcome).toBe('STOP_FIRST');
  });

  it('NEITHER: neither stop nor target touched', () => {
    const signal = makeSignal({ structuralStopPrice: 78500, destinationPrice: 79500 });
    const priceHistory = [
      { eventTime: 1_001_000, price: 79100 },
      { eventTime: 1_002_000, price: 79200 },
    ];

    const outcome = computeHorizonOutcome(signal, 79000, priceHistory, 60_000);
    expect(outcome.barrierOutcome).toBe('NEITHER');
    expect(outcome.stopTouched).toBe(false);
    expect(outcome.targetTouched).toBe(false);
  });

  it('AMBIGUOUS: both touched at same eventTime', () => {
    const signal = makeSignal({ structuralStopPrice: 78500, destinationPrice: 79500 });
    const priceHistory = [
      { eventTime: 1_001_000, price: 78400 }, // stop and target both possible at this price? No...
      // For AMBIGUOUS we need both touched but ordering unclear
      // Actually with trade-level data, if both are touched in same event,
      // the price can't be both <=78500 and >=79500 simultaneously.
      // AMBIGUOUS_SAME_INTERVAL happens when both barriers are touched
      // within the same interval but ordering can't be resolved.
      { eventTime: 1_001_000, price: 78400 }, // stop
      { eventTime: 1_001_000, price: 79600 }, // target (same eventTime)
    ];

    const outcome = computeHorizonOutcome(signal, 79000, priceHistory, 60_000);
    // Both touched, same timestamp → AMBIGUOUS
    expect(outcome.barrierOutcome).toBe('AMBIGUOUS_SAME_INTERVAL');
  });

  it('SHORT: target-first when price drops to target', () => {
    const signal = makeShortSignal({ structuralStopPrice: 79500, destinationPrice: 78500 });
    const priceHistory = [
      { eventTime: 1_001_000, price: 78400 }, // target touched (SHORT: price <= target)
      { eventTime: 1_002_000, price: 79600 }, // stop touched later (SHORT: price >= stop)
    ];

    const outcome = computeHorizonOutcome(signal, 79000, priceHistory, 60_000);
    expect(outcome.barrierOutcome).toBe('TARGET_FIRST');
  });
});

// ── All Horizons ───────────────────────────────────────────

describe('MicroBurstOutcomeEngine all horizons', () => {
  it('returns outcomes for all 5 horizons', () => {
    const signal = makeSignal();
    const priceHistory = [
      { eventTime: 1_001_000, price: 79100 },
      { eventTime: 1_030_000, price: 79200 },
      { eventTime: 1_060_000, price: 79300 },
      { eventTime: 1_120_000, price: 79400 },
      { eventTime: 1_300_000, price: 79500 },
    ];

    const horizons = computeAllHorizons(signal, 79000, priceHistory);
    expect(Object.keys(horizons)).toHaveLength(5);
    expect(horizons[15_000]).toBeDefined();
    expect(horizons[30_000]).toBeDefined();
    expect(horizons[60_000]).toBeDefined();
    expect(horizons[120_000]).toBeDefined();
    expect(horizons[300_000]).toBeDefined();
  });
});

// ── Barrier Aggregation ────────────────────────────────────

describe('MicroBurstOutcomeEngine barrier aggregation', () => {
  it('TARGET_FIRST if any horizon has target-first', () => {
    const horizons = {
      15000: { barrierOutcome: 'NEITHER' as const },
      30000: { barrierOutcome: 'TARGET_FIRST' as const },
      60000: { barrierOutcome: 'NEITHER' as const },
    };
    expect(aggregateBarrierOutcome(horizons as any)).toBe('TARGET_FIRST');
  });

  it('STOP_FIRST if any horizon has stop-first', () => {
    const horizons = {
      15000: { barrierOutcome: 'STOP_FIRST' as const },
      30000: { barrierOutcome: 'NEITHER' as const },
    };
    expect(aggregateBarrierOutcome(horizons as any)).toBe('STOP_FIRST');
  });

  it('AMBIGUOUS if both target-first and stop-first across horizons', () => {
    const horizons = {
      15000: { barrierOutcome: 'TARGET_FIRST' as const },
      30000: { barrierOutcome: 'STOP_FIRST' as const },
    };
    expect(aggregateBarrierOutcome(horizons as any)).toBe('AMBIGUOUS_SAME_INTERVAL');
  });

  it('NEITHER if no barriers touched', () => {
    const horizons = {
      15000: { barrierOutcome: 'NEITHER' as const },
      30000: { barrierOutcome: 'NEITHER' as const },
    };
    expect(aggregateBarrierOutcome(horizons as any)).toBe('NEITHER');
  });
});

// ── Cost Scenarios ─────────────────────────────────────────

describe('MicroBurstOutcomeEngine cost scenarios', () => {
  it('computes net returns for each scenario', () => {
    const scenarios: CostScenario[] = [
      { label: 'cost_0', feeBps: 0, slippageBps: 0 },
      { label: 'cost_14', feeBps: 10, slippageBps: 4 },
      { label: 'cost_30', feeBps: 20, slippageBps: 10 },
    ];
    const result = computeCostScenarios(50, scenarios);
    expect(result.cost_0).toBe(50);
    expect(result.cost_14).toBe(36);
    expect(result.cost_30).toBe(20);
  });

  it('handles zero gross', () => {
    const result = computeCostScenarios(0, [{ label: 'free', feeBps: 0, slippageBps: 0 }]);
    expect(result.free).toBe(0);
  });

  it('handles negative gross (loss)', () => {
    const result = computeCostScenarios(-30, [{ label: 'cost_14', feeBps: 10, slippageBps: 4 }]);
    expect(result.cost_14).toBe(-44);
  });
});

// ── Entry Price Models ─────────────────────────────────────

describe('MicroBurstOutcomeEngine entry models', () => {
  it('always includes SIGNAL_PRICE and CONSERVATIVE_SLIPPAGE', () => {
    const signal = makeSignal();
    const models = computeEntryModels(signal, []);
    expect(models.some((m) => m.model === 'SIGNAL_PRICE')).toBe(true);
    expect(models.some((m) => m.model === 'CONSERVATIVE_SLIPPAGE')).toBe(true);
  });

  it('SIGNAL_PRICE uses market price at signal', () => {
    const signal = makeSignal({ marketPriceAtSignal: 79000 });
    const models = computeEntryModels(signal, []);
    const signalModel = models.find((m) => m.model === 'SIGNAL_PRICE');
    expect(signalModel?.entryPrice).toBe(79000);
  });

  it('NEXT_TRADE uses first valid trade after signal', () => {
    const signal = makeSignal({ signalAtMs: 1_000_000 });
    const priceHistory = [
      { eventTime: 999_000, price: 78900 }, // before signal
      { eventTime: 1_001_000, price: 79050 }, // first after signal
      { eventTime: 1_002_000, price: 79100 },
    ];
    const models = computeEntryModels(signal, priceHistory);
    const nextTrade = models.find((m) => m.model === 'NEXT_TRADE');
    expect(nextTrade?.entryPrice).toBe(79050);
  });

  it('CONSERVATIVE_SLIPPAGE adds buffer for LONG', () => {
    const signal = makeSignal({ side: 'LONG', marketPriceAtSignal: 79000 });
    const models = computeEntryModels(signal, []);
    const slippage = models.find((m) => m.model === 'CONSERVATIVE_SLIPPAGE');
    expect(slippage!.entryPrice).toBeGreaterThan(79000);
  });

  it('CONSERVATIVE_SLIPPAGE subtracts buffer for SHORT', () => {
    const signal = makeSignal({ side: 'SHORT', marketPriceAtSignal: 79000 });
    const models = computeEntryModels(signal, []);
    const slippage = models.find((m) => m.model === 'CONSERVATIVE_SLIPPAGE');
    expect(slippage!.entryPrice).toBeLessThan(79000);
  });
});

// ── Dynamic Exit Simulation ────────────────────────────────

describe('MicroBurstOutcomeEngine dynamic exit simulation', () => {
  it('returns null when no price history', () => {
    const signal = makeSignal();
    const result = simulateDynamicExit(signal, 79000, []);
    expect(result).toBeNull();
  });

  it('detects HARD_INVALIDATION for LONG when price drops below stop', () => {
    const signal = makeSignal({ structuralStopPrice: 78500, destinationPrice: 79500 });
    const priceHistory = [{ eventTime: 1_001_000, price: 78400 }];
    const result = simulateDynamicExit(signal, 79000, priceHistory);
    expect(result?.counterfactualExitReason).toBe('HARD_INVALIDATION');
  });

  it('detects TARGET for LONG when price reaches destination', () => {
    const signal = makeSignal({ structuralStopPrice: 78500, destinationPrice: 79500 });
    const priceHistory = [{ eventTime: 1_001_000, price: 79600 }];
    const result = simulateDynamicExit(signal, 79000, priceHistory);
    expect(result?.counterfactualExitReason).toBe('TARGET');
  });

  it('returns HOLD_AT_HORIZON when no exit triggered', () => {
    const signal = makeSignal({ structuralStopPrice: 78500, destinationPrice: 79500 });
    const priceHistory = [
      { eventTime: 1_001_000, price: 79100 },
      { eventTime: 1_002_000, price: 79200 },
    ];
    const result = simulateDynamicExit(signal, 79000, priceHistory);
    expect(result?.counterfactualExitReason).toBe('HOLD_AT_HORIZON');
  });

  it('SHORT: detects HARD_INVALIDATION when price rises above stop', () => {
    const signal = makeShortSignal({ structuralStopPrice: 79500, destinationPrice: 78500 });
    const priceHistory = [{ eventTime: 1_001_000, price: 79600 }];
    const result = simulateDynamicExit(signal, 79000, priceHistory);
    expect(result?.counterfactualExitReason).toBe('HARD_INVALIDATION');
  });

  it('SHORT: detects TARGET when price drops to destination', () => {
    const signal = makeShortSignal({ structuralStopPrice: 79500, destinationPrice: 78500 });
    const priceHistory = [{ eventTime: 1_001_000, price: 78400 }];
    const result = simulateDynamicExit(signal, 79000, priceHistory);
    expect(result?.counterfactualExitReason).toBe('TARGET');
  });

  it('closes a LONG on a later break-even touch and ignores later prices', () => {
    const config = {
      ...defaultMicroBurstConfig(),
      exitBreakEvenActivationBps: 10,
      exitTrailingActivationBps: 1_000,
    };
    const result = simulateDynamicExit(
      makeSignal(),
      79000,
      [
        { eventTime: 1_001_000, price: 79100 },
        { eventTime: 1_002_000, price: 79000 },
        { eventTime: 1_003_000, price: 80000 },
      ],
      config,
    );
    expect(result?.counterfactualExitReason).toBe('BREAK_EVEN');
    expect(result?.counterfactualExitPrice).toBe(79000);
  });

  it('closes a SHORT on a later break-even touch', () => {
    const config = {
      ...defaultMicroBurstConfig(),
      exitBreakEvenActivationBps: 10,
      exitTrailingActivationBps: 1_000,
    };
    const result = simulateDynamicExit(
      makeShortSignal(),
      79000,
      [
        { eventTime: 1_001_000, price: 78900 },
        { eventTime: 1_002_000, price: 79000 },
      ],
      config,
    );
    expect(result?.counterfactualExitReason).toBe('BREAK_EVEN');
  });
});

describe('MicroBurstOutcomeEngine high-frequency horizons', () => {
  it('preserves an early first touch across more than 10k events and freezes horizons', () => {
    const signal = makeSignal({ structuralStopPrice: 78500, destinationPrice: 79500 });
    const prices = Array.from({ length: 10_501 }, (_, index) => ({
      eventTime: signal.signalAtMs + 1 + Math.floor((index * 300_000) / 10_500),
      price: index === 1 ? 79600 : 79000,
    })).reverse();
    const horizons = computeAllHorizons(signal, 79000, prices);
    expect(horizons[300_000].barrierOutcome).toBe('TARGET_FIRST');
    expect(horizons[300_000].firstTouchAtMs).toBe(
      signal.signalAtMs + 1 + Math.floor(300_000 / 10_500),
    );
    expect(Object.isFrozen(horizons)).toBe(true);
    expect(Object.isFrozen(horizons[300_000])).toBe(true);
  });
});

// ── Freeze Snapshot ────────────────────────────────────────

describe('MicroBurstOutcomeEngine freeze snapshot', () => {
  it('creates immutable signal snapshot', () => {
    const snapshot = freezeSignalSnapshot({
      shadowSignalId: 'test-001',
      strategyId: 'MICRO_BURST_V1',
      strategyVersion: '0.4.0-prospective-validation',
      codeCommitSha: 'abc123',
      configHash: 'hash-1',
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
    });

    expect(snapshot.shadowSignalId).toBe('test-001');
    expect(snapshot.symbol).toBe('BTCUSDT');
    expect(snapshot.side).toBe('LONG');
    expect(snapshot.signalAtMs).toBe(1_000_000);
    expect(snapshot.marketPriceAtSignal).toBe(79000);
    expect(snapshot.structuralStopPrice).toBe(78500);
    expect(snapshot.destinationPrice).toBe(79500);
  });
});

// ── Pending Outcome ────────────────────────────────────────

describe('MicroBurstOutcomeEngine pending outcome', () => {
  it('initializes with all horizons pending', () => {
    const signal = makeSignal();
    const pending = createPendingOutcome(signal, 'episode-1');
    expect(pending.pendingHorizons.size).toBe(OUTCOME_HORIZONS_MS.length);
    expect(pending.completedHorizons.size).toBe(0);
    expect(pending.signal).toBe(signal);
    expect(pending.episodeId).toBe('episode-1');
  });
});
