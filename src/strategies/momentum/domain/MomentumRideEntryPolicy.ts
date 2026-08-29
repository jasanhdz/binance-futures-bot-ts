import { Candle, Side } from '../../../core/types';
import { StrategyEvaluationResult } from '../../../core/strategy/StrategyDecision';
import { evaluateMainStackingMomentum } from './MainStackingMomentumStrategy';
import {
  evaluateSharedEntrySafety,
  SharedEntrySafetyContext,
} from '../../../core/risk/SharedEntrySafetyGate';

export type MomentumLiquidityStressStatus = 'NO_DATA' | 'FRESH' | 'STALE';
export const MOMENTUM_LIQUIDITY_INPUT_VERSION = 'DEPTH20_PARTIAL_V1' as const;

export interface MomentumRideEntryContext {
  symbol: string;
  timestamp: number;
  candles: Candle[];
  side: Side;
  openPositionsCount?: number;
  openMomentumPositions?: number;
  symbolLastStopLossAt?: number;
  safety: Omit<
    SharedEntrySafetyContext,
    | 'maxTradesPerDay'
    | 'maxConsecutiveLosses'
    | 'minCooldownMs'
    | 'maxLiquidityStress'
    | 'dailyLossStopPct'
  >;
  liquidityStressStatus: MomentumLiquidityStressStatus;
  liquidityStressAgeMs?: number;
  liquidityStressInputVersion: typeof MOMENTUM_LIQUIDITY_INPUT_VERSION;
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
  maxOpenMomentumPositions?: number;
  maxTotalOpenPositionsWhenMomentum?: number;
  disableSymbolAfterStopLossMs?: number;
}

export function evaluateMomentumRideEntry(
  context: MomentumRideEntryContext,
  config: MomentumRideEntryPolicyConfig,
): StrategyEvaluationResult {
  const liquidityDiagnostics = {
    liquidityStressStatus: context.liquidityStressStatus,
    liquidityStressAgeMs: context.liquidityStressAgeMs,
    liquidityStressInputVersion: context.liquidityStressInputVersion,
  };
  if (context.liquidityStressStatus !== 'FRESH') {
    return noTrade(
      context,
      context.liquidityStressStatus === 'NO_DATA'
        ? 'liquidity_data_no_data'
        : 'liquidity_data_stale',
      liquidityDiagnostics,
    );
  }
  const pattern = evaluateMainStackingMomentum(context.candles, context.side);
  if (!pattern.allowed) {
    return noTrade(context, pattern.reason, {
      pattern: pattern.diagnostics,
      ...liquidityDiagnostics,
    });
  }

  if (context.side === 'LONG' && !config.longEnabled) {
    return noTrade(context, 'momentum_long_disabled', { pattern: pattern.diagnostics });
  }
  if (context.side === 'SHORT' && !config.shortEnabled) {
    return noTrade(context, 'momentum_short_disabled', { pattern: pattern.diagnostics });
  }

  const openMomentumPositions = context.openMomentumPositions ?? 0;
  const maxOpenMomentumPositions = config.maxOpenMomentumPositions ?? Number.POSITIVE_INFINITY;
  if (openMomentumPositions >= maxOpenMomentumPositions) {
    return noTrade(context, 'momentum_max_open_positions_reached', {
      pattern: pattern.diagnostics,
      openMomentumPositions,
      limit: maxOpenMomentumPositions,
    });
  }

  const openPositionsCount = context.openPositionsCount ?? 0;
  const maxTotalOpenPositions =
    config.maxTotalOpenPositionsWhenMomentum ?? Number.POSITIVE_INFINITY;
  if (openPositionsCount >= maxTotalOpenPositions) {
    return noTrade(context, 'momentum_total_open_positions_reached', {
      pattern: pattern.diagnostics,
      openPositionsCount,
      limit: maxTotalOpenPositions,
    });
  }

  const disableSymbolAfterStopLossMs = config.disableSymbolAfterStopLossMs ?? 0;
  if (
    context.symbolLastStopLossAt !== undefined &&
    disableSymbolAfterStopLossMs > 0 &&
    context.timestamp - context.symbolLastStopLossAt < disableSymbolAfterStopLossMs
  ) {
    return noTrade(context, 'momentum_symbol_stop_loss_cooldown', {
      pattern: pattern.diagnostics,
      symbolLastStopLossAt: context.symbolLastStopLossAt,
      disableSymbolAfterStopLossMs,
    });
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
      ...liquidityDiagnostics,
      pattern: pattern.diagnostics,
      sharedSafety: safety,
      strategyRisk: {
        tradesToday: context.safety.tradesToday,
        consecutiveLosses: context.safety.consecutiveLosses,
        timeSinceLastExitMs: context.safety.timeSinceLastExitMs,
      },
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
    diagnostics: {
      liquidityStressStatus: context.liquidityStressStatus,
      liquidityStressAgeMs: context.liquidityStressAgeMs,
      liquidityStressInputVersion: context.liquidityStressInputVersion,
      ...diagnostics,
    },
  };
}
