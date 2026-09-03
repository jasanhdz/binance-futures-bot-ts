import { describe, expect, it } from 'vitest';
import { evaluateMicroBurstExit } from './MicroBurstExitPolicy';
import { makeBtcContext } from './MicroBurst.test-support';
import { defaultMicroBurstConfig, MicroBurstExitContext } from './MicroBurstTypes';

const config = defaultMicroBurstConfig();

function makeExitContext(overrides: Partial<MicroBurstExitContext> = {}): MicroBurstExitContext {
  return {
    unrealizedRoe: 0,
    priceReturn: 0,
    currentPrice: 100,
    entryPrice: 100,
    peakPrice: 100,
    troughPrice: 100,
    structuralInvalidationPrice: 99.8,
    destinationPrice: 102,
    currentStopPrice: null,
    timeInTradeMs: 0,
    momentumDecayFlag: false,
    anomalyExitFlag: false,
    currentBookPressure: null,
    currentBtcContext: null,
    leverage: 20,
    ...overrides,
  };
}

describe('MicroBurstExitPolicy structural invalidation', () => {
  it('closes LONG at or below the structural stop', () => {
    const decision = evaluateMicroBurstExit(
      makeExitContext({ currentPrice: 99.79, troughPrice: 99.79 }),
      config,
      'LONG',
    );
    expect(decision.reason).toBe('HARD_INVALIDATION');
  });

  it('does not hard-invalidate LONG above the structural stop', () => {
    const decision = evaluateMicroBurstExit(
      makeExitContext({ currentPrice: 99.81, troughPrice: 99.81, peakPrice: 100.06 }),
      { ...config, exitImmediateAdverseBps: 100 },
      'LONG',
    );
    expect(decision.reason).not.toBe('HARD_INVALIDATION');
  });

  it('closes SHORT at or above the structural stop', () => {
    const decision = evaluateMicroBurstExit(
      makeExitContext({
        currentPrice: 100.21,
        peakPrice: 100.21,
        structuralInvalidationPrice: 100.2,
        destinationPrice: 98,
      }),
      config,
      'SHORT',
    );
    expect(decision.reason).toBe('HARD_INVALIDATION');
  });

  it('does not hard-invalidate SHORT below the structural stop', () => {
    const decision = evaluateMicroBurstExit(
      makeExitContext({
        currentPrice: 100.19,
        peakPrice: 100.19,
        troughPrice: 99.94,
        structuralInvalidationPrice: 100.2,
        destinationPrice: 98,
      }),
      { ...config, exitImmediateAdverseBps: 100 },
      'SHORT',
    );
    expect(decision.reason).not.toBe('HARD_INVALIDATION');
  });

  it('does not let leverage alter structural invalidation', () => {
    const base = makeExitContext({ currentPrice: 99.79, troughPrice: 99.79 });
    expect(evaluateMicroBurstExit({ ...base, leverage: 5 }, config, 'LONG')).toEqual(
      evaluateMicroBurstExit({ ...base, leverage: 50 }, config, 'LONG'),
    );
  });
});

describe.each([
  { side: 'LONG' as const, favorablePeak: 100.02, adversePrice: 99.88, target: 102 },
  { side: 'SHORT' as const, favorablePeak: 99.98, adversePrice: 100.12, target: 98 },
])('MicroBurstExitPolicy time-to-prove $side', ({ side, favorablePeak, adversePrice, target }) => {
  function proofContext(timeInTradeMs: number, favorablePrice = favorablePeak) {
    return makeExitContext({
      currentPrice: 100,
      peakPrice: side === 'LONG' ? favorablePrice : 100,
      troughPrice: side === 'SHORT' ? favorablePrice : 100,
      structuralInvalidationPrice: side === 'LONG' ? 99.5 : 100.5,
      destinationPrice: target,
      timeInTradeMs,
    });
  }

  it('holds at 10s without progress or adverse evidence', () => {
    expect(evaluateMicroBurstExit(proofContext(10_000), config, side).reason).toBe('HOLD');
  });

  it('holds at proofWindow - 1 without progress', () => {
    expect(
      evaluateMicroBurstExit(proofContext(config.exitProofWindowMs - 1), config, side).reason,
    ).toBe('HOLD');
  });

  it('fails at proofWindow when MFE is insufficient', () => {
    expect(
      evaluateMicroBurstExit(proofContext(config.exitProofWindowMs), config, side).reason,
    ).toBe('EARLY_FAILURE');
  });

  it('does not fail proof after sufficient MFE', () => {
    const sufficientPrice = side === 'LONG' ? 100.08 : 99.92;
    expect(
      evaluateMicroBurstExit(proofContext(config.exitProofWindowMs, sufficientPrice), config, side)
        .reason,
    ).not.toBe('EARLY_FAILURE');
  });

  it('does not exit from historical MAE without current independent corroboration', () => {
    const context = proofContext(15_000);
    if (side === 'LONG') context.troughPrice = adversePrice;
    else context.peakPrice = adversePrice;
    expect(evaluateMicroBurstExit(context, config, side).reason).toBe('HOLD');
  });

  it('takes target during proof window', () => {
    const context = proofContext(15_000, side === 'LONG' ? 102 : 98);
    context.currentPrice = target;
    expect(evaluateMicroBurstExit(context, config, side).reason).toBe('TARGET');
  });
});

describe('MicroBurstExitPolicy profit protection and priority', () => {
  it('does not close LONG from a peak callback alone', () => {
    const decision = evaluateMicroBurstExit(
      makeExitContext({ currentPrice: 100.9, peakPrice: 101, troughPrice: 100 }),
      config,
      'LONG',
    );
    expect(decision).toMatchObject({ action: 'MOVE_STOP', reason: 'PROFIT_LOCK' });
    expect(decision.diagnostics).not.toHaveProperty('callbackBps');
  });

  it('does not close SHORT from a trough callback alone', () => {
    const decision = evaluateMicroBurstExit(
      makeExitContext({
        currentPrice: 99.6,
        peakPrice: 100.1,
        troughPrice: 99.5,
        structuralInvalidationPrice: 100.5,
        destinationPrice: 98,
      }),
      config,
      'SHORT',
    );
    expect(decision).toMatchObject({ action: 'MOVE_STOP', reason: 'PROFIT_LOCK' });
    expect(decision.diagnostics).not.toHaveProperty('callbackBps');
  });

  it('does not repeat LONG profit protection when current stop already covers costs', () => {
    for (const currentStopPrice of [100.16, 100.2]) {
      const decision = evaluateMicroBurstExit(
        makeExitContext({ currentPrice: 100.12, peakPrice: 100.12, currentStopPrice }),
        config,
        'LONG',
      );
      expect(decision.reason).not.toBe('PROFIT_LOCK');
    }
  });

  it('does not repeat SHORT profit protection when current stop already covers costs', () => {
    for (const currentStopPrice of [99.84, 99.8]) {
      const decision = evaluateMicroBurstExit(
        makeExitContext({
          currentPrice: 99.88,
          troughPrice: 99.88,
          currentStopPrice,
          structuralInvalidationPrice: 100.5,
          destinationPrice: 98,
        }),
        config,
        'SHORT',
      );
      expect(decision.reason).not.toBe('PROFIT_LOCK');
    }
  });

  it.each([
    [
      'hard invalidation beats target',
      makeExitContext({ currentPrice: 99, destinationPrice: 99 }),
      'LONG',
      'HARD_INVALIDATION',
    ],
    [
      'anomaly beats target',
      makeExitContext({ currentPrice: 102, peakPrice: 102, anomalyExitFlag: true }),
      'LONG',
      'ANOMALY',
    ],
    [
      'target is not preempted by a BTC flag after price reaches destination',
      makeExitContext({
        currentPrice: 102,
        peakPrice: 102,
        currentBtcContext: makeBtcContext({ conflictFlag: true, direction: 'SHORT' }),
      }),
      'LONG',
      'TARGET',
    ],
    [
      'target beats intelligent evidence',
      makeExitContext({ currentPrice: 102, peakPrice: 103 }),
      'LONG',
      'TARGET',
    ],
    [
      'target beats max hold',
      makeExitContext({ currentPrice: 102, peakPrice: 102, timeInTradeMs: 999_999 }),
      'LONG',
      'TARGET',
    ],
    [
      'proof failure beats max hold',
      makeExitContext({ timeInTradeMs: 999_999, peakPrice: 100.02 }),
      'LONG',
      'EARLY_FAILURE',
    ],
    [
      'sub-cost profit does not defer max hold',
      makeExitContext({ currentPrice: 100.12, peakPrice: 100.12, timeInTradeMs: 999_999 }),
      'LONG',
      'MAX_HOLD',
    ],
  ] as const)('%s', (_name, context, side, reason) => {
    expect(evaluateMicroBurstExit(context, config, side).reason).toBe(reason);
  });

  it('is deterministic for the same exit context', () => {
    const context = makeExitContext({
      currentPrice: 100.02,
      peakPrice: 100.02,
      timeInTradeMs: 10_000,
    });
    expect(evaluateMicroBurstExit(context, config, 'LONG')).toEqual(
      evaluateMicroBurstExit(context, config, 'LONG'),
    );
  });
});
