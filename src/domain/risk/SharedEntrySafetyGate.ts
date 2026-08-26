export interface SharedEntrySafetyContext {
  hasOpenPosition: boolean;
  tradesToday: number;
  maxTradesPerDay: number;
  consecutiveLosses: number;
  maxConsecutiveLosses: number;
  timeSinceLastExitMs: number;
  minCooldownMs: number;
  liquidityStress: number;
  maxLiquidityStress: number;
  dailyPnlPct?: number;
  dailyLossStopPct: number;
}

export type SharedEntrySafetyReason =
  | 'shared_entry_safety_allowed'
  | 'position_already_open'
  | 'max_trades_per_day_reached'
  | 'max_consecutive_losses_reached'
  | 'cooldown_active'
  | 'liquidity_stress_block'
  | 'daily_loss_stop_reached';

export interface SharedEntrySafetyDecision {
  allowed: boolean;
  reason: SharedEntrySafetyReason;
}

export function evaluateSharedEntrySafety(
  context: SharedEntrySafetyContext,
): SharedEntrySafetyDecision {
  if (context.hasOpenPosition) {
    return denied('position_already_open');
  }
  if (context.tradesToday >= context.maxTradesPerDay) {
    return denied('max_trades_per_day_reached');
  }
  if (context.consecutiveLosses >= context.maxConsecutiveLosses) {
    return denied('max_consecutive_losses_reached');
  }
  if (context.timeSinceLastExitMs < context.minCooldownMs) {
    return denied('cooldown_active');
  }
  if (context.liquidityStress > context.maxLiquidityStress) {
    return denied('liquidity_stress_block');
  }
  if (
    context.dailyPnlPct !== undefined &&
    context.dailyPnlPct <= -Math.abs(context.dailyLossStopPct)
  ) {
    return denied('daily_loss_stop_reached');
  }
  return { allowed: true, reason: 'shared_entry_safety_allowed' };
}

function denied(reason: Exclude<SharedEntrySafetyReason, 'shared_entry_safety_allowed'>): SharedEntrySafetyDecision {
  return { allowed: false, reason };
}
