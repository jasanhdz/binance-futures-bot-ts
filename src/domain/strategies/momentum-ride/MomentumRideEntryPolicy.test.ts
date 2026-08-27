import { describe, expect, it } from 'vitest';
import { Candle, Side } from '../../types';
import {
  evaluateMomentumRideEntry,
  MomentumRideEntryPolicyConfig,
} from './MomentumRideEntryPolicy';

const config: MomentumRideEntryPolicyConfig = {
  longEnabled: true,
  shortEnabled: true,
  leverage: 15,
  positionFraction: 0.08,
  maxTradesPerDay: 3,
  maxConsecutiveLosses: 2,
  minCooldownMs: 30_000,
  maxLiquidityStress: 0.7,
  dailyLossStopPct: 0.1,
};

function momentumCandles(side: Side): Candle[] {
  const direction = side === 'LONG' ? 1 : -1;
  return Array.from({ length: 80 }, (_, index) => {
    const close = 100 + direction * index * 0.01;
    const isMomentum = index >= 77;
    const open = isMomentum ? close - direction * 0.2 : close - direction * 0.05;
    return {
      openTime: index * 300_000,
      timestamp: index * 300_000,
      open,
      high: Math.max(open, close) + 0.1,
      low: Math.min(open, close) - 0.1,
      close,
      volume: isMomentum ? 120 + (index - 77) * 2 : 100,
      buyVolume: 50,
      closeTime: (index + 1) * 300_000 - 1,
    };
  });
}

function context(side: Side) {
  return {
    symbol: 'SUIUSDT',
    timestamp: 123,
    candles: momentumCandles(side),
    side,
    safety: {
      hasOpenPosition: false,
      tradesToday: 0,
      consecutiveLosses: 0,
      timeSinceLastExitMs: 60_000,
      liquidityStress: 0.2,
      dailyPnlPct: 0,
    },
  };
}

describe('MomentumRideEntryPolicy', () => {
  it.each(['LONG', 'SHORT'] as Side[])('produces an independent %s entry intent', (side) => {
    const result = evaluateMomentumRideEntry(context(side), config);

    expect(result).toMatchObject({
      symbol: 'SUIUSDT',
      decision: 'ENTRY_INTENT',
      side,
      reason: 'main_stacking_momentum_confirmed',
    });
  });

  it('uses shared safety without requiring an Aegis brain signal', () => {
    const ctx = context('LONG');
    ctx.safety.hasOpenPosition = true;

    expect(evaluateMomentumRideEntry(ctx, config)).toMatchObject({
      decision: 'NO_TRADE',
      reason: 'position_already_open',
    });
  });

  it('keeps side enablement as Momentum-owned policy', () => {
    expect(
      evaluateMomentumRideEntry(context('SHORT'), { ...config, shortEnabled: false }),
    ).toMatchObject({
      decision: 'NO_TRADE',
      reason: 'momentum_short_disabled',
    });
  });
});
