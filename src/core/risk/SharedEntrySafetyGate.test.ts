import { describe, expect, it } from 'vitest';
import { evaluateSharedEntrySafety, SharedEntrySafetyContext } from './SharedEntrySafetyGate';

const base: SharedEntrySafetyContext = {
  hasOpenPosition: false,
  tradesToday: 0,
  maxTradesPerDay: 3,
  consecutiveLosses: 0,
  maxConsecutiveLosses: 2,
  timeSinceLastExitMs: 60_000,
  minCooldownMs: 30_000,
  liquidityStress: 0.2,
  maxLiquidityStress: 0.7,
  dailyPnlPct: 0,
  dailyLossStopPct: 0.1,
};

describe('evaluateSharedEntrySafety', () => {
  it('allows when every operational constraint passes', () => {
    expect(evaluateSharedEntrySafety(base)).toEqual({
      allowed: true,
      reason: 'shared_entry_safety_allowed',
    });
  });

  it.each([
    [{ hasOpenPosition: true }, 'position_already_open'],
    [{ tradesToday: 3 }, 'max_trades_per_day_reached'],
    [{ consecutiveLosses: 2 }, 'max_consecutive_losses_reached'],
    [{ timeSinceLastExitMs: 29_999 }, 'cooldown_active'],
    [{ liquidityStress: 0.71 }, 'liquidity_stress_block'],
    [{ dailyPnlPct: -0.1 }, 'daily_loss_stop_reached'],
  ] as const)('preserves fail-closed reason ordering for %j', (patch, reason) => {
    expect(evaluateSharedEntrySafety({ ...base, ...patch })).toEqual({
      allowed: false,
      reason,
    });
  });

  it('preserves the current strict greater-than liquidity boundary', () => {
    expect(evaluateSharedEntrySafety({ ...base, liquidityStress: 0.7 }).allowed).toBe(true);
  });
});
