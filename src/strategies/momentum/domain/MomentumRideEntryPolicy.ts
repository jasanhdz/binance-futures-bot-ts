import { Candle, Side } from '../../../core/types';
import { StrategyEvaluationResult } from '../../../core/strategy/StrategyDecision';
import { evaluateMainStackingMomentum } from './MainStackingMomentumStrategy';
import {
  evaluateSharedEntrySafety,
  SharedEntrySafetyContext,
} from '../../../core/risk/SharedEntrySafetyGate';

export type MomentumLiquidityStressStatus = 'NO_DATA' | 'FRESH' | 'STALE';
export type MomentumRealtimeMarketStatus = 'NO_DATA' | 'FRESH' | 'STALE';
export type MomentumCandleSource = 'WEBSOCKET' | 'REST_WARMUP' | 'REST_RECOVERY' | 'LEGACY_CACHE';
export const MOMENTUM_LIQUIDITY_INPUT_VERSION = 'DEPTH20_PARTIAL_V1' as const;
export const MOMENTUM_REALTIME_MARKET_SOURCE = 'SHARED_WEBSOCKET' as const;

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
  realtimeMarketSource: typeof MOMENTUM_REALTIME_MARKET_SOURCE;
  realtimeMarketStatus: MomentumRealtimeMarketStatus;
  realtimeMarketAgeMs?: number;
  realtimeAggTradeAgeMs?: number;
  realtimeAggTradeGapFree: boolean;
  realtimeAggTradeCount: number;
  realtimeNetTakerVolume: number;
  candleSource?: MomentumCandleSource;
  candleStatus?: MomentumRealtimeMarketStatus;
  candleAgeMs?: number;
  candleWebsocketObservedAtMs?: number;
  candleRestFallbackCount?: number;
  candleUsedRestFallback?: boolean;
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
  const realtimeDiagnostics = {
    realtimeMarketSource: context.realtimeMarketSource,
    realtimeMarketStatus: context.realtimeMarketStatus,
    realtimeMarketAgeMs: context.realtimeMarketAgeMs,
    realtimeAggTradeAgeMs: context.realtimeAggTradeAgeMs,
    realtimeAggTradeGapFree: context.realtimeAggTradeGapFree,
    realtimeAggTradeCount: context.realtimeAggTradeCount,
    realtimeNetTakerVolume: context.realtimeNetTakerVolume,
  };
  const candleDiagnostics = {
    candleSource: context.candleSource,
    candleStatus: context.candleStatus,
    candleAgeMs: context.candleAgeMs,
    candleWebsocketObservedAtMs: context.candleWebsocketObservedAtMs,
    candleRestFallbackCount: context.candleRestFallbackCount,
    candleUsedRestFallback: context.candleUsedRestFallback,
  };
  // Compute route ownership once inside the canonical strategy policy. The
  // application layer may use patternMatched to preserve fallback semantics,
  // but it must never call the raw momentum detector directly.
  const routePattern = evaluateMainStackingMomentum(context.candles, context.side);
  const patternRouteDiagnostics = {
    patternMatched: routePattern.allowed,
    pattern: routePattern.diagnostics,
  };
  if (context.realtimeMarketStatus !== 'FRESH') {
    return noTrade(
      context,
      context.realtimeMarketStatus === 'NO_DATA'
        ? 'realtime_market_no_data'
        : 'realtime_market_stale',
      { ...realtimeDiagnostics, ...candleDiagnostics, ...patternRouteDiagnostics },
    );
  }

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
      { ...realtimeDiagnostics, ...candleDiagnostics, ...liquidityDiagnostics, ...patternRouteDiagnostics },
    );
  }
  if (!routePattern.allowed) {
    return noTrade(context, routePattern.reason, {
      ...patternRouteDiagnostics,
      ...realtimeDiagnostics,
      ...candleDiagnostics,
      ...liquidityDiagnostics,
    });
  }

  if (context.side === 'LONG' && !config.longEnabled) {
    return noTrade(context, 'momentum_long_disabled', patternRouteDiagnostics);
  }
  if (context.side === 'SHORT' && !config.shortEnabled) {
    return noTrade(context, 'momentum_short_disabled', patternRouteDiagnostics);
  }

  const openMomentumPositions = context.openMomentumPositions ?? 0;
  const maxOpenMomentumPositions = config.maxOpenMomentumPositions ?? Number.POSITIVE_INFINITY;
  if (openMomentumPositions >= maxOpenMomentumPositions) {
    return noTrade(context, 'momentum_max_open_positions_reached', {
      ...patternRouteDiagnostics,
      openMomentumPositions,
      limit: maxOpenMomentumPositions,
    });
  }

  const openPositionsCount = context.openPositionsCount ?? 0;
  const maxTotalOpenPositions =
    config.maxTotalOpenPositionsWhenMomentum ?? Number.POSITIVE_INFINITY;
  if (openPositionsCount >= maxTotalOpenPositions) {
    return noTrade(context, 'momentum_total_open_positions_reached', {
      ...patternRouteDiagnostics,
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
      ...patternRouteDiagnostics,
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
      ...patternRouteDiagnostics,
      sharedSafety: safety,
      ...candleDiagnostics,
    });
  }

  return {
    symbol: context.symbol,
    timestamp: context.timestamp,
    decision: 'ENTRY_INTENT',
    side: context.side,
    reason: 'main_stacking_momentum_confirmed',
    diagnostics: {
      ...realtimeDiagnostics,
      ...candleDiagnostics,
      ...liquidityDiagnostics,
      ...patternRouteDiagnostics,
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
      realtimeMarketSource: context.realtimeMarketSource,
      realtimeMarketStatus: context.realtimeMarketStatus,
      realtimeMarketAgeMs: context.realtimeMarketAgeMs,
      realtimeAggTradeAgeMs: context.realtimeAggTradeAgeMs,
      realtimeAggTradeGapFree: context.realtimeAggTradeGapFree,
      realtimeAggTradeCount: context.realtimeAggTradeCount,
      realtimeNetTakerVolume: context.realtimeNetTakerVolume,
      candleSource: context.candleSource,
      candleStatus: context.candleStatus,
      candleAgeMs: context.candleAgeMs,
      candleWebsocketObservedAtMs: context.candleWebsocketObservedAtMs,
      candleRestFallbackCount: context.candleRestFallbackCount,
      candleUsedRestFallback: context.candleUsedRestFallback,
      liquidityStressStatus: context.liquidityStressStatus,
      liquidityStressAgeMs: context.liquidityStressAgeMs,
      liquidityStressInputVersion: context.liquidityStressInputVersion,
      ...diagnostics,
    },
  };
}
