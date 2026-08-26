import { Candle, Side } from '../../types';
import { StrategyEvaluationResult } from '../../strategy/StrategyDecision';
import { evaluateMainStackingMomentum } from '../../services/MainStackingMomentumStrategy';
import {
  evaluateSharedEntrySafety,
  SharedEntrySafetyContext,
} from '../../risk/SharedEntrySafetyGate';

export interface MomentumRideEntryContext {
  symbol: string;
  timestamp: number;
  candles: Candle[];
  side: Side;
  safety: Omit<
    SharedEntrySafetyContext,
    | 'maxTradesPerDay'
    | 'maxConsecutiveLosses'
    | 'minCooldownMs'
    | 'maxLiquidityStress'
    | 'dailyLossStopPct'
  >;
}

export interface MomentumRideEntryPolicyConfig {
  longEnabled: boolean;
  shortEnabled: boolean;
  leverage: number;
  positionFraction: number;
  maxTradesPerDay: number;
  maxConsecutiveLosses: number;
  minCooldownMs: number;
  maxLiquidityStress: number;
  dailyLossStopPct: number;
}

export function evaluateMomentumRideEntry(
  context: MomentumRideEntryContext,
  config: MomentumRideEntryPolicyConfig,
): StrategyEvaluationResult {
  const pattern = evaluateMainStackingMomentum(context.candles, context.side);
  if (!pattern.allowed) {
    return noTrade(context, pattern.reason, {
      pattern: pattern.diagnostics,
    });
  }

  if (context.side === 'LONG' && !config.longEnabled) {
    return noTrade(context, 'momentum_long_disabled', { pattern: pattern.diagnostics });
  }
  if (context.side === 'SHORT' && !config.shortEnabled) {
    return noTrade(context, 'momentum_short_disabled', { pattern: pattern.diagnostics });
  }

  const safety = evaluateSharedEntrySafety({
    ...context.safety,
    maxTradesPerDay: config.maxTradesPerDay,
    maxConsecutiveLosses: config.maxConsecutiveLosses,
    minCooldownMs: config.minCooldownMs,
    maxLiquidityStress: config.maxLiquidityStress,
    dailyLossStopPct: config.dailyLossStopPct,
  });
  if (!safety.allowed) {
    return noTrade(context, safety.reason, {
      pattern: pattern.diagnostics,
      sharedSafety: safety,
    });
  }

  return {
    symbol: context.symbol,
    timestamp: context.timestamp,
    decision: 'ENTRY_INTENT',
    side: context.side,
    reason: 'main_stacking_momentum_confirmed',
    diagnostics: {
      pattern: pattern.diagnostics,
      sharedSafety: safety,
      executionProfile: {
        leverage: config.leverage,
        positionFraction: config.positionFraction,
      },
    },
  };
}

function noTrade(
  context: MomentumRideEntryContext,
  reason: string,
  diagnostics: Record<string, unknown>,
): StrategyEvaluationResult {
  return {
    symbol: context.symbol,
    timestamp: context.timestamp,
    decision: 'NO_TRADE',
    side: context.side,
    reason,
    diagnostics,
  };
}
