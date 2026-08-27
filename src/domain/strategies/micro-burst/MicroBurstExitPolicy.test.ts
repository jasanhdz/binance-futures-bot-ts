import { describe, expect, it } from 'vitest';
import { defaultMicroBurstConfig, MicroBurstExitContext } from './MicroBurstTypes';
import { evaluateMicroBurstExit } from './MicroBurstExitPolicy';

function makeExitContext(overrides: Partial<MicroBurstExitContext> = {}): MicroBurstExitContext {
  return {
    unrealizedRoe: 0,
    priceReturn: 0,
    currentPrice: 100,
    entryPrice: 100,
    peakPrice: 100,
    troughPrice: 100,
    timeInTradeMs: 0,
    momentumDecayFlag: false,
    anomalyExitFlag: false,
    currentBookPressure: null,
    currentBtcContext: null,
    leverage: 20,
    ...overrides,
  };
}

describe('MicroBurstExitPolicy', () => {
  const config = defaultMicroBurstConfig();

  it('holds when position is active, in profit, and no exit triggers', () => {
    const ctx = makeExitContext({
      timeInTradeMs: 10_000,
      priceReturn: 0.0006,
      currentPrice: 100.6,
      entryPrice: 100,
      peakPrice: 100.6,
      troughPrice: 99.9,
    });
    const result = evaluateMicroBurstExit(ctx, config, 'LONG');
    expect(result.action).toBe('HOLD');
  });

  it('closes on max hold timeout when no other exit triggers', () => {
    const ctx = makeExitContext({
      timeInTradeMs: 400_000,
      priceReturn: 0.0003,
      currentPrice: 100.3,
      entryPrice: 100,
      peakPrice: 100.5,
      troughPrice: 99.8,
    });
    const result = evaluateMicroBurstExit(ctx, config, 'LONG');
    expect(result.action).toBe('CLOSE_MARKET');
    expect(result.reason).toBe('MAX_HOLD');
  });

  it('closes on anomaly exit flag', () => {
    const ctx = makeExitContext({ anomalyExitFlag: true, timeInTradeMs: 5000 });
    const result = evaluateMicroBurstExit(ctx, config, 'LONG');
    expect(result.action).toBe('CLOSE_MARKET');
    expect(result.reason).toBe('ANOMALY');
  });

  it('closes on BTC reversal', () => {
    const ctx = makeExitContext({
      timeInTradeMs: 5000,
      currentBtcContext: {
        ret1m: -0.001,
        ret3m: -0.01,
        ret5m: -0.02,
        acceleration: -0.005,
        conflictFlag: true,
        direction: 'SHORT',
      },
    });
    const result = evaluateMicroBurstExit(ctx, config, 'LONG');
    expect(result.action).toBe('CLOSE_MARKET');
    expect(result.reason).toBe('BTC_REVERSAL');
  });

  it('closes on early failure when price return is below minimum', () => {
    const ctx = makeExitContext({
      timeInTradeMs: 30_000,
      priceReturn: 0.0002,
      currentPrice: 100.05,
      entryPrice: 100,
      peakPrice: 100.05,
      troughPrice: 99.8,
    });
    const result = evaluateMicroBurstExit(ctx, config, 'LONG');
    expect(result.action).toBe('CLOSE_MARKET');
    expect(result.reason).toBe('EARLY_FAILURE');
  });

  it('trails stop when price retraces from peak', () => {
    const ctx = makeExitContext({
      timeInTradeMs: 30_000,
      priceReturn: 0.0015,
      currentPrice: 101.0,
      entryPrice: 100,
      peakPrice: 102.0,
      troughPrice: 99.5,
    });
    const result = evaluateMicroBurstExit(ctx, config, 'LONG');
    expect(result.action).toBe('CLOSE_MARKET');
    expect(result.reason).toBe('TRAILING');
  });

  it('moves stop to break-even when in profit and price still favorable', () => {
    const ctx = makeExitContext({
      timeInTradeMs: 30_000,
      priceReturn: 0.0012,
      currentPrice: 101.2,
      entryPrice: 100,
      peakPrice: 101.5,
      troughPrice: 99.8,
    });
    const result = evaluateMicroBurstExit(ctx, config, 'LONG');
    expect(result.action).toBe('MOVE_STOP');
    expect(result.reason).toBe('BREAK_EVEN');
    expect(result.requestedStopPrice).toBe(100);
  });

  it('closes SHORT on trailing when price rises from peak', () => {
    const ctx = makeExitContext({
      timeInTradeMs: 30_000,
      priceReturn: -0.002,
      currentPrice: 99.0,
      entryPrice: 100,
      peakPrice: 98.0,
      troughPrice: 100.5,
    });
    const result = evaluateMicroBurstExit(ctx, config, 'SHORT');
    expect(result.action).toBe('CLOSE_MARKET');
    expect(result.reason).toBe('TRAILING');
  });
});
