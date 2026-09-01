import type { Logger } from '../../../app/ports/Logger';
import type { Notifier } from '../../../app/ports/Notifier';
import type { StateStore } from '../../../app/ports/StateStore';
import type { USDTAccountSnapshot } from '../../../app/ports/Exchange';
import type { Candle, Side } from '../../../core/types';
import type { StrategyExecutionPort } from '../../../core/strategy/StrategyExecution';
import type { StrategyIdentity } from '../../../core/strategy/StrategyIdentity';
import type { StrategyRouter } from '../../../core/strategy/StrategyRouter';
import {
  type AegisTurboHistoryLogger,
  generateSignalId,
  generateStrategyTradeId,
  getPortfolioSessionId,
} from '../../../infra/logging/AegisTurboHistoryLogger';
import { VERIFIED_AEGIS_TRADE_OWNERSHIP } from '../../../infra/logging/AegisTradeOwnership';
import type { AegisMomentumRideRuntimeConfig } from '../../aegis/domain/entry/AegisEntryDecisionTypes';
import { MAIN_STACKING_MOMENTUM_AUTHORITY } from '../domain/MainStackingMomentumStrategy';
import { evaluateMomentumPattern } from '../domain/MomentumRideEntryPolicy';
import type { MomentumRideStrategyContext } from '../domain/MomentumRideStrategy';
import type { MomentumCandleSnapshot } from './MomentumCandleState';
import type { MomentumRealtimeMarketSnapshot } from './MomentumRealtimeMarketState';

interface ClosedTradeOutcome {
  closedAt: string;
  pnlUsdt: number;
}

interface LiquidityStressSnapshot {
  stress: number;
  status: 'NO_DATA' | 'FRESH' | 'STALE';
  receiveAgeMs?: number;
  inputVersion: MomentumRideStrategyContext['liquidityStressInputVersion'];
}

interface EntryAccountContext {
  balance: number;
  snapshot: USDTAccountSnapshot;
}

export interface MomentumEntryCoordinatorDeps {
  logger: Logger;
  notifier: Notifier;
  identity: StrategyIdentity;
  strategyRouter: StrategyRouter<MomentumRideStrategyContext>;
  execution: StrategyExecutionPort;
  historyLogger: AegisTurboHistoryLogger;
  now(): number;
  getConfig(): AegisMomentumRideRuntimeConfig;
  readRuntimeCandles(symbol: string, limit: number): Promise<MomentumCandleSnapshot | undefined>;
  readRealtimeMarket(symbol: string): MomentumRealtimeMarketSnapshot | undefined;
  getCachedCandles(symbol: string): Candle[];
  getRestCandles(symbol: string, interval: string, limit: number): Promise<Candle[]>;
  isValidCandle(candle: Candle): boolean;
  isFiniteNumber(value: unknown): value is number;
  getUSDTBalance(): Promise<number>;
  readEntryAccountSnapshot(walletFallback?: number): Promise<USDTAccountSnapshot>;
  initializeDailyStartBalance(balance: number, now: number): void;
  getDailyStartBalance(): number | null;
  setLastDailyPnlPct(value: number | undefined): void;
  readClosedOutcomes(): Promise<ClosedTradeOutcome[]>;
  getTradingMode(): string;
  getSymbolMode(symbol: string): string;
  isLiveEnabled(): boolean;
  readStrategyRisk(now: number): { tradesToday: number; consecutiveLosses: number };
  timeSinceLastLossMs(now: number): number;
  readPortfolioExposure(): Promise<{ openPositions: number }>;
  getLiveSymbols(): string[];
  stateForSymbol(symbol: string): StateStore;
  hasOpenPosition(symbol: string): Promise<boolean>;
  readLiquidityStatus(symbol: string, now: number): LiquidityStressSnapshot | undefined;
  liquidityInputVersion: MomentumRideStrategyContext['liquidityStressInputVersion'];
  logTradeEvent(symbol: string, event: string, payload: Record<string, unknown>): Promise<void>;
  recordConfirmedOpen(openedAt: number): void;
}

/**
 * Owns standalone Momentum entry orchestration. It evaluates Momentum policy
 * and emits a strategy intent through the shared execution port; it never
 * calls an exchange mutation directly.
 */
export class MomentumEntryCoordinator {
  constructor(private readonly deps: MomentumEntryCoordinatorDeps) {}

  async evaluate(symbol: string): Promise<boolean> {
    const candidate = await this.loadStandaloneData(symbol);
    if (!candidate) return false;
    const symbolConfig = this.deps.getConfig().symbols[symbol];
    if (!symbolConfig?.enabled) return false;

    // LONG and SHORT share the same account view for this symbol evaluation.
    // It is populated lazily, only after a side passes the pure pattern gate.
    const accountContext: { value?: EntryAccountContext } = {};

    for (const side of ['LONG', 'SHORT'] as Side[]) {
      const sideConfig = side === 'LONG' ? symbolConfig.long : symbolConfig.short;
      if (!sideConfig.enabled) continue;
      if (await this.evaluateAndExecuteSide(symbol, side, candidate, accountContext)) return true;
    }
    return false;
  }

  private async loadStandaloneData(symbol: string): Promise<
    | {
        candles: Candle[];
        candleState?: MomentumCandleSnapshot;
      }
    | undefined
  > {
    const config = this.deps.getConfig();
    const symbolConfig = config.symbols[symbol];
    if (
      config.enabled !== true ||
      config.standaloneMainReplica !== true ||
      !symbolConfig?.enabled
    ) {
      return undefined;
    }

    const now = this.deps.now();
    let candleState: MomentumCandleSnapshot | undefined;
    let candles: Candle[] = [];
    try {
      candleState = await this.deps.readRuntimeCandles(symbol, 300);
      if (candleState) {
        candles = candleState.candles.filter(
          (candle) =>
            this.deps.isValidCandle(candle) &&
            (!this.deps.isFiniteNumber(candle.closeTime) || candle.closeTime <= now),
        );
      }
    } catch (error) {
      this.deps.logger.warn('momentum_live_candle_read_failed', {
        symbol,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Compatibility fallback for direct test harnesses or startup before the
    // shared candle runtime exists. Operational steady state uses the branch above.
    if (candles.length < 120) candles = this.deps.getCachedCandles(symbol);
    if (candles.length < 120) {
      candles = (await this.deps.getRestCandles(symbol, '5m', 300)).filter(
        (candle) =>
          this.deps.isValidCandle(candle) &&
          (!this.deps.isFiniteNumber(candle.closeTime) || candle.closeTime <= now),
      );
    }

    return { candles, candleState };
  }

  private async evaluateAndExecuteSide(
    symbol: string,
    side: Side,
    candidate: { candles: Candle[]; candleState?: MomentumCandleSnapshot },
    accountContext: { value?: EntryAccountContext },
  ): Promise<boolean> {
    const config = this.deps.getConfig();
    const symbolConfig = config.symbols[symbol];
    if (!symbolConfig?.enabled) return false;

    const sideConfig = side === 'LONG' ? symbolConfig.long : symbolConfig.short;
    if (!sideConfig.enabled) return false;

    // The canonical pattern is pure and local. Avoid account, exposure and
    // outcome I/O until the pattern has actually produced a candidate.
    const pattern = evaluateMomentumPattern(candidate.candles, side);
    if (!pattern.allowed) {
      this.deps.logger.debug('momentum_pattern_preflight_blocked', {
        symbol,
        side,
        reason: pattern.reason,
        diagnostics: pattern.diagnostics,
      });
      return false;
    }

    const now = this.deps.now();
    const signalId = generateSignalId(symbol);
    const tradeId = generateStrategyTradeId('MOMENTUM_RIDE', symbol);
    const identity = this.deps.identity;

    if (!accountContext.value) {
      const balance = await this.deps.getUSDTBalance();
      accountContext.value = {
        balance,
        snapshot: await this.deps.readEntryAccountSnapshot(balance),
      };
    }
    const { balance, snapshot: accountSnapshot } = accountContext.value;
    const dailyEquity = accountSnapshot.equityTotal ?? accountSnapshot.walletBalance ?? balance;
    this.deps.initializeDailyStartBalance(dailyEquity, now);
    const dailyStartBalance = this.deps.getDailyStartBalance();
    const dayStart = Math.floor(now / 86400000) * 86400000;
    const outcomes = await this.deps.readClosedOutcomes();
    const botDailyPnlUsdt = outcomes.reduce((total, outcome) => {
      const closedAt = Date.parse(outcome.closedAt);
      return Number.isFinite(closedAt) && closedAt >= dayStart ? total + outcome.pnlUsdt : total;
    }, 0);
    const dailyPnlPct =
      dailyStartBalance && dailyStartBalance > 0 ? botDailyPnlUsdt / dailyStartBalance : undefined;
    this.deps.setLastDailyPnlPct(dailyPnlPct);

    const strategyRisk = this.deps.readStrategyRisk(now);
    const portfolioExposure = await this.deps.readPortfolioExposure();
    let openMomentumPositions = 0;
    for (const liveSymbol of this.deps.getLiveSymbols()) {
      const state = this.deps.stateForSymbol(liveSymbol).get();
      if (state.mode !== 'IDLE' && state.lastStrategy === 'MOMENTUM_RIDE') {
        openMomentumPositions += 1;
      }
    }
    const symbolState = this.deps.stateForSymbol(symbol);
    const hasOpenPosition =
      symbolState.get().mode !== 'IDLE' || (await this.deps.hasOpenPosition(symbol));
    const policy = {
      longEnabled: symbolConfig.long.enabled,
      shortEnabled: symbolConfig.short.enabled,
      leverage: Math.min(sideConfig.leverage, config.safetyCaps.maxLeverage),
      positionFraction: Math.min(
        sideConfig.positionFraction,
        config.safetyCaps.maxPositionFraction,
      ),
      maxTradesPerDay: config.safetyCaps.maxMomentumTradesPerDay,
      maxConsecutiveLosses: config.safetyCaps.maxConsecutiveMomentumLosses,
      minCooldownMs: config.safetyCaps.cooldownAfterLossMinutes * 60_000,
      maxLiquidityStress: config.safetyCaps.maxLiquidityStress ?? 0.7,
      dailyLossStopPct: config.safetyCaps.dailyLossStopPct ?? 0.9,
      maxOpenMomentumPositions: config.safetyCaps.maxOpenMomentumPositions,
      maxTotalOpenPositionsWhenMomentum: config.safetyCaps.maxTotalOpenPositionsWhenMomentum,
      disableSymbolAfterStopLossMs: config.safetyCaps.disableSymbolAfterStopLossMinutes * 60_000,
    };
    const liquidity = this.deps.readLiquidityStatus(symbol, now) ?? {
      stress: 0,
      status: 'NO_DATA' as const,
      inputVersion: this.deps.liquidityInputVersion,
    };
    const realtimeMarket = this.deps.readRealtimeMarket(symbol) ?? {
      source: 'SHARED_WEBSOCKET' as const,
      status: 'NO_DATA' as const,
      orderBookHealth: 'UNAVAILABLE' as const,
      aggTradeGapFree: false,
      aggTradeCount: 0,
      netTakerVolume: 0,
    };
    const strategyContext: MomentumRideStrategyContext = {
      symbol,
      timestamp: now,
      candles: candidate.candles,
      side,
      realtimeMarketSource: realtimeMarket.source,
      realtimeMarketStatus: realtimeMarket.status,
      realtimeMarketAgeMs: realtimeMarket.ageMs,
      realtimeAggTradeAgeMs: realtimeMarket.aggTradeAgeMs,
      realtimeAggTradeGapFree: realtimeMarket.aggTradeGapFree,
      realtimeAggTradeCount: realtimeMarket.aggTradeCount,
      realtimeNetTakerVolume: realtimeMarket.netTakerVolume,
      candleSource: candidate.candleState?.source,
      candleStatus: candidate.candleState?.status,
      candleAgeMs: candidate.candleState?.ageMs,
      candleWebsocketObservedAtMs: candidate.candleState?.websocketObservedAtMs,
      candleRestFallbackCount: candidate.candleState?.restFallbackCount,
      candleUsedRestFallback: candidate.candleState?.usedRestFallback,
      policy,
      openPositionsCount: portfolioExposure.openPositions,
      openMomentumPositions,
      symbolLastStopLossAt: symbolState.get().lastStopLossAt,
      liquidityStressStatus: liquidity.status,
      liquidityStressAgeMs: liquidity.receiveAgeMs,
      liquidityStressInputVersion: liquidity.inputVersion,
      safety: {
        hasOpenPosition,
        tradesToday: strategyRisk.tradesToday,
        consecutiveLosses: strategyRisk.consecutiveLosses,
        timeSinceLastExitMs: this.deps.timeSinceLastLossMs(now),
        liquidityStress: liquidity.stress,
        dailyPnlPct,
      },
    };
    const decision = await this.deps.strategyRouter.evaluate('MOMENTUM_RIDE', strategyContext);
    if (decision.diagnostics.patternMatched !== true) return false;

    await this.deps.historyLogger.logSignal({
      signal_id: signalId,
      portfolio_session_id: getPortfolioSessionId(),
      symbol,
      strategy: 'MOMENTUM_RIDE',
      strategy_version: identity.strategyVersion,
      strategy_hash: identity.strategyHash,
      config_hash: identity.configHash,
      code_commit_sha: identity.codeCommitSha,
      mode: this.deps.getTradingMode(),
      raw_action: side,
      gated_action: decision.decision === 'ENTRY_INTENT' ? side : 'HOLD',
      final_action: decision.decision === 'ENTRY_INTENT' ? side : 'HOLD',
      reason: decision.reason,
      gate_allowed: decision.decision === 'ENTRY_INTENT',
      gate_reason: decision.reason,
      executed: false,
      trade_id: decision.decision === 'ENTRY_INTENT' ? tradeId : undefined,
      leverage: policy.leverage,
      position_fraction: policy.positionFraction,
      metadata: {
        authority: MAIN_STACKING_MOMENTUM_AUTHORITY,
        decisionMode: decision.mode,
        diagnostics: decision.diagnostics,
        pythonBrainUsed: false,
        aegisEntryPolicyUsed: false,
        e4Used: false,
      },
    });

    // A veto/non-live result returns false so TradingService can continue with
    // the independently evaluated Aegis strategy without granting it Momentum authority.
    if (decision.decision !== 'ENTRY_INTENT') return false;
    if (decision.mode !== 'LIVE') return false;
    if (this.deps.getTradingMode() !== 'AEGIS_TURBO_MICRO_LIVE') return false;
    if (!this.deps.isLiveEnabled()) return false;
    if (this.deps.getSymbolMode(symbol) !== 'LIVE') return false;
    if (!sideConfig.enabled || policy.leverage <= 0 || policy.positionFraction <= 0) return false;

    const protection = config.protection ?? {
      hardStopRoe: -0.4,
      takeProfitRoe: 0.5,
      breakEvenRoe: 0.08,
      trailingActivationRoe: 0.15,
      trailingCallbackRoe: 0.08,
      maxHoldMs: 28_800_000,
    };
    const execution = await this.deps.execution.execute({
      identity,
      signalId,
      tradeId,
      symbol,
      side,
      requestedAt: now,
      leverage: policy.leverage,
      positionFraction: policy.positionFraction,
      stopRoe: protection.hardStopRoe,
      takeProfitRoe: protection.takeProfitRoe,
      protection: {
        requireStop: true,
        requireTakeProfit: true,
        closeIfProtectionFails: true,
      },
      metadata: {
        authority: MAIN_STACKING_MOMENTUM_AUTHORITY,
        decisionReason: decision.reason,
        decisionDiagnostics: decision.diagnostics,
        protectionProfileSource: 'momentum_owned_protection_profile',
        aegisEntryPolicyUsed: false,
        pythonBrainUsed: false,
      },
    });

    await this.deps.logTradeEvent(
      symbol,
      execution.status === 'OPENED' ? 'POSITION_CONFIRMED' : 'ORDER_EXECUTION_FAILED',
      {
        strategy: 'MOMENTUM_RIDE',
        identity,
        tradeId,
        reason:
          execution.status === 'OPENED' ? 'momentum_shared_execution_opened' : execution.reason,
        metadata: execution.metadata,
      },
    );
    if (execution.status !== 'OPENED') {
      this.deps.logger.warn('momentum_shared_execution_not_opened', {
        symbol,
        side,
        tradeId,
        status: execution.status,
        reason: execution.reason,
      });
      return false;
    }

    const metadata = execution.metadata as Record<string, unknown>;
    symbolState.set({
      mode: side === 'LONG' ? 'LONG_RIDE' : 'SHORT_RIDE',
      positionOwner: 'BOT',
      tradeOrigin: 'BOT',
      ownershipStatus: 'VERIFIED',
      eligibleForBotMetrics: true,
      metricsExclusionReason: null,
      lastSide: side,
      lastEntryPrice: execution.entryPrice,
      lastLeverage: execution.leverage,
      lastActualLeverage: execution.leverage,
      lastRequestedLeverage: policy.leverage,
      lastEntryAt: execution.openedAt,
      lastTradeId: tradeId,
      lastOrderId: execution.orderId,
      lastStrategy: 'MOMENTUM_RIDE',
      lastStrategyVersion: identity.strategyVersion,
      lastStrategyHash: identity.strategyHash,
      lastConfigHash: identity.configHash,
      lastCodeCommitSha: identity.codeCommitSha,
      lastStrategyFreezeState: identity.freezeState,
      lastEntryQty: execution.quantity,
      lastEntryMargin: this.deps.isFiniteNumber(metadata.marginUsed)
        ? metadata.marginUsed
        : undefined,
      lastPositionFraction: execution.positionFraction,
      lastStopRoe: protection.hardStopRoe,
      lastTakeProfitRoe: protection.takeProfitRoe,
      lastStopPrice: this.deps.isFiniteNumber(metadata.stopPrice) ? metadata.stopPrice : undefined,
      lastBreakEvenRoe: protection.breakEvenRoe,
      lastTrailingActivationRoe: protection.trailingActivationRoe,
      lastTrailingCallbackRoe: protection.trailingCallbackRoe,
      lastMaxHoldMs: protection.maxHoldMs,
      lastBracketStatus: 'OK',
      breakEvenArmed: false,
      breakEvenExecuted: false,
      peakRoe: 0,
      lowestRoe: 0,
      lastPeakPrice: execution.entryPrice,
      exitEyeNeutralCount: 0,
      exitEyeOppositeCount: 0,
    });

    this.deps.recordConfirmedOpen(execution.openedAt);
    await this.deps.historyLogger.logTradeOpen({
      ...VERIFIED_AEGIS_TRADE_OWNERSHIP,
      trade_id: tradeId,
      portfolio_session_id: getPortfolioSessionId(),
      symbol,
      strategy: 'MOMENTUM_RIDE',
      strategy_version: identity.strategyVersion,
      strategy_hash: identity.strategyHash,
      config_hash: identity.configHash,
      code_commit_sha: identity.codeCommitSha,
      mode: this.deps.getTradingMode(),
      side,
      opened_at: new Date(execution.openedAt).toISOString(),
      entry_price: execution.entryPrice,
      quantity: execution.quantity,
      leverage: execution.leverage,
      position_fraction: execution.positionFraction,
      margin_estimated: this.deps.isFiniteNumber(metadata.marginUsed)
        ? metadata.marginUsed
        : undefined,
      notional_estimated: execution.entryPrice * execution.quantity,
      stop_roe: protection.hardStopRoe,
      take_profit_roe: protection.takeProfitRoe,
      trailing_activation_roe: protection.trailingActivationRoe,
      trailing_callback_roe: protection.trailingCallbackRoe,
      sl_price: this.deps.isFiniteNumber(metadata.stopPrice) ? metadata.stopPrice : undefined,
      tp_price: this.deps.isFiniteNumber(metadata.takeProfitPrice)
        ? metadata.takeProfitPrice
        : undefined,
      brackets_confirmed: true,
      status: 'OPEN',
      metadata: {
        authority: MAIN_STACKING_MOMENTUM_AUTHORITY,
        orderId: execution.orderId,
        pythonBrainUsed: false,
        aegisEntryPolicyUsed: false,
        e4Used: false,
        protectionProfileSource: 'momentum_owned_protection_profile',
      },
    });

    this.deps.logger.warn('momentum_ride_live_entry', {
      symbol,
      side,
      tradeId,
      entryPrice: execution.entryPrice,
      quantity: execution.quantity,
      leverage: execution.leverage,
      positionFraction: execution.positionFraction,
    });
    await this.deps.notifier.sendMessage(
      `⚡ **MOMENTUM RIDE ENTRY**\n` +
        `${symbol} | ${side}\n` +
        `Entrada: $${execution.entryPrice}\n` +
        `Leverage: ${execution.leverage}x\n` +
        `Strategy: MOMENTUM_RIDE\n` +
        `Python/Aegis policy: NO`,
    );
    return true;
  }
}

