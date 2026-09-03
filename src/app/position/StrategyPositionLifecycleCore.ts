import {
  DEFAULT_GUARDIAN_CONFIG,
  evaluateGuardianAction,
  GuardianConfig,
} from '../../domain/services/ProfitGuardian';
import { calculateATR } from '../../domain/services/TechnicalIndicators';
import { StrategyLifecyclePolicy } from '../../core/strategy/StrategyLifecyclePolicy';
import { BotState, Side } from '../../core/types';
import { PositionInfo, SymbolFilters, TradingExchangePort } from '../ports/Exchange';
import { Logger } from '../ports/Logger';
import { Notifier } from '../ports/Notifier';
import { RegimeConfig } from '../ports/RegimeStrategy';
import { StateStore } from '../ports/StateStore';

const DEFAULT_MAX_HOLD_MS = 8 * 60 * 60 * 1000;
const MANUAL_POSITION_DEFAULT_STOP_ROE = -0.4;
const MANUAL_POSITION_DEFAULT_TAKE_PROFIT_ROE = 1.0;

export interface StrategyPositionLifecycleContext {
  symbol: string;
  botState: BotState;
  symbolState: StateStore;
}

export interface LifecycleTradeEventInput {
  tradeId?: string;
  price?: number;
  roe?: number;
  oldStop?: number;
  newStop?: number;
  oldTp?: number;
  newTp?: number;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export type SafeStopMoveResult =
  | {
      moved: true;
      oldStopPrice?: number;
      newStopPrice: number;
      exchangeOrderId?: string;
      hasSLAfter?: boolean;
      hasTPAfter?: boolean;
    }
  | {
      moved: false;
      reason: string;
      oldStopPrice?: number;
      newStopPrice: number;
      error?: string;
      hasSLAfter?: boolean;
      hasTPAfter?: boolean;
    };

export interface SafeStopMoveInput {
  symbol: string;
  side: Side;
  tradeId?: string;
  entryPrice: number;
  markPrice: number;
  leverage: number;
  quantity: number;
  position: PositionInfo;
  newStopPrice: number;
  currentRoe: number;
  peakRoe: number;
  protectedRoe?: number;
  reason: 'MOVE_SL_BE' | 'PROTECT_PROFIT' | 'MOVE_SL_TRAILING';
  useClosePosition?: boolean;
}

export interface AegisExitEyeInput {
  symbol: string;
  side: Side;
  botState: BotState;
  symbolState: StateStore;
  position: PositionInfo;
  markPrice: number;
  currentRoe: number;
  peakRoe: number;
  lowestRoe: number;
  tradeDurationMs: number;
}

export interface AegisPositionLifecycle {
  manage(context: StrategyPositionLifecycleContext): Promise<void>;
}

export interface StrategyPositionLifecyclePorts {
  exchange: TradingExchangePort;
  logger: Logger;
  notifier: Notifier;
  defaultLeverage(symbol: string): number;
  requireBrackets(policy: StrategyLifecyclePolicy): boolean;
  getRegimeConfig(symbol: string): RegimeConfig | undefined;
  getGuardianConfig(symbol: string, regimeConfig?: RegimeConfig): GuardianConfig;
  isVerifiedBotOwnedState(state: BotState): boolean;
  isLegacyBotOwnedState(state: BotState): boolean;
  consecutiveLosses(): number;
  calculateRoe(side: Side, entryPrice: number, markPrice: number, leverage: number): number;
  entryMargin(state: BotState): number;
  pnlFromRoe(margin: number, roe: number): number;
  roundPrice(price: number, filters: SymbolFilters): number;
  isBetterStop(side: Side, next: number, previous?: number): boolean;
  formatRoe(value: number): string;
  notifyExit(
    symbol: string,
    side: Side,
    reason: string,
    state: BotState,
    exit?: { exitPrice?: number; finalRoe?: number; pnl?: number },
  ): Promise<void>;
  logTradeEvent(
    strategyId: StrategyLifecyclePolicy['strategyId'],
    symbol: string,
    event: string,
    input?: LifecycleTradeEventInput,
  ): Promise<void>;
  safeMoveCloseStop(input: SafeStopMoveInput): Promise<SafeStopMoveResult>;
  ensureBrackets(
    symbol: string,
    side: Side,
    entryPrice: number,
    leverage: number,
    position: PositionInfo,
    state: BotState,
    roeOverrides?: { stopRoe: number; takeProfitRoe: number },
  ): Promise<{ stopPrice?: number; takeProfitPrice?: number }>;
  replaceBracketsForNewEntryPrice(
    symbol: string,
    side: Side,
    entryPrice: number,
    leverage: number,
    position: PositionInfo,
    state: BotState,
  ): Promise<void>;
  reconcilePositionSize(input: {
    symbol: string;
    side: Side;
    leverage: number;
    position: PositionInfo;
    botState: BotState;
    symbolState: StateStore;
  }): Promise<{ changed: boolean }>;
}

export class StrategyPositionLifecycleCore {
  constructor(private readonly ports: StrategyPositionLifecyclePorts) {}

  manage(
    policy: StrategyLifecyclePolicy,
    context: StrategyPositionLifecycleContext,
  ): Promise<void> {
    return this.manageLifecycle(policy, context);
  }

  createAegisLifecycle(
    policy: StrategyLifecyclePolicy,
    exitEye: (input: AegisExitEyeInput) => Promise<boolean>,
  ): AegisPositionLifecycle {
    if (policy.strategyId !== 'AEGIS_TURBO') {
      throw new Error(`AEGIS_LIFECYCLE_POLICY_MISMATCH:${policy.strategyId}`);
    }
    return {
      manage: (context) => this.manageLifecycle(policy, context, exitEye),
    };
  }

  private async manageLifecycle(
    lifecyclePolicy: StrategyLifecyclePolicy,
    context: StrategyPositionLifecycleContext,
    aegisExitEye?: (input: AegisExitEyeInput) => Promise<boolean>,
  ): Promise<void> {
    const { exchange, logger, notifier } = this.ports;
    const { symbol, botState, symbolState } = context;
    const side = botState.lastSide as Side;
    let entryPrice = botState.lastEntryPrice || 0;
    let leverage =
      botState.lastActualLeverage || botState.lastLeverage || this.ports.defaultLeverage(symbol);
    const requireBrackets =
      this.ports.requireBrackets(lifecyclePolicy) &&
      (lifecyclePolicy.requireStopBracket || lifecyclePolicy.requireTakeProfitBracket);

    try {
      const isBotOwned =
        this.ports.isVerifiedBotOwnedState(botState) || this.ports.isLegacyBotOwnedState(botState);
      const position = await exchange.readActivePosition(symbol, side);
      if (!isBotOwned) {
        if (!position) {
          symbolState.set({
            mode: 'IDLE',
            lastExitAt: Date.now(),
            lastExitReason: 'EXCLUDED_POSITION_NOW_FLAT',
            probeModeActive: false,
          });
          logger.warn('aegis_excluded_position_now_flat', {
            symbol,
            side,
            ownershipStatus: botState.ownershipStatus ?? 'UNKNOWN',
            exclusionReason: botState.metricsExclusionReason ?? 'UNVERIFIED_OWNERSHIP',
            metricsUpdated: false,
          });
          return;
        }
        logger.warn('aegis_manual_external_position_observed', {
          symbol,
          side,
          qtyAbs: position.qtyAbs,
          leverage: position.leverage,
          ownershipStatus: botState.ownershipStatus ?? 'UNKNOWN',
          action: 'MANAGE_GUARDS_AND_FILL_MISSING_BRACKETS',
        });
      }
      if (!position) {
        const balance = await exchange.getUSDTBalance();
        const markPrice = await exchange.getMarkPrice(symbol);
        const finalRoe = this.ports.calculateRoe(
          side,
          botState.lastEntryPrice || markPrice,
          markPrice,
          leverage,
        );
        logger.info('aegis_position_closed', {
          symbol,
          pnl: 'UNKNOWN_EXACT_CLOSE_UNAVAILABLE',
          balance: balance.toFixed(2),
          consecutiveLosses: this.ports.consecutiveLosses(),
        });
        await this.ports.notifyExit(symbol, side, 'SL/TP', botState, {
          exitPrice: markPrice,
          finalRoe,
        });
        symbolState.set({
          mode: 'IDLE',
          lastExitAt: Date.now(),
          lastExitReason: 'SL/TP',
          lastStopLossAt: botState.lastStopLossAt,
          probeModeActive: false,
        });
        return;
      }

      entryPrice = position.entryPrice > 0 ? position.entryPrice : entryPrice;
      leverage = position.leverage > 0 ? position.leverage : leverage;
      symbolState.set({
        lastEntryPrice: entryPrice,
        lastLeverage: leverage,
        lastActualLeverage: leverage,
        lastEntryMargin: position.isolatedMargin ?? botState.lastEntryMargin,
        posSideMode: position.sideMode,
      });

      if (isBotOwned && lifecyclePolicy.allowManualQuantityReconciliation) {
        const quantityChangeResult = await this.ports.reconcilePositionSize({
          symbol,
          side,
          leverage,
          position,
          botState,
          symbolState,
        });
        if (quantityChangeResult.changed) {
          entryPrice = position.entryPrice || entryPrice;
          leverage = position.leverage || leverage;
          if (requireBrackets) {
            try {
              await this.ports.replaceBracketsForNewEntryPrice(
                symbol,
                side,
                entryPrice,
                leverage,
                position,
                botState,
              );
            } catch (bracketError) {
              logger.error('aegis_bracket_recreate_failed', {
                symbol,
                side,
                error: String(bracketError),
              });
            }
          }
        } else if (requireBrackets) {
          try {
            await this.ports.ensureBrackets(symbol, side, entryPrice, leverage, position, botState);
          } catch (bracketError) {
            logger.error('aegis_bracket_recreate_failed', {
              symbol,
              side,
              error: String(bracketError),
            });
            await notifier.sendAlert(
              'AEGIS BRACKET RECREATE FAILED',
              `${symbol} | ${side}\n${String(bracketError).slice(0, 180)}`,
            );
          }
        }
      } else {
        symbolState.set({ lastEntryQty: position.qtyAbs });
        if (!botState.lastEntryAt) {
          symbolState.set({
            lastEntryAt: Date.now(),
            lastTrailStop: undefined,
            lastBreakEvenStop: undefined,
            lastStopPrice: undefined,
            highestRatchetStop: undefined,
          });
        }
        if (requireBrackets) {
          try {
            const brackets = await this.ports.ensureBrackets(
              symbol,
              side,
              entryPrice,
              leverage,
              position,
              symbolState.get(),
              {
                stopRoe: MANUAL_POSITION_DEFAULT_STOP_ROE,
                takeProfitRoe: MANUAL_POSITION_DEFAULT_TAKE_PROFIT_ROE,
              },
            );
            const rememberedStop =
              botState.lastTrailStop ?? botState.lastBreakEvenStop ?? botState.lastStopPrice;
            if (
              brackets.stopPrice !== undefined &&
              this.ports.isBetterStop(side, brackets.stopPrice, rememberedStop)
            ) {
              symbolState.set({
                lastTrailStop: brackets.stopPrice,
                lastStopPrice: brackets.stopPrice,
              });
            }
          } catch (bracketError) {
            logger.error('aegis_manual_position_bracket_create_failed', {
              symbol,
              side,
              error: String(bracketError),
            });
            await notifier.sendAlert(
              'AEGIS MANUAL POSITION UNPROTECTED',
              `${symbol} | ${side}\nNo se pudieron completar los brackets: ${String(bracketError).slice(0, 180)}`,
            );
          }
        }
        logger.info('aegis_manual_position_exit_logic_active', {
          symbol,
          side,
          entryPrice,
          leverage,
          action: 'TRAILING_BREAK_EYE_ACTIVE_MISSING_BRACKETS_FILLED',
        });
      }

      const markPrice = await exchange.getMarkPrice(symbol);
      const candle = await exchange.getLastCandle(symbol);
      let peakPrice = botState.lastPeakPrice || entryPrice;
      if (candle)
        peakPrice =
          side === 'SHORT' ? Math.min(peakPrice, candle.low) : Math.max(peakPrice, candle.high);
      if (peakPrice !== botState.lastPeakPrice) symbolState.set({ lastPeakPrice: peakPrice });

      const currentRoe =
        side === 'SHORT'
          ? ((entryPrice - markPrice) / entryPrice) * leverage
          : ((markPrice - entryPrice) / entryPrice) * leverage;
      const updatedPeakRoe = Math.max(botState.peakRoe || 0, currentRoe);
      const updatedLowestRoe = Math.min(botState.lowestRoe || 0, currentRoe);
      if (updatedPeakRoe !== botState.peakRoe || updatedLowestRoe !== botState.lowestRoe) {
        symbolState.set({ peakRoe: updatedPeakRoe, lowestRoe: updatedLowestRoe });
      }

      const serverNow = await exchange.getServerTime();
      const tradeDuration = botState.lastEntryAt ? serverNow - botState.lastEntryAt : 0;
      const regimeConfig = this.ports.getRegimeConfig(symbol);
      if (aegisExitEye) {
        const exitEyeClosed = await aegisExitEye({
          symbol,
          side,
          botState: symbolState.get(),
          symbolState,
          position,
          markPrice,
          currentRoe,
          peakRoe: updatedPeakRoe,
          lowestRoe: updatedLowestRoe,
          tradeDurationMs: tradeDuration,
        });
        if (exitEyeClosed) return;
      }

      // Do not replace an entry's frozen policy with a later regime reload.
      const maxHoldMs = botState.lastMaxHoldMs ?? regimeConfig?.maxHoldMs ?? DEFAULT_MAX_HOLD_MS;
      if (tradeDuration > maxHoldMs && currentRoe > 0.02) {
        const timeLimitReason =
          lifecyclePolicy.strategyId === 'MOMENTUM_RIDE'
            ? 'MOMENTUM_TIME_LIMIT'
            : lifecyclePolicy.strategyId === 'EXTERNAL'
              ? 'MANUAL_TIME_LIMIT'
              : 'AEGIS_TIME_LIMIT';
        await exchange.closeSideMarketSafe(
          symbol,
          side,
          position.qtyAbs,
          position.sideMode,
          timeLimitReason,
        );
        symbolState.set({
          mode: 'IDLE',
          lastExitAt: Date.now(),
          lastExitReason: timeLimitReason,
          probeModeActive: false,
        });
        await this.ports.notifyExit(symbol, side, timeLimitReason, botState, {
          exitPrice: markPrice,
          finalRoe: currentRoe,
        });
        return;
      }

      if (!lifecyclePolicy.useLegacyProfitGuardian) {
        logger.debug('strategy_position_guardian_disabled', {
          symbol,
          strategyId: lifecyclePolicy.strategyId,
          tradeId: botState.lastTradeId,
        });
        return;
      }

      const now = Date.now();
      let currentAtr = botState.lastAtrValue;
      if (now - (botState.lastAtrFetchedAt || 0) > 60000) {
        try {
          const klines = await exchange.getCandles(symbol, '5m', 15);
          const atr = calculateATR(klines, 14);
          if (atr) {
            currentAtr = atr;
            symbolState.set({ lastAtrFetchedAt: now, lastAtrValue: atr });
          }
        } catch {}
      }

      const baseGuardianConfig = this.ports.getGuardianConfig(symbol, regimeConfig);
      const guardianConfig: GuardianConfig = {
        ...baseGuardianConfig,
        beTriggerRoe:
          botState.lastBreakEvenRoe ??
          baseGuardianConfig.beTriggerRoe ??
          DEFAULT_GUARDIAN_CONFIG.beTriggerRoe,
        trailingActivationRoe:
          botState.lastTrailingActivationRoe ?? baseGuardianConfig.trailingActivationRoe ?? 0.15,
        trailingCallbackRoe:
          botState.lastTrailingCallbackRoe ?? baseGuardianConfig.trailingCallbackRoe ?? 0.08,
        useAtrTrailing: true,
        atrMultiplier: 1.5,
      };
      const previousPeakRoe = botState.peakRoe ?? 0;
      if (
        lifecyclePolicy.useBreakEven &&
        previousPeakRoe < guardianConfig.beTriggerRoe &&
        updatedPeakRoe >= guardianConfig.beTriggerRoe
      ) {
        symbolState.set({ breakEvenArmed: true, lastBreakEvenRoe: guardianConfig.beTriggerRoe });
        await this.ports.logTradeEvent(lifecyclePolicy.strategyId, symbol, 'BREAK_EVEN_ARMED', {
          tradeId: botState.lastTradeId,
          price: markPrice,
          roe: currentRoe,
          metadata: { peakRoe: updatedPeakRoe, beRoe: guardianConfig.beTriggerRoe },
        });
      }
      if (
        lifecyclePolicy.useTrailing &&
        guardianConfig.trailingActivationRoe !== undefined &&
        previousPeakRoe < guardianConfig.trailingActivationRoe &&
        updatedPeakRoe >= guardianConfig.trailingActivationRoe
      ) {
        await this.ports.logTradeEvent(lifecyclePolicy.strategyId, symbol, 'TRAILING_ACTIVATED', {
          tradeId: botState.lastTradeId,
          price: markPrice,
          roe: currentRoe,
          metadata: { peakRoe: updatedPeakRoe },
        });
      }
      const action = evaluateGuardianAction(
        {
          entryPrice,
          currentPrice: markPrice,
          peakPrice,
          positionSide: side,
          leverage,
          peakRoe: updatedPeakRoe,
          atrValue: currentAtr,
        },
        guardianConfig,
        botState.lastTrailStop ?? botState.lastBreakEvenStop ?? botState.lastStopPrice,
      );

      if (lifecyclePolicy.useBreakEven && action.type === 'MOVE_SL_BE' && action.price) {
        const filters = await exchange.getSymbolFilters(symbol, leverage);
        const breakEvenPrice = this.ports.roundPrice(action.price, filters);
        const existingStop =
          botState.lastTrailStop ?? botState.lastBreakEvenStop ?? botState.lastStopPrice;
        const shouldMoveBreakEven =
          !botState.breakEvenExecuted &&
          this.ports.isBetterStop(side, breakEvenPrice, existingStop);
        if (shouldMoveBreakEven) {
          const moveResult = await this.ports.safeMoveCloseStop({
            symbol,
            side,
            tradeId: botState.lastTradeId,
            entryPrice,
            markPrice,
            leverage,
            quantity: position.qtyAbs,
            position,
            newStopPrice: breakEvenPrice,
            currentRoe,
            peakRoe: updatedPeakRoe,
            protectedRoe: guardianConfig.beTriggerRoe,
            reason: 'MOVE_SL_BE',
            useClosePosition: !isBotOwned,
          });
          if (moveResult.moved) {
            symbolState.set({
              breakEvenArmed: true,
              breakEvenExecuted: true,
              lastBreakEvenAt: Date.now(),
              lastBreakEvenRoe: guardianConfig.beTriggerRoe,
              lastBreakEvenStop: breakEvenPrice,
              lastTrailStop: breakEvenPrice,
              lastStopPrice: breakEvenPrice,
            });
            logger.info('aegis_break_even_stop_moved', {
              symbol,
              side,
              entryPrice,
              oldStopPrice: moveResult.oldStopPrice ?? existingStop,
              newStopPrice: breakEvenPrice,
              currentRoe,
              peakRoe: updatedPeakRoe,
              beRoe: guardianConfig.beTriggerRoe,
            });
            await this.ports.logTradeEvent(lifecyclePolicy.strategyId, symbol, 'BREAK_EVEN_EXECUTED', {
              tradeId: botState.lastTradeId,
              price: markPrice,
              roe: currentRoe,
              oldStop: moveResult.oldStopPrice ?? existingStop,
              newStop: breakEvenPrice,
              reason: 'MOVE_SL_BE',
              metadata: {
                symbol,
                side,
                entryPrice,
                oldStopPrice: moveResult.oldStopPrice ?? existingStop,
                newStopPrice: breakEvenPrice,
                currentRoe,
                peakRoe: updatedPeakRoe,
                beRoe: guardianConfig.beTriggerRoe,
                reason: 'MOVE_SL_BE',
              },
            });
            await notifier.sendMessage(
              `🟢 **BREAK-EVEN ACTIVADO**\n${symbol} ${side}\nSL movido a BE: $${breakEvenPrice}\nROE: ${this.ports.formatRoe(currentRoe)}`,
            );
          } else if (moveResult.reason === 'exchange_error') {
            logger.error('aegis_break_even_stop_move_failed', {
              symbol,
              side,
              entryPrice,
              attemptedStopPrice: breakEvenPrice,
              currentRoe,
              peakRoe: updatedPeakRoe,
              beRoe: guardianConfig.beTriggerRoe,
              error: moveResult.error,
            });
            await this.ports.logTradeEvent(lifecyclePolicy.strategyId, symbol, 'BREAK_EVEN_FAILED', {
              tradeId: botState.lastTradeId,
              price: markPrice,
              roe: currentRoe,
              oldStop: moveResult.oldStopPrice ?? existingStop,
              newStop: breakEvenPrice,
              reason: 'MOVE_SL_BE_FAILED',
              metadata: {
                symbol,
                side,
                entryPrice,
                oldStopPrice: moveResult.oldStopPrice ?? existingStop,
                newStopPrice: breakEvenPrice,
                currentRoe,
                peakRoe: updatedPeakRoe,
                beRoe: guardianConfig.beTriggerRoe,
                error: moveResult.error,
              },
            });
            await notifier.sendAlert(
              'AEGIS BREAK-EVEN FAILED',
              `${symbol} ${side}\nSL BE: ${breakEvenPrice}\n${String(moveResult.error || '').slice(0, 180)}`,
            );
          }
        }
      } else if (
        lifecyclePolicy.useTrailing &&
        action.type === 'MOVE_SL_TRAILING' &&
        action.price
      ) {
        const filters = await exchange.getSymbolFilters(symbol, leverage);
        const trailingPrice = this.ports.roundPrice(action.price, filters);
        const moveResult = await this.ports.safeMoveCloseStop({
          symbol,
          side,
          tradeId: botState.lastTradeId,
          entryPrice,
          markPrice,
          leverage,
          quantity: position.qtyAbs,
          position,
          newStopPrice: trailingPrice,
          currentRoe,
          peakRoe: updatedPeakRoe,
          reason: 'MOVE_SL_TRAILING',
          useClosePosition: !isBotOwned,
        });
        if (moveResult.moved) {
          symbolState.set({ lastTrailStop: trailingPrice, lastStopPrice: trailingPrice });
          logger.info('aegis_trailing_stop_updated', { symbol, side, trailingPrice });
          await this.ports.logTradeEvent(lifecyclePolicy.strategyId, symbol, 'SL_MOVED', {
            tradeId: botState.lastTradeId,
            price: markPrice,
            roe: currentRoe,
            oldStop: moveResult.oldStopPrice,
            newStop: trailingPrice,
            reason: 'MOVE_SL_TRAILING',
          });
        }
      } else if (action.type === 'CLOSE_MARKET') {
        await exchange.closeSideMarketSafe(
          symbol,
          side,
          position.qtyAbs,
          position.sideMode,
          action.reason,
        );
        symbolState.set({
          mode: 'IDLE',
          lastExitAt: Date.now(),
          lastExitReason: action.reason,
          probeModeActive: false,
        });
        await this.ports.notifyExit(symbol, side, action.reason, botState, {
          exitPrice: markPrice,
          finalRoe: currentRoe,
        });
      }
    } catch (error) {
      logger.warn('strategy_position_management_error', {
        symbol,
        strategyId: lifecyclePolicy.strategyId,
        error: String(error),
      });
    }
  }
}
