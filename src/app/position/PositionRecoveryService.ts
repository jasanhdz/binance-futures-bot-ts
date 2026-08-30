import type { BotState, Side } from '../../core/types';
import type { Exchange, PositionInfo } from '../ports/Exchange';
import type { Logger } from '../ports/Logger';
import type { Notifier } from '../ports/Notifier';
import type { StateStore } from '../ports/StateStore';

const MANUAL_POSITION_DEFAULT_STOP_ROE = -0.4;
const MANUAL_POSITION_DEFAULT_TAKE_PROFIT_ROE = 1.0;

export interface PositionRecoveryServicePorts {
  exchange: Exchange;
  logger: Logger;
  notifier: Notifier;
  globalState: StateStore;
  configSymbols: readonly string[];
  getLiveSymbols(): string[];
  stateForSymbol(symbol: string): StateStore;
  isVerifiedBotOwnedState(state: BotState): boolean;
  isLegacyBotOwnedState(state: BotState): boolean;
  requireBrackets(): boolean;
  ensureBrackets(
    symbol: string,
    side: Side,
    entryPrice: number,
    leverage: number,
    position: PositionInfo,
    state: BotState,
    roeOverrides?: { stopRoe: number; takeProfitRoe: number },
  ): Promise<{ stopPrice?: number; takeProfitPrice?: number }>;
}

/**
 * Owns restart recovery and adoption of manual/external exchange positions.
 *
 * This service intentionally has no entry-strategy authority. It can recover
 * state and restore protective brackets, but it cannot create strategy entry
 * intents or reclassify an external position as Aegis/Momentum/Micro Burst.
 */
export class PositionRecoveryService {
  constructor(private readonly ports: PositionRecoveryServicePorts) {}

  async migrateLegacyGlobalStateToFirstLiveSymbol(): Promise<void> {
    const { globalState, logger } = this.ports;
    if (typeof globalState.forSymbol !== 'function') return;
    const legacyState = globalState.get();
    if (legacyState.mode === 'IDLE') return;
    const symbol = this.ports.getLiveSymbols()[0] ?? this.ports.configSymbols[0];
    if (!symbol) return;

    const symbolState = this.ports.stateForSymbol(symbol);
    if (symbolState.get().mode !== 'IDLE') return;

    symbolState.set(legacyState);
    globalState.set({
      mode: 'IDLE',
      lastExitAt: legacyState.lastExitAt ?? Date.now(),
      lastExitReason: 'MIGRATED_TO_SYMBOL_STATE',
    });
    logger.warn('aegis_legacy_global_state_migrated_to_symbol', {
      symbol,
      stateMode: legacyState.mode,
      lastSide: legacyState.lastSide,
    });
  }

  async attachOpenExchangePositionsToSymbolState(): Promise<void> {
    const { globalState, exchange, logger, notifier } = this.ports;
    if (typeof globalState.forSymbol !== 'function') return;

    for (const symbol of this.ports.getLiveSymbols()) {
      const symbolState = this.ports.stateForSymbol(symbol);
      const localState = symbolState.get();
      if (
        localState.mode !== 'IDLE' &&
        this.ports.isVerifiedBotOwnedState(localState) &&
        !localState.lastOrderId
      ) {
        symbolState.set({
          positionOwner: 'UNKNOWN',
          tradeOrigin: 'UNKNOWN',
          ownershipStatus: 'UNKNOWN',
          eligibleForBotMetrics: false,
          metricsExclusionReason: 'ENTRY_ORDER_ID_MISSING_AFTER_RESTART',
        });
        logger.warn('aegis_bot_position_ownership_unresolved_after_restart', {
          symbol,
          reason: 'ENTRY_ORDER_ID_MISSING_AFTER_RESTART',
        });
      }
      if (localState.mode !== 'IDLE' && !this.ports.isVerifiedBotOwnedState(localState)) {
        if (this.ports.isLegacyBotOwnedState(localState)) {
          symbolState.set({
            positionOwner: 'BOT',
            tradeOrigin: 'BOT',
            ownershipStatus: 'VERIFIED',
            eligibleForBotMetrics: false,
            metricsExclusionReason: 'LEGACY_BOT_POSITION',
          });
          logger.warn('aegis_legacy_bot_position_recovered', {
            symbol,
            side: localState.lastSide,
            tradeId: localState.lastTradeId,
            ownership: 'AEGIS_LEGACY',
            eligibleForBotMetrics: false,
          });
        } else {
          symbolState.set({
            positionOwner: 'UNKNOWN',
            tradeOrigin: 'UNKNOWN',
            ownershipStatus: 'UNKNOWN',
            eligibleForBotMetrics: false,
            metricsExclusionReason: 'LEGACY_OR_UNVERIFIED_LOCAL_STATE',
          });
          logger.warn('aegis_unverified_local_position_state_excluded', {
            symbol,
            side: localState.lastSide,
            ownership: 'UNKNOWN',
            reason: 'LEGACY_OR_UNVERIFIED_LOCAL_STATE',
          });
        }
      }

      for (const side of ['LONG', 'SHORT'] as Side[]) {
        let position: PositionInfo | null;
        try {
          position = await exchange.readActivePosition(symbol, side);
        } catch (error) {
          logger.error('aegis_external_position_ownership_read_failed', {
            symbol,
            side,
            error: String(error),
            entryPolicy: 'FAIL_CLOSED',
          });
          continue;
        }
        if (!position) continue;

        const currentState = symbolState.get();
        if (
          currentState.mode !== 'IDLE' &&
          (this.ports.isVerifiedBotOwnedState(currentState) ||
            this.ports.isLegacyBotOwnedState(currentState)) &&
          currentState.lastSide === side
        ) {
          break;
        }
        const recoveringSamePosition =
          currentState.mode !== 'IDLE' &&
          currentState.lastSide === side &&
          currentState.lastEntryPrice !== undefined &&
          Math.abs(currentState.lastEntryPrice - position.entryPrice) <=
            Math.max(1e-12, position.entryPrice * 1e-6);

        symbolState.set({
          mode: side === 'LONG' ? 'LONG_RIDE' : 'SHORT_RIDE',
          lastSide: side,
          lastEntryPrice: position.entryPrice,
          lastLeverage: position.leverage,
          lastActualLeverage: position.leverage,
          lastEntryQty: position.qtyAbs,
          lastEntryMargin: position.isolatedMargin,
          posSideMode: position.sideMode,
          lastEntryAt: Date.now(),
          lastTradeId: `MANUAL-${symbol}-${Date.now()}`,
          positionOwner: 'EXTERNAL',
          tradeOrigin: 'MANUAL_EXTERNAL',
          ownershipStatus: 'UNKNOWN',
          eligibleForBotMetrics: false,
          metricsExclusionReason: 'MANUAL_POSITION',
          lastTrailStop: recoveringSamePosition ? currentState.lastTrailStop : undefined,
          lastBreakEvenStop: recoveringSamePosition ? currentState.lastBreakEvenStop : undefined,
          lastStopPrice: recoveringSamePosition ? currentState.lastStopPrice : undefined,
          breakEvenArmed: recoveringSamePosition ? currentState.breakEvenArmed : false,
          breakEvenExecuted: recoveringSamePosition ? currentState.breakEvenExecuted : false,
          peakRoe: recoveringSamePosition ? currentState.peakRoe : 0,
          lowestRoe: recoveringSamePosition ? currentState.lowestRoe : 0,
          lastPeakPrice: recoveringSamePosition ? currentState.lastPeakPrice : position.entryPrice,
        });
        logger.warn('aegis_manual_external_position_adopted', {
          symbol,
          side,
          qtyAbs: position.qtyAbs,
          entryPrice: position.entryPrice,
          leverage: position.leverage,
          ownership: 'MANUAL/EXTERNAL',
          action: 'MANAGE_GUARDS_AND_FILL_MISSING_BRACKETS',
        });

        if (this.ports.requireBrackets()) {
          try {
            const brackets = await this.ports.ensureBrackets(
              symbol,
              side,
              position.entryPrice,
              position.leverage,
              position,
              symbolState.get(),
              {
                stopRoe: MANUAL_POSITION_DEFAULT_STOP_ROE,
                takeProfitRoe: MANUAL_POSITION_DEFAULT_TAKE_PROFIT_ROE,
              },
            );
            if (brackets.stopPrice !== undefined) {
              symbolState.set({
                lastStopPrice: brackets.stopPrice,
                lastTrailStop: recoveringSamePosition ? brackets.stopPrice : undefined,
              });
            }
          } catch (error) {
            logger.error('aegis_manual_position_bracket_create_failed', {
              symbol,
              side,
              error: String(error),
            });
            await notifier.sendAlert(
              'AEGIS MANUAL POSITION UNPROTECTED',
              `${symbol} | ${side}\nNo se pudieron completar los brackets: ${String(error).slice(0, 180)}`,
            );
          }
        }
        break;
      }
    }
  }

  async tryAdoptManualPositionRuntime(symbol: string): Promise<boolean> {
    const { exchange, logger, notifier } = this.ports;
    const symbolState = this.ports.stateForSymbol(symbol);
    const currentState = symbolState.get();
    if (currentState.mode !== 'IDLE') return false;

    let hasPosition = false;
    try {
      hasPosition = await exchange.hasOpenPosition(symbol, 'ANY');
    } catch {
      return false;
    }
    if (!hasPosition) return false;

    for (const side of ['LONG', 'SHORT'] as Side[]) {
      let position: PositionInfo | null;
      try {
        position = await exchange.readActivePosition(symbol, side);
      } catch {
        continue;
      }
      if (!position) continue;

      symbolState.set({
        mode: side === 'LONG' ? 'LONG_RIDE' : 'SHORT_RIDE',
        lastSide: side,
        lastEntryPrice: position.entryPrice,
        lastLeverage: position.leverage,
        lastActualLeverage: position.leverage,
        lastEntryQty: position.qtyAbs,
        lastEntryMargin: position.isolatedMargin,
        posSideMode: position.sideMode,
        lastEntryAt: Date.now(),
        lastTradeId: `MANUAL-${symbol}-${Date.now()}`,
        positionOwner: 'EXTERNAL',
        tradeOrigin: 'MANUAL_EXTERNAL',
        ownershipStatus: 'UNKNOWN',
        eligibleForBotMetrics: false,
        metricsExclusionReason: 'MANUAL_POSITION',
        lastTrailStop: undefined,
        lastBreakEvenStop: undefined,
        lastStopPrice: undefined,
        breakEvenArmed: false,
        breakEvenExecuted: false,
        peakRoe: 0,
        lowestRoe: 0,
        lastPeakPrice: position.entryPrice,
      });
      logger.warn('aegis_manual_position_adopted_runtime', {
        symbol,
        side,
        qtyAbs: position.qtyAbs,
        entryPrice: position.entryPrice,
        leverage: position.leverage,
      });

      if (this.ports.requireBrackets()) {
        try {
          const brackets = await this.ports.ensureBrackets(
            symbol,
            side,
            position.entryPrice,
            position.leverage,
            position,
            symbolState.get(),
            {
              stopRoe: MANUAL_POSITION_DEFAULT_STOP_ROE,
              takeProfitRoe: MANUAL_POSITION_DEFAULT_TAKE_PROFIT_ROE,
            },
          );
          if (brackets.stopPrice !== undefined) {
            symbolState.set({
              lastStopPrice: brackets.stopPrice,
              lastTrailStop: brackets.stopPrice,
            });
          }
        } catch (error) {
          logger.error('aegis_manual_position_bracket_create_failed', {
            symbol,
            side,
            error: String(error),
          });
          await notifier.sendAlert(
            'AEGIS MANUAL POSITION UNPROTECTED',
            `${symbol} | ${side}\nNo se pudieron completar los brackets: ${String(error).slice(0, 180)}`,
          );
        }
      }
      return true;
    }
    return false;
  }
}
