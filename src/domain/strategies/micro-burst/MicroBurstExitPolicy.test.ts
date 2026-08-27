import { describe, expect, it } from 'vitest';
import { defaultMicroBurstConfig, MicroBurstExitContext } from './MicroBurstTypes';
import { evaluateMicroBurstExit } from './MicroBurstExitPolicy';

function makeExitContext(overrides: Partial<MicroBurstExitContext> = {}): MicroBurstExitContext {
  return {
    unrealizedRoe: 0,
    favorableExcursion: 0,
    adverseExcursion: 0,
    timeInTradeMs: 0,
    momentumDecayFlag: false,
    anomalyExitFlag: false,
    currentBookPressure: null,
    currentBtcContext: null,
    ...overrides,
  };
}

describe('MicroBurstExitPolicy', () => {
  const config = defaultMicroBurstConfig();

  it('holds when position is active and healthy', () => {
    const ctx = makeExitContext({ timeInTradeMs: 10_000 });
    const result = evaluateMicroBurstExit(ctx, config, 100, 'LONG', 100.5);
    expect(result.action).toBe('HOLD');
  });

  it('closes on max hold timeout', () => {
    const ctx = makeExitContext({ timeInTradeMs: 400_000 });
    const result = evaluateMicroBurstExit(ctx, config, 100, 'LONG', 100.1);
    expect(result.action).toBe('CLOSE_MARKET');
    expect(result.reason).toBe('MAX_HOLD');
  });

  it('closes on anomaly exit flag', () => {
    const ctx = makeExitContext({ anomalyExitFlag: true, timeInTradeMs: 5000 });
    const result = evaluateMicroBurstExit(ctx, config, 100, 'LONG', 100.1);
    expect(result.action).toBe('CLOSE_MARKET');
    expect(result.reason).toBe('ANOMALY');
  });

  it('closes on book anomaly', () => {
    const ctx = makeExitContext({
      timeInTradeMs: 5000,
      currentBookPressure: {
        spreadBps: 50,
        topOfBookImbalance: 0,
        imbalanceSlope: 0,
        absorptionDetected: false,
        sweepDetected: false,
        anomalyFlag: true,
        degradedMode: false,
      },
    });
    const result = evaluateMicroBurstExit(ctx, config, 100, 'LONG', 100.1);
    expect(result.action).toBe('CLOSE_MARKET');
    expect(result.reason).toBe('ANOMALY');
  });

  it('closes on early failure when no favorable excursion and adverse excursion', () => {
    const ctx = makeExitContext({
      timeInTradeMs: 30_000,
      favorableExcursion: 0.01,
      adverseExcursion: 0.15,
    });
    const result = evaluateMicroBurstExit(ctx, config, 100, 'LONG', 99.8);
    expect(result.action).toBe('CLOSE_MARKET');
    expect(result.reason).toBe('EARLY_FAILURE');
  });

  it('closes on adverse excursion beyond threshold', () => {
    const ctx = makeExitContext({
      timeInTradeMs: 10_000,
      unrealizedRoe: -0.12,
    });
    const result = evaluateMicroBurstExit(ctx, config, 100, 'LONG', 99);
    expect(result.action).toBe('CLOSE_MARKET');
    expect(result.reason).toBe('EARLY_FAILURE');
  });

  it('moves stop to break-even when in profit', () => {
    const ctx = makeExitContext({
      timeInTradeMs: 30_000,
      unrealizedRoe: 0.12,
      favorableExcursion: 0.15,
      adverseExcursion: 0.02,
    });
    const result = evaluateMicroBurstExit(ctx, config, 100, 'LONG', 101.2);
    expect(result.action).toBe('MOVE_STOP');
    expect(result.reason).toBe('BREAK_EVEN');
    expect(result.requestedStopPrice).toBe(100);
  });

  it('trails stop when in strong profit', () => {
    const ctx = makeExitContext({
      timeInTradeMs: 30_000,
      unrealizedRoe: 0.20,
      favorableExcursion: 0.25,
      adverseExcursion: 0,
    });
    const result = evaluateMicroBurstExit(ctx, config, 100, 'LONG', 102);
    expect(result.action).toBe('MOVE_STOP');
    expect(result.reason).toBe('TRAILING');
    expect(result.requestedStopPrice).toBeGreaterThan(100);
  });
});
