import { describe, expect, it } from 'vitest';
import {
  advanceMicroBurstExit,
  initialMicroBurstExitEngineState,
  isMicroBurstExitEngineState,
  microBurstExitDeadline,
  MicroBurstExitEngine,
} from './MicroBurstExitPolicy';
import { defaultMicroBurstConfig, type MicroBurstExitContext } from './MicroBurstTypes';

const config = { ...defaultMicroBurstConfig(), contextualPolicyVersion: 'CONTEXTUAL_V3' as const };
function context(
  now: number,
  price = 100.5,
  side: 'LONG' | 'SHORT' = 'LONG',
): MicroBurstExitContext {
  const sign = side === 'LONG' ? 1 : -1;
  const quote = side === 'LONG' ? price : 200 - price;
  return {
    observedAtMs: now,
    timeInTradeMs: now,
    currentPrice: quote,
    entryPrice: 100,
    peakPrice: 999,
    troughPrice: 1,
    structuralInvalidationPrice: 100 - sign,
    destinationPrice: 100 + sign * 2,
    currentStopPrice: 100 - sign,
    unrealizedRoe: 0,
    priceReturn: 0,
    leverage: 20,
    momentumDecayFlag: false,
    anomalyExitFlag: false,
    currentBookPressure: null,
    currentBtcContext: null,
    executableEconomics: {
      observedAtMs: now,
      exitPrice: quote,
      quantityCovered: true,
      residualCostBps: 14,
      volatilityBps: 8,
    },
    marketEvidence: {
      observedAtMs: now,
      shortHorizonReturnBps: 3 * sign,
      mediumHorizonReturnBps: 4 * sign,
      priceSampleCount: 30,
      buyTakerVolume: side === 'LONG' ? 80 : 20,
      sellTakerVolume: side === 'LONG' ? 20 : 80,
      takerTradeCount: 30,
      takerFlowWindowComplete: true,
      takerFlowGapFree: true,
    },
  };
}
describe('Micro contextual exit V3, offline only', () => {
  it.each([
    null,
    false,
    1,
    'corrupt',
    [],
    {},
    { peakPrice: 101, troughPrice: 100, blindSinceMs: -1 },
  ])('rejects malformed persisted contextual state without throwing: %j', (contextual) => {
    expect(isMicroBurstExitEngineState({ ...initialMicroBurstExitEngineState(), contextual })).toBe(
      false,
    );
  });
  it('rejects a null persisted confirmed decision without throwing', () => {
    expect(
      isMicroBurstExitEngineState({
        ...initialMicroBurstExitEngineState(),
        confirmedDecision: null,
      }),
    ).toBe(false);
  });
  it('a repeated observation cannot conceal a newly known crossed protective stop', () => {
    const ctx = context(20_000, 100.5);
    const first = advanceMicroBurstExit(initialMicroBurstExitEngineState(), ctx, config, 'LONG');
    ctx.currentStopPrice = 100.6;
    expect(advanceMicroBurstExit(first.state, ctx, config, 'LONG').decision).toMatchObject({
      action: 'CLOSE_MARKET',
      reason: 'PROFIT_LOCK',
      diagnostics: { knownStopCrossed: true },
    });
  });
  it('does not confirm repeated price/flow evidence when only the exit quote advances', () => {
    const engine = new MicroBurstExitEngine();
    const at = (now: number, marketAt: number) => {
      const ctx = context(now, 100.1);
      ctx.currentStopPrice = 100;
      ctx.marketEvidence!.observedAtMs = marketAt;
      ctx.marketEvidence!.shortHorizonReturnBps = -3;
      ctx.marketEvidence!.buyTakerVolume = 20;
      ctx.marketEvidence!.sellTakerVolume = 80;
      return ctx;
    };
    expect(engine.evaluate('same', at(20_000, 20_000), config, 'LONG').action).toBe('HOLD');
    expect(engine.evaluate('same', at(23_000, 20_000), config, 'LONG').action).toBe('HOLD');
    expect(engine.getState('same').consecutiveRiskObservations).toBe(1);
    expect(engine.evaluate('same', at(36_000, 36_000), config, 'LONG').action).toBe('HOLD');
    expect(engine.getState('same').consecutiveRiskObservations).toBe(1);
  });
  it('rejects invalid policy numbers and never fabricates a stop when protection is unknown', () => {
    const ctx = context(20_000);
    ctx.currentStopPrice = null;
    expect(
      advanceMicroBurstExit(initialMicroBurstExitEngineState(), ctx, config, 'LONG').decision
        .action,
    ).toBe('HOLD');
    expect(
      advanceMicroBurstExit(
        initialMicroBurstExitEngineState(),
        ctx,
        { ...config, exitMaxHoldMs: NaN },
        'LONG',
      ).decision,
    ).toMatchObject({ reason: 'ANOMALY', diagnostics: { invalidPolicyConfig: true } });
  });
  it.each(['LONG', 'SHORT'] as const)(
    'tracks only executable MFE and gives %s continuation more room',
    (side) => {
      const supportive = context(20_000, 100.5, side);
      const favorable = advanceMicroBurstExit(
        initialMicroBurstExitEngineState(),
        supportive,
        config,
        side,
      );
      expect(favorable.decision.action).toBe('MOVE_STOP');
      expect(favorable.decision.diagnostics.maxFavorableExcursionBps).toBeCloseTo(50);
      const adverse = structuredClone(supportive);
      adverse.marketEvidence!.shortHorizonReturnBps =
        -adverse.marketEvidence!.shortHorizonReturnBps!;
      [adverse.marketEvidence!.buyTakerVolume, adverse.marketEvidence!.sellTakerVolume] = [
        adverse.marketEvidence!.sellTakerVolume,
        adverse.marketEvidence!.buyTakerVolume,
      ];
      const protecting = advanceMicroBurstExit(
        initialMicroBurstExitEngineState(),
        adverse,
        config,
        side,
      );
      expect(protecting.decision.action).toBe('MOVE_STOP');
      const sign = side === 'LONG' ? 1 : -1;
      expect(sign * protecting.decision.requestedStopPrice!).toBeGreaterThan(
        sign * favorable.decision.requestedStopPrice!,
      );
      expect(isMicroBurstExitEngineState(JSON.parse(JSON.stringify(favorable.state)))).toBe(true);
    },
  );
  it('does not turn a single price flicker into a close; confirms persistent independent reversal', () => {
    const engine = new MicroBurstExitEngine();
    const noise = context(20_000, 100.1);
    noise.currentStopPrice = 100;
    noise.marketEvidence!.shortHorizonReturnBps = -3;
    expect(engine.evaluate('noise', noise, config, 'LONG').action).toBe('HOLD');
    const reversal = (at: number) => {
      const ctx = context(at, 100.1);
      ctx.currentStopPrice = 100;
      ctx.marketEvidence!.shortHorizonReturnBps = -3;
      ctx.marketEvidence!.buyTakerVolume = 20;
      ctx.marketEvidence!.sellTakerVolume = 80;
      return ctx;
    };
    expect(engine.evaluate('reversal', reversal(20_000), config, 'LONG').action).toBe('HOLD');
    expect(engine.evaluate('reversal', reversal(23_000), config, 'LONG').reason).toBe(
      'INTELLIGENT_EXIT',
    );
    expect(engine.evaluate('gap', reversal(20_000), config, 'LONG').action).toBe('HOLD');
    expect(engine.evaluate('gap', reversal(40_000), config, 'LONG').action).toBe('HOLD');
  });
  it('bounds blindness across serialization and does not invent executable economics', () => {
    const first = context(20_000);
    delete first.executableEconomics;
    const waiting = advanceMicroBurstExit(
      initialMicroBurstExitEngineState(),
      first,
      config,
      'LONG',
    );
    expect(waiting.decision).toMatchObject({
      action: 'HOLD',
      diagnostics: { estimatedNetReturnBps: null },
    });
    const restored = JSON.parse(JSON.stringify(waiting.state));
    first.observedAtMs = first.timeInTradeMs = 35_000;
    expect(advanceMicroBurstExit(restored, first, config, 'LONG').decision).toMatchObject({
      action: 'CLOSE_MARKET',
      reason: 'ANOMALY',
    });
  });
  it('absolute clock beats profit locking, supportive evidence and absent prices', () => {
    const at = config.exitMaxHoldMs + config.exitMaxHoldExtensionMs;
    const ctx = context(at);
    expect(
      advanceMicroBurstExit(initialMicroBurstExitEngineState(), ctx, config, 'LONG').decision
        .reason,
    ).toBe('MAX_HOLD');
    ctx.currentPrice = NaN;
    delete ctx.executableEconomics;
    expect(
      advanceMicroBurstExit(initialMicroBurstExitEngineState(), ctx, config, 'LONG').decision
        .reason,
    ).toBe('MAX_HOLD');
    expect(microBurstExitDeadline(1000, at + 1000, config)?.reason).toBe('MAX_HOLD');
    expect(microBurstExitDeadline(undefined, at, config)).toBeNull();
  });
  it('extends target only once to a prior confirmed obstacle with positive executable room', () => {
    const ctx = context(20_000, 102);
    expect(
      advanceMicroBurstExit(initialMicroBurstExitEngineState(), ctx, config, 'LONG').decision
        .reason,
    ).toBe('TARGET');
    ctx.nextConfirmedObstacle = { price: 104, availableAtMs: 20_001 };
    expect(
      advanceMicroBurstExit(initialMicroBurstExitEngineState(), ctx, config, 'LONG').decision
        .reason,
    ).toBe('TARGET');
    ctx.nextConfirmedObstacle.availableAtMs = 19_000;
    const extended = advanceMicroBurstExit(initialMicroBurstExitEngineState(), ctx, config, 'LONG');
    expect(extended.decision.action).not.toBe('CLOSE_MARKET');
    expect(extended.state.contextual?.extendedDestinationPrice).toBeLessThan(104);
    const next = context(25_000, 104);
    next.nextConfirmedObstacle = { price: 106, availableAtMs: 24_000 };
    expect(advanceMicroBurstExit(extended.state, next, config, 'LONG').decision.reason).toBe(
      'TARGET',
    );
  });
  it('never weakens an existing stop and preserves emergency precedence', () => {
    const ctx = context(20_000);
    ctx.currentStopPrice = 100.45;
    expect(
      advanceMicroBurstExit(initialMicroBurstExitEngineState(), ctx, config, 'LONG').decision
        .action,
    ).toBe('HOLD');
    ctx.currentPrice = 98;
    delete ctx.executableEconomics;
    expect(
      advanceMicroBurstExit(initialMicroBurstExitEngineState(), ctx, config, 'LONG').decision
        .reason,
    ).toBe('HARD_INVALIDATION');
  });
});
