import type { Logger } from '../../../app/ports/Logger';
import { TRADEABLE_SYMBOL } from '../domain/ScoutTypes';
import type {
  SuiSrScoutConfig,
  ScoutDecision,
  LevelCandidateEvent,
  FeatureVector,
  OrderResult,
  SrZone,
} from '../domain/ScoutTypes';

export type CanaryStatus =
  | 'IDLE'
  | 'PREFLIGHT_OK'
  | 'ENTRY_SUBMITTED'
  | 'ENTRY_FILLED'
  | 'PROTECTIVE_STOP_CONFIRMED'
  | 'TAKE_PROFIT_CONFIRMED'
  | 'POSITION_OPEN'
  | 'POSITION_CLOSED'
  | 'BLOCKED';

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
  placeTpClose(
    symbol: string,
    side: 'LONG' | 'SHORT',
    triggerPrice: number,
    qty?: number,
  ): Promise<boolean>;
  cancelCloseOrdersForSide(symbol: string, side: 'LONG' | 'SHORT'): Promise<void>;
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

export interface CanaryExecutionContext {
  readonly decisionId: string;
  readonly feedHealthy: boolean;
  readonly targetPrice?: number;
  readonly opposingZone?: SrZone;
}

export interface LiveCanaryExecutor {
  execute(
    decision: ScoutDecision,
    event: LevelCandidateEvent,
    featureVector: FeatureVector,
    config: SuiSrScoutConfig,
    context?: CanaryExecutionContext,
  ): Promise<OrderResult | null>;
  closePosition(
    symbol: string,
    side: 'LONG' | 'SHORT',
    reason: string,
    config: SuiSrScoutConfig,
  ): Promise<void>;
  getOrderPort(): OrderPort | null;
  getStatus(): CanaryStatus;
}

const BPS = 10_000;
const MIN_NET_R = 1.5;
const floorTo = (value: number, increment: number) => Math.floor(value / increment) * increment;
const ceilTo = (value: number, increment: number) => Math.ceil(value / increment) * increment;

function structuralTarget(side: 'LONG' | 'SHORT', context: CanaryExecutionContext): number | null {
  if (context.targetPrice && context.targetPrice > 0) return context.targetPrice;
  if (!context.opposingZone) return null;
  return side === 'LONG' ? context.opposingZone.low : context.opposingZone.high;
}

export function createLiveCanaryExecutor(
  logger: Logger,
  orderPort: OrderPort | null,
): LiveCanaryExecutor {
  let status: CanaryStatus = 'IDLE';
  const consumedDecisionIds = new Set<string>();
  let timeStop: ReturnType<typeof setTimeout> | null = null;
  let activePosition: { side: 'LONG' | 'SHORT'; quantity: number } | null = null;

  function clearTimeStop(): void {
    if (timeStop) clearTimeout(timeStop);
    timeStop = null;
  }

  function block(reason: string, details: Record<string, unknown> = {}): null {
    status = 'BLOCKED';
    logger.warn('canary_execute_blocked', { reason, ...details });
    return null;
  }

  return {
    async execute(decision, event, featureVector, config, context): Promise<OrderResult | null> {
      // All non-mutating checks happen before even reading account or exchange metadata.
      if (status === 'BLOCKED') return block('executor_blocked');
      if (
        config.executionMode !== 'LIVE_CANARY' ||
        !config.liveEnabled ||
        config.killSwitch ||
        !orderPort
      ) {
        return block('live_canary_not_explicitly_enabled');
      }
      if (
        config.symbol !== TRADEABLE_SYMBOL ||
        event.symbol !== TRADEABLE_SYMBOL ||
        featureVector.symbol !== TRADEABLE_SYMBOL
      )
        return block('sui_only');
      if (!context?.decisionId || consumedDecisionIds.has(context.decisionId))
        return block('duplicate_or_missing_decision_id');
      if (!context.feedHealthy || featureVector.unavailableFeatures.length > 0)
        return block('feed_or_features_unhealthy');
      if (featureVector.btcContext.aggressiveAgainstTrade)
        return block('btc_aggressive_against_trade');
      if (decision !== 'ALLOW_REJECTION_LONG' && decision !== 'ALLOW_REJECTION_SHORT') return null;

      const side = decision === 'ALLOW_REJECTION_LONG' ? 'LONG' : 'SHORT';
      const port = orderPort;
      try {
        // A failed position read is intentionally treated as unknown rather than flat.
        if (await port.hasOpenPosition(TRADEABLE_SYMBOL, 'ANY')) return block('position_not_flat');
        consumedDecisionIds.add(context.decisionId);
        status = 'PREFLIGHT_OK';

        await port.ensureMarginType(TRADEABLE_SYMBOL, 'ISOLATED');
        await port.setLeverage(TRADEABLE_SYMBOL, config.maxLeverage);
        const [filters, balance] = await Promise.all([
          port.getSymbolFilters(TRADEABLE_SYMBOL, config.maxLeverage),
          port.getUSDTBalance(),
        ]);
        const entryPrice = event.priceAtEvent;
        const buffer =
          event.zone.side && entryPrice * ((config.structuralStopBufferBps ?? 10) / BPS);
        const rawStop = side === 'LONG' ? event.zone.low - buffer : event.zone.high + buffer;
        const stopPrice =
          side === 'LONG' ? floorTo(rawStop, filters.tickSize) : ceilTo(rawStop, filters.tickSize);
        const rawTarget = structuralTarget(side, context);
        const targetPrice =
          rawTarget === null
            ? null
            : side === 'LONG'
              ? floorTo(rawTarget, filters.tickSize)
              : ceilTo(rawTarget, filters.tickSize);
        const riskPerUnit = side === 'LONG' ? entryPrice - stopPrice : stopPrice - entryPrice;
        const rewardPerUnit =
          targetPrice === null
            ? 0
            : side === 'LONG'
              ? targetPrice - entryPrice
              : entryPrice - targetPrice;
        const roundTripCosts = entryPrice * ((2 * (config.feeSlippageBps ?? 10)) / BPS);
        const netR = (rewardPerUnit - roundTripCosts) / (riskPerUnit + roundTripCosts);
        if (
          entryPrice <= 0 ||
          riskPerUnit <= 0 ||
          rewardPerUnit <= 0 ||
          netR < Math.max(MIN_NET_R, config.minNetRMultiple)
        )
          return block('structural_target_below_net_r');

        const maxRiskQuote = balance * (config.maxRiskPerTradeBps / BPS);
        const maxByRisk = maxRiskQuote / riskPerUnit;
        const maxByNotional =
          config.maxQuoteNotional > 0
            ? config.maxQuoteNotional / entryPrice
            : Number.POSITIVE_INFINITY;
        const maxByMargin =
          (balance * (config.canaryMarginFraction ?? 0.01) * config.maxLeverage) / entryPrice;
        const quantity = floorTo(Math.min(maxByRisk, maxByNotional, maxByMargin), filters.stepSize);
        if (
          !Number.isFinite(quantity) ||
          quantity <= 0 ||
          quantity * entryPrice < filters.minNotional
        )
          return block('quantity_below_minimum');

        status = 'ENTRY_SUBMITTED';
        const opened = await port.marketOpen(
          TRADEABLE_SYMBOL,
          side,
          quantity,
          `scout_${context.decisionId}`,
        );
        status = 'ENTRY_FILLED';
        if (!Number.isFinite(opened.avgPrice) || opened.avgPrice <= 0)
          throw new Error('entry fill has no average price');
        const stopConfirmed = await port.placeStopClose(
          TRADEABLE_SYMBOL,
          side,
          stopPrice,
          quantity,
        );
        if (!stopConfirmed) {
          await port.closeSideMarketSafe(
            TRADEABLE_SYMBOL,
            side,
            quantity,
            'BOTH',
            'stop_not_confirmed',
          );
          return block('protective_stop_failed', { orderId: opened.orderId });
        }
        status = 'PROTECTIVE_STOP_CONFIRMED';
        if (!(await port.placeTpClose(TRADEABLE_SYMBOL, side, targetPrice!, quantity))) {
          await port.closeSideMarketSafe(
            TRADEABLE_SYMBOL,
            side,
            quantity,
            'BOTH',
            'take_profit_not_confirmed',
          );
          return block('take_profit_failed', { orderId: opened.orderId });
        }
        status = 'TAKE_PROFIT_CONFIRMED';
        status = 'POSITION_OPEN';
        activePosition = { side, quantity };
        clearTimeStop();
        timeStop = setTimeout(
          () => {
            const position = activePosition;
            if (!position || !orderPort) return;
            void orderPort
              .cancelCloseOrdersForSide(TRADEABLE_SYMBOL, position.side)
              .then(() =>
                orderPort.closeSideMarketSafe(
                  TRADEABLE_SYMBOL,
                  position.side,
                  position.quantity,
                  'BOTH',
                  'time_stop',
                ),
              )
              .then(() => {
                activePosition = null;
                status = 'POSITION_CLOSED';
                logger.warn('canary_time_stop_closed', {
                  symbol: TRADEABLE_SYMBOL,
                  side: position.side,
                });
              })
              .catch((error) => {
                status = 'BLOCKED';
                logger.error('canary_time_stop_failed', {
                  error: error instanceof Error ? error.message : String(error),
                });
              });
          },
          config.canaryTimeStopMs ?? 15 * 60 * 1000,
        );
        const result: OrderResult = {
          orderId: opened.orderId,
          side,
          quantity,
          avgPrice: opened.avgPrice,
          stopOrderId: null,
          stopConfirmed: true,
          closeReason: null,
          closedAtMs: null,
        };
        logger.info('canary_position_open', { ...result, stopPrice, targetPrice, netR });
        return result;
      } catch (error) {
        logger.error('canary_order_failed', {
          error: error instanceof Error ? error.message : String(error),
          decision,
        });
        return block('execution_error');
      }
    },

    async closePosition(symbol, side, reason, _config): Promise<void> {
      if (!orderPort || symbol !== TRADEABLE_SYMBOL) return;
      try {
        clearTimeStop();
        if (await orderPort.hasOpenPosition(symbol, 'ANY')) {
          await orderPort.cancelCloseOrdersForSide(symbol, side);
          await orderPort.closeSideMarketSafe(symbol, side, 0, 'BOTH', reason);
        }
        activePosition = null;
        status = 'POSITION_CLOSED';
      } catch (error) {
        logger.error('canary_close_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        status = 'BLOCKED';
      }
    },

    getOrderPort: () => orderPort,
    getStatus: () => status,
  };
}
