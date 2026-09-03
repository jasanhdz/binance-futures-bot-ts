import type { Logger } from '../../../app/ports/Logger';
import type {
  SuiSrScoutConfig,
  ScoutDecision,
  LevelCandidateEvent,
  FeatureVector,
  OrderResult,
  EvidenceEntry,
} from '../domain/ScoutTypes';

export interface OrderPort {
  marketOpen(
    symbol: string,
    side: 'LONG' | 'SHORT',
    quantity: number,
    clientOrderId?: string,
  ): Promise<{ avgPrice: number; orderId: string }>;
  placeStopClose(
    symbol: string,
    side: 'LONG' | 'SHORT',
    stopPrice: number,
    qty?: number,
  ): Promise<boolean>;
  cancelOrderById(symbol: string, orderId: string): Promise<void>;
  closeSideMarketSafe(
    symbol: string,
    side: 'LONG' | 'SHORT',
    qtyAbs: number,
    sideMode: 'BOTH' | 'LONG' | 'SHORT',
    reason?: string,
  ): Promise<void>;
  hasOpenPosition(symbol: string, side: 'LONG' | 'SHORT' | 'ANY'): Promise<boolean>;
  getUSDTBalance(): Promise<number>;
  setLeverage(symbol: string, leverage: number): Promise<void>;
  ensureMarginType(symbol: string, marginType: 'ISOLATED' | 'CROSSED'): Promise<void>;
  getSymbolFilters(
    symbol: string,
    leverage: number,
  ): Promise<{
    tickSize: number;
    stepSize: number;
    minNotional: number;
    pricePrecision: number;
    qtyPrecision: number;
  }>;
}

export interface LiveCanaryExecutor {
  execute(
    decision: ScoutDecision,
    event: LevelCandidateEvent,
    featureVector: FeatureVector,
    config: SuiSrScoutConfig,
  ): Promise<OrderResult | null>;
  closePosition(
    symbol: string,
    side: 'LONG' | 'SHORT',
    reason: string,
    config: SuiSrScoutConfig,
  ): Promise<void>;
  getOrderPort(): OrderPort | null;
}

function canExecute(config: SuiSrScoutConfig, hasPort: boolean): boolean {
  if (config.executionMode === 'OBSERVE') return false;
  if (config.executionMode === 'LIVE_CANARY' && !config.liveEnabled) return false;
  if (config.killSwitch) return false;
  if (!hasPort) return false;
  return true;
}

export function createLiveCanaryExecutor(
  logger: Logger,
  orderPort: OrderPort | null,
): LiveCanaryExecutor {
  let activeOrderId: string | null = null;
  let activeStopOrderId: string | null = null;

  return {
    async execute(decision, event, featureVector, config): Promise<OrderResult | null> {
      if (!canExecute(config, !!orderPort)) {
        logger.info('canary_execute_blocked', {
          reason: 'cannot_execute',
          executionMode: config.executionMode,
          liveEnabled: config.liveEnabled,
          killSwitch: config.killSwitch,
          hasOrderPort: !!orderPort,
        });
        return null;
      }

      if (decision !== 'ALLOW_REJECTION_LONG' && decision !== 'ALLOW_REJECTION_SHORT') {
        return null;
      }

      const port = orderPort!;
      const symbol = config.symbol;
      const side = decision === 'ALLOW_REJECTION_LONG' ? 'LONG' : 'SHORT';
      const clientOrderId = `scout_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      try {
        await port.ensureMarginType(symbol, 'ISOLATED');
        await port.setLeverage(symbol, config.maxLeverage);

        const filters = await port.getSymbolFilters(symbol, config.maxLeverage);
        const balance = await port.getUSDTBalance();
        const maxNotional = Math.min(config.maxQuoteNotional, balance * 0.9);

        const price = (featureVector.level.zoneHigh + featureVector.level.zoneLow) / 2;
        const stopDistance = price * (config.maxRiskPerTradeBps / 10000);
        const qty = Math.floor(maxNotional / price / filters.stepSize) * filters.stepSize;

        if (qty * price < filters.minNotional) {
          logger.warn('canary_qty_below_min_notional', {
            qty,
            price,
            minNotional: filters.minNotional,
          });
          return null;
        }

        const { avgPrice, orderId } = await port.marketOpen(symbol, side, qty, clientOrderId);
        activeOrderId = orderId;

        const stopPrice = side === 'LONG' ? avgPrice - stopDistance : avgPrice + stopDistance;

        const stopConfirmed = await port.placeStopClose(symbol, side, stopPrice, qty);
        if (!stopConfirmed) {
          logger.error('canary_stop_not_confirmed', { orderId, stopPrice });
          await port.closeSideMarketSafe(symbol, side, qty, 'BOTH', 'stop_not_confirmed');
          return {
            orderId,
            side,
            quantity: qty,
            avgPrice,
            stopOrderId: null,
            stopConfirmed: false,
            closeReason: 'stop_not_confirmed',
            closedAtMs: Date.now(),
          };
        }

        const result: OrderResult = {
          orderId,
          side,
          quantity: qty,
          avgPrice,
          stopOrderId: activeStopOrderId,
          stopConfirmed: true,
          closeReason: null,
          closedAtMs: null,
        };

        logger.info('canary_order_placed', result);
        return result;
      } catch (err) {
        logger.error('canary_order_failed', {
          error: err instanceof Error ? err.message : String(err),
          decision,
          side,
        });
        return null;
      }
    },

    async closePosition(symbol, side, reason, config): Promise<void> {
      if (!orderPort) {
        logger.warn('canary_close_no_order_port');
        return;
      }

      try {
        const pos = await orderPort.hasOpenPosition(symbol, 'ANY');
        if (!pos) {
          logger.info('canary_no_position_to_close');
          return;
        }

        const filters = await orderPort.getSymbolFilters(symbol, config.maxLeverage);
        const qty = filters.stepSize;

        await orderPort.closeSideMarketSafe(symbol, side, qty, 'BOTH', reason);
        activeOrderId = null;
        activeStopOrderId = null;
        logger.info('canary_position_closed', { symbol, side, reason });
      } catch (err) {
        logger.error('canary_close_failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },

    getOrderPort(): OrderPort | null {
      return orderPort;
    },
  };
}
