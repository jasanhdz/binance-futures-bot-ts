import { BotState, Side } from '../../core/types';
import { PositionInfo, SymbolFilters, TradingExchangePort } from '../ports/Exchange';
import { Logger } from '../ports/Logger';
import { RegimeConfig } from '../ports/RegimeStrategy';
import { StateStore } from '../ports/StateStore';
import {
  LifecycleTradeEventInput,
  SafeStopMoveInput,
  SafeStopMoveResult,
} from './StrategyPositionLifecycleCore';

type SafeStopMoveSkipReason =
  | 'immediate_trigger_risk'
  | 'stop_not_improved'
  | 'missing_position'
  | 'missing_entry'
  | 'missing_leverage'
  | 'missing_quantity'
  | 'exchange_error';

export type MicroProtectionStatus =
  | 'PROTECTED'
  | 'UNKNOWN'
  | 'MISSING'
  | 'CONFIRMATION_PENDING'
  | 'RECOVERY_REQUIRED';

export interface MicroProtectionResult {
  status: MicroProtectionStatus;
  reason?: string;
  stopPrice?: number;
}

export interface PositionProtectionServiceDeps {
  exchange: TradingExchangePort;
  logger: Logger;
  getRegimeConfig(symbol: string): RegimeConfig | undefined;
  getImmediateTriggerBufferPct(): number;
  logTradeEvent(symbol: string, event: string, input?: LifecycleTradeEventInput): Promise<void>;
  microStopConfirmationAttempts?: number;
  microStopConfirmationDelaysMs?: readonly number[];
  wait?: (delayMs: number) => Promise<void>;
}

export class PositionProtectionService {
  constructor(private readonly deps: PositionProtectionServiceDeps) {}

  /** Micro owns its exit policy: restore only a full-position stop, never a TP/trailing. */
  async ensureMicroStop(symbol: string, state: BotState): Promise<void> {
    const result = await this.superviseMicroStop(symbol, state);
    if (result.status !== 'PROTECTED' && result.status !== 'MISSING') {
      throw new Error(result.reason ?? `MICRO_STOP_${result.status}`);
    }
  }

  async superviseMicroStop(symbol: string, state: BotState): Promise<MicroProtectionResult> {
    const side = state.lastSide;
    if (!side) return { status: 'RECOVERY_REQUIRED', reason: 'MICRO_STOP_SIDE_UNKNOWN' };
    const exchange = this.deps.exchange;
    let position: PositionInfo | null;
    try {
      position = await exchange.readActivePosition(symbol, side);
    } catch (error) {
      return { status: 'UNKNOWN', reason: `POSITION_READ_FAILED:${String(error)}` };
    }
    if (!position) return { status: 'MISSING' }; // Closure accounting is a separate reconciliation concern.
    const coversPosition = (
      order: Awaited<ReturnType<TradingExchangePort['listCloseOrdersForSide']>>[number],
    ) =>
      (order.type === 'STOP_MARKET' || order.type === 'STOP') &&
      Number.isFinite(order.stopPrice) &&
      order.stopPrice > 0 &&
      (!order.positionSide || order.positionSide === 'BOTH' || order.positionSide === side) &&
      (!order.side || order.side === (side === 'LONG' ? 'SELL' : 'BUY')) &&
      order.owner !== 'UNKNOWN' &&
      (order.closePosition === true ||
        (order.reduceOnly === true && Number(order.quantity) >= position.qtyAbs));
    let confirmationReadUnknown = false;
    const hasConfirmedStop = async (): Promise<boolean> => {
      const attempts = Math.max(1, this.deps.microStopConfirmationAttempts ?? 3);
      const delays = this.deps.microStopConfirmationDelaysMs ?? [250, 500];
      for (let attempt = 0; attempt < attempts; attempt++) {
        try {
          if ((await exchange.listCloseOrdersForSide(symbol, side)).some(coversPosition))
            return true;
        } catch {
          // Retry observation, never submission. Only positive stop evidence
          // can resolve uncertainty during this confirmation window.
          confirmationReadUnknown = true;
        }
        if (attempt < attempts - 1) {
          const delay = delays[Math.min(attempt, delays.length - 1)] ?? 0;
          await (this.deps.wait?.(Math.max(0, delay)) ??
            new Promise((resolve) => setTimeout(resolve, delay)));
        }
      }
      return false;
    };
    if (await hasConfirmedStop()) return { status: 'PROTECTED' };
    if (confirmationReadUnknown) {
      return { status: 'UNKNOWN', reason: 'CLOSE_ORDER_READ_FAILED' };
    }
    const remembered = [state.lastStopPrice, state.microBurstStructuralStopPrice].filter(
      (price): price is number => typeof price === 'number' && Number.isFinite(price) && price > 0,
    );
    if (!remembered.length)
      return { status: 'RECOVERY_REQUIRED', reason: 'MICRO_STOP_PRICE_UNKNOWN' };
    const stopPrice = side === 'LONG' ? Math.max(...remembered) : Math.min(...remembered);
    let markPrice: number;
    try {
      markPrice = await exchange.getMarkPrice(symbol);
    } catch (error) {
      return { status: 'UNKNOWN', reason: `MARK_PRICE_READ_FAILED:${String(error)}` };
    }
    if (
      this.wouldStopTriggerImmediately(
        side,
        stopPrice,
        markPrice,
        this.deps.getImmediateTriggerBufferPct(),
      )
    ) {
      return { status: 'RECOVERY_REQUIRED', reason: 'MICRO_STOP_IMMEDIATE_TRIGGER_RISK' };
    }
    let filters: SymbolFilters;
    try {
      filters = await exchange.getSymbolFilters(symbol, position.leverage);
    } catch (error) {
      return { status: 'UNKNOWN', reason: `FILTER_READ_FAILED:${String(error)}` };
    }
    const effectiveStopPrice = this.roundStopPriceForSide(side, stopPrice, filters);
    if (
      this.wouldStopTriggerImmediately(
        side,
        effectiveStopPrice,
        markPrice,
        this.deps.getImmediateTriggerBufferPct(),
      )
    ) {
      return { status: 'RECOVERY_REQUIRED', reason: 'MICRO_STOP_INVALID_AFTER_ROUNDING' };
    }
    let placed: boolean;
    try {
      placed = await exchange.placeStopClose(symbol, side, effectiveStopPrice);
    } catch (error) {
      return {
        status: 'RECOVERY_REQUIRED',
        reason: `MICRO_STOP_PLACEMENT_FAILED:${String(error)}`,
      };
    }
    if (!placed) return { status: 'RECOVERY_REQUIRED', reason: 'MICRO_STOP_REJECTED' };
    if (!(await hasConfirmedStop())) {
      if (confirmationReadUnknown) {
        return {
          status: 'UNKNOWN',
          reason: 'CLOSE_ORDER_READ_FAILED',
          stopPrice: effectiveStopPrice,
        };
      }
      return { status: 'CONFIRMATION_PENDING', stopPrice: effectiveStopPrice };
    }
    this.deps.logger.info('micro_stop_restored', {
      symbol,
      side,
      requestedStopPrice: stopPrice,
      effectiveStopPrice,
      tradeId: state.lastTradeId,
    });
    return { status: 'PROTECTED', stopPrice: effectiveStopPrice };
  }

  roundQuantity(quantity: number, filters: SymbolFilters): number {
    const scale = 10 ** filters.qtyPrecision;
    return Number((Math.floor(quantity * scale) / scale).toFixed(filters.qtyPrecision));
  }

  roundPrice(price: number, filters: SymbolFilters): number {
    const precision = Number.isInteger(filters.pricePrecision) ? filters.pricePrecision : 2;
    return Number(price.toFixed(precision));
  }

  roundStopPriceForSide(side: Side, price: number, filters: SymbolFilters): number {
    const tickSize = filters.tickSize;
    if (!Number.isFinite(tickSize) || tickSize <= 0) return this.roundPrice(price, filters);
    const ticks = price / tickSize;
    const roundedTicks = side === 'LONG' ? Math.ceil(ticks - 1e-12) : Math.floor(ticks + 1e-12);
    return Number((roundedTicks * tickSize).toFixed(filters.pricePrecision));
  }

  isBetterStop(side: Side, next: number, previous?: number): boolean {
    if (previous === undefined) return true;
    return side === 'LONG' ? next > previous : next < previous;
  }

  bracketPrice(
    side: Side,
    entryPrice: number,
    roe: number,
    leverage: number,
    kind: 'STOP' | 'TP',
  ): number {
    const move = Math.abs(roe) / leverage;
    if (kind === 'STOP') {
      return side === 'LONG' ? entryPrice * (1 - move) : entryPrice * (1 + move);
    }
    return side === 'LONG' ? entryPrice * (1 + move) : entryPrice * (1 - move);
  }

  async ensureBrackets(
    symbol: string,
    side: Side,
    entryPrice: number,
    leverage: number,
    _position: PositionInfo,
    botState: BotState,
    roeOverrides?: { stopRoe: number; takeProfitRoe: number },
  ): Promise<{ stopPrice?: number; takeProfitPrice?: number }> {
    const { exchange, logger } = this.deps;
    const openOrders = await exchange.listCloseOrdersForSide(symbol, side);
    const stopOrders = openOrders.filter((order) => order.type.includes('STOP'));
    const tpOrders = openOrders.filter((order) => order.type.includes('TAKE_PROFIT'));
    const hasSL = stopOrders.length > 0;
    const hasTP = tpOrders.length > 0;
    let activeStopPrice = hasSL
      ? side === 'LONG'
        ? Math.max(...stopOrders.map((order) => order.stopPrice))
        : Math.min(...stopOrders.map((order) => order.stopPrice))
      : undefined;
    let activeTakeProfitPrice = tpOrders[0]?.stopPrice;
    if (hasSL && hasTP) {
      return { stopPrice: activeStopPrice, takeProfitPrice: activeTakeProfitPrice };
    }

    await this.deps.logTradeEvent(symbol, 'BRACKET_MISSING', {
      tradeId: botState.lastTradeId,
      reason: !hasSL && !hasTP ? 'SL_AND_TP_MISSING' : !hasSL ? 'SL_MISSING' : 'TP_MISSING',
      metadata: { hasSL, hasTP },
    });

    const filters = await exchange.getSymbolFilters(symbol, leverage);
    const regimeConfig = this.deps.getRegimeConfig(symbol);
    if (!hasSL) {
      const configuredStopPrice = this.roundPrice(
        this.bracketPrice(
          side,
          entryPrice,
          roeOverrides?.stopRoe ?? botState.lastStopRoe ?? regimeConfig?.hardStopRoe ?? -0.15,
          leverage,
          'STOP',
        ),
        filters,
      );
      const rememberedStops = [
        botState.lastTrailStop,
        botState.lastBreakEvenStop,
        botState.lastStopPrice,
        botState.highestRatchetStop,
      ].filter((value): value is number => Number.isFinite(value));
      const stopPrice = rememberedStops.reduce(
        (best, remembered) => (this.isBetterStop(side, remembered, best) ? remembered : best),
        configuredStopPrice,
      );
      await exchange.placeStopClose(symbol, side, stopPrice);
      activeStopPrice = stopPrice;
      logger.info('aegis_turbo_brackets_created', { symbol, side, stopPrice, recreated: true });
      await this.deps.logTradeEvent(symbol, 'BRACKET_RECREATED', {
        tradeId: botState.lastTradeId,
        newStop: stopPrice,
        reason: 'SL_RECREATED',
      });
    }
    if (!hasTP) {
      const tpPrice = this.roundPrice(
        this.bracketPrice(
          side,
          entryPrice,
          roeOverrides?.takeProfitRoe ?? botState.lastTakeProfitRoe ?? regimeConfig?.tpRoe ?? 0.25,
          leverage,
          'TP',
        ),
        filters,
      );
      await exchange.placeTpClose(symbol, side, tpPrice);
      activeTakeProfitPrice = tpPrice;
      logger.info('aegis_turbo_brackets_created', { symbol, side, tpPrice, recreated: true });
      await this.deps.logTradeEvent(symbol, 'BRACKET_RECREATED', {
        tradeId: botState.lastTradeId,
        newTp: tpPrice,
        reason: 'TP_RECREATED',
      });
    }
    return { stopPrice: activeStopPrice, takeProfitPrice: activeTakeProfitPrice };
  }

  async replaceBracketsForNewEntryPrice(
    symbol: string,
    side: Side,
    newEntryPrice: number,
    leverage: number,
    _position: PositionInfo,
    botState: BotState,
  ): Promise<void> {
    const { exchange, logger } = this.deps;
    const openOrders = await exchange.listCloseOrdersForSide(symbol, side);
    for (const order of openOrders) {
      try {
        await exchange.cancelOrderById(symbol, order.orderId);
      } catch (error) {
        logger.warn('aegis_bracket_cancel_failed', {
          symbol,
          side,
          orderId: order.orderId,
          error: String(error),
        });
      }
    }
    const filters = await exchange.getSymbolFilters(symbol, leverage);
    const regimeConfig = this.deps.getRegimeConfig(symbol);
    const stopPrice = this.roundPrice(
      this.bracketPrice(
        side,
        newEntryPrice,
        botState.lastStopRoe ?? regimeConfig?.hardStopRoe ?? -0.15,
        leverage,
        'STOP',
      ),
      filters,
    );
    const tpPrice = this.roundPrice(
      this.bracketPrice(
        side,
        newEntryPrice,
        botState.lastTakeProfitRoe ?? regimeConfig?.tpRoe ?? 0.25,
        leverage,
        'TP',
      ),
      filters,
    );
    await exchange.placeStopClose(symbol, side, stopPrice);
    await exchange.placeTpClose(symbol, side, tpPrice);
    logger.info('aegis_brackets_replaced_for_new_entry', {
      symbol,
      side,
      newEntryPrice,
      stopPrice,
      tpPrice,
    });
    await this.deps.logTradeEvent(symbol, 'BRACKET_RECREATED', {
      tradeId: botState.lastTradeId,
      newStop: stopPrice,
      newTp: tpPrice,
      reason: 'QUANTITY_CHANGED_ENTRY_PRICE_UPDATED',
      metadata: { newEntryPrice, leverage },
    });
  }

  async reconcilePositionSize(input: {
    symbol: string;
    side: Side;
    leverage: number;
    position: PositionInfo;
    botState: BotState;
    symbolState: StateStore;
  }): Promise<{ changed: boolean }> {
    const previousQty = input.botState.lastEntryQty;
    const currentQty = input.position.qtyAbs;
    if (!Number.isFinite(currentQty) || currentQty <= 0) return { changed: false };

    if (!Number.isFinite(previousQty) || (previousQty ?? 0) <= 0) {
      input.symbolState.set({
        ownershipStatus: 'TAINTED',
        eligibleForBotMetrics: false,
        metricsExclusionReason: 'MANAGED_QUANTITY_BASELINE_MISSING',
        lastEntryQty: currentQty,
      });
      this.deps.logger.warn('aegis_managed_position_tainted', {
        symbol: input.symbol,
        side: input.side,
        previousQty,
        currentQty,
        reason: 'MANAGED_QUANTITY_BASELINE_MISSING',
        action: 'CONTINUE_MANAGEMENT_TAINTED',
      });
      return { changed: true };
    }

    const managedQty = previousQty as number;
    const quantityTolerance = Math.max(1e-12, managedQty * 1e-6);
    if (Math.abs(currentQty - managedQty) <= quantityTolerance) return { changed: false };

    const reason =
      currentQty > managedQty ? 'EXTERNAL_QUANTITY_INCREASE' : 'EXTERNAL_QUANTITY_REDUCTION';
    input.symbolState.set({
      ownershipStatus: 'TAINTED',
      eligibleForBotMetrics: false,
      metricsExclusionReason: reason,
      lastEntryQty: currentQty,
    });
    this.deps.logger.warn('aegis_managed_position_tainted', {
      symbol: input.symbol,
      side: input.side,
      previousQty,
      currentQty,
      reason,
      action: 'CONTINUE_MANAGEMENT_TAINTED',
    });
    return { changed: true };
  }

  async moveCloseStop(params: SafeStopMoveInput): Promise<SafeStopMoveResult> {
    const { exchange, logger } = this.deps;
    const baseMetadata = {
      symbol: params.symbol,
      side: params.side,
      tradeId: params.tradeId,
      entryPrice: params.entryPrice,
      markPrice: params.markPrice,
      newStopPrice: params.newStopPrice,
      peakRoe: params.peakRoe,
      currentRoe: params.currentRoe,
      protectedRoe: params.protectedRoe,
      reason: params.reason,
    };

    const skip = async (
      reason: SafeStopMoveSkipReason,
      oldStopPrice?: number,
      extra: Record<string, unknown> = {},
    ): Promise<SafeStopMoveResult> => {
      const metadata = { ...baseMetadata, oldStopPrice, skipReason: reason, ...extra };
      logger.warn('aegis_safe_stop_move_skipped', metadata);
      await this.deps.logTradeEvent(params.symbol, 'SAFE_STOP_MOVE_SKIPPED', {
        tradeId: params.tradeId,
        price: params.markPrice,
        roe: params.currentRoe,
        oldStop: oldStopPrice,
        newStop: params.newStopPrice,
        reason,
        metadata,
      });
      return { moved: false, reason, oldStopPrice, newStopPrice: params.newStopPrice };
    };

    if (!Number.isFinite(params.entryPrice) || params.entryPrice <= 0) return skip('missing_entry');
    if (!Number.isFinite(params.leverage) || params.leverage <= 0) {
      return skip('missing_leverage');
    }
    if (!Number.isFinite(params.quantity) || params.quantity <= 0 || !params.position?.qtyAbs) {
      return skip('missing_quantity');
    }

    const livePosition = await exchange.readActivePosition(params.symbol, params.side);
    if (!livePosition || livePosition.qtyAbs <= 0) return skip('missing_position');

    const beforeOrders = await exchange.listCloseOrdersForSide(params.symbol, params.side);
    const oldStops = beforeOrders.filter(
      (order) => order.type === 'STOP_MARKET' || order.type === 'STOP',
    );
    const oldStopPrice = oldStops.length
      ? params.side === 'LONG'
        ? Math.max(...oldStops.map((order) => order.stopPrice))
        : Math.min(...oldStops.map((order) => order.stopPrice))
      : undefined;
    const stopImproved = this.isBetterStop(params.side, params.newStopPrice, oldStopPrice);
    if (!stopImproved) return skip('stop_not_improved', oldStopPrice, { stopImproved });

    const immediateTriggerRisk = this.wouldStopTriggerImmediately(
      params.side,
      params.newStopPrice,
      params.markPrice,
      this.deps.getImmediateTriggerBufferPct(),
    );
    if (immediateTriggerRisk) {
      return skip('immediate_trigger_risk', oldStopPrice, { immediateTriggerRisk });
    }

    try {
      if (params.useClosePosition) {
        for (const stop of oldStops) await exchange.cancelOrderById(params.symbol, stop.orderId);
        try {
          await exchange.placeStopClose(params.symbol, params.side, params.newStopPrice);
        } catch (placementError) {
          if (oldStopPrice !== undefined) {
            try {
              await exchange.placeStopClose(params.symbol, params.side, oldStopPrice);
              logger.warn('aegis_safe_stop_move_previous_stop_restored', {
                ...baseMetadata,
                oldStopPrice,
                error: String(placementError),
              });
            } catch (restoreError) {
              logger.error('aegis_safe_stop_move_previous_stop_restore_failed', {
                ...baseMetadata,
                oldStopPrice,
                placementError: String(placementError),
                restoreError: String(restoreError),
              });
            }
          }
          throw placementError;
        }
      } else {
        await exchange.placeStopClose(
          params.symbol,
          params.side,
          params.newStopPrice,
          livePosition.qtyAbs,
        );
        for (const stop of oldStops) await exchange.cancelOrderById(params.symbol, stop.orderId);
      }

      const afterOrders = await exchange.listCloseOrdersForSide(params.symbol, params.side);
      const hasSLAfter = afterOrders.some(
        (order) => order.type === 'STOP_MARKET' || order.type === 'STOP',
      );
      const hasTPAfter = afterOrders.some(
        (order) => order.type === 'TAKE_PROFIT_MARKET' || order.type === 'TAKE_PROFIT',
      );
      if (!hasSLAfter || !hasTPAfter) {
        logger.warn('aegis_safe_stop_move_bracket_verify_warning', {
          ...baseMetadata,
          oldStopPrice,
          hasSLAfter,
          hasTPAfter,
        });
      }
      logger.info('aegis_safe_stop_moved', {
        ...baseMetadata,
        oldStopPrice,
        hasSLAfter,
        hasTPAfter,
      });
      await this.deps.logTradeEvent(params.symbol, 'SL_MOVED', {
        tradeId: params.tradeId,
        price: params.markPrice,
        roe: params.currentRoe,
        oldStop: oldStopPrice,
        newStop: params.newStopPrice,
        reason: params.reason,
        metadata: {
          ...baseMetadata,
          oldStopPrice,
          hasSLAfter,
          hasTPAfter,
          stopImproved: true,
          immediateTriggerRisk: false,
        },
      });
      return {
        moved: true,
        oldStopPrice,
        newStopPrice: params.newStopPrice,
        hasSLAfter,
        hasTPAfter,
      };
    } catch (error) {
      const metadata = { ...baseMetadata, oldStopPrice, error: String(error) };
      logger.error('aegis_safe_stop_move_failed', metadata);
      await this.deps.logTradeEvent(params.symbol, 'SAFE_STOP_MOVE_FAILED', {
        tradeId: params.tradeId,
        price: params.markPrice,
        roe: params.currentRoe,
        oldStop: oldStopPrice,
        newStop: params.newStopPrice,
        reason: 'exchange_error',
        metadata,
      });
      return {
        moved: false,
        reason: 'exchange_error',
        oldStopPrice,
        newStopPrice: params.newStopPrice,
        error: String(error),
      };
    }
  }

  private wouldStopTriggerImmediately(
    side: Side,
    stopPrice: number,
    markPrice: number,
    bufferPct: number,
  ): boolean {
    if (!Number.isFinite(stopPrice) || !Number.isFinite(markPrice) || markPrice <= 0) return true;
    return side === 'LONG'
      ? stopPrice >= markPrice * (1 - bufferPct)
      : stopPrice <= markPrice * (1 + bufferPct);
  }
}
