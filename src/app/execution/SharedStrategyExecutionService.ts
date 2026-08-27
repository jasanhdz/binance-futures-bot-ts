import { createHash } from 'node:crypto';
import { Exchange, PositionInfo, SymbolFilters, USDTAccountSnapshot } from '../ports/Exchange';
import { Logger } from '../ports/Logger';
import {
  StrategyExecutionIntent,
  StrategyExecutionPort,
  StrategyExecutionResult,
} from '../../domain/strategy/StrategyExecution';

export interface SharedStrategyExecutionConfig {
  feeBufferPct: number;
  confirmationAttempts: number;
  confirmationDelaysMs: number[];
  maxMarketOpenAttempts: number;
}

const DEFAULT_CONFIG: SharedStrategyExecutionConfig = {
  feeBufferPct: 0.05,
  confirmationAttempts: 3,
  confirmationDelaysMs: [300, 500, 1000],
  maxMarketOpenAttempts: 6,
};

/**
 * Strategy-neutral exchange mutation boundary.
 * No Aegis/Momentum policy is evaluated here; this service only executes an
 * already-approved intent and fails closed when mandatory protection fails.
 */
export class SharedStrategyExecutionService implements StrategyExecutionPort {
  constructor(
    private readonly exchange: Exchange,
    private readonly logger: Logger,
    private readonly config: SharedStrategyExecutionConfig = DEFAULT_CONFIG,
  ) {}

  async execute(intent: StrategyExecutionIntent): Promise<StrategyExecutionResult> {
    const baseMetadata = {
      strategyId: intent.identity.strategyId,
      strategyVersion: intent.identity.strategyVersion,
      strategyHash: intent.identity.strategyHash,
      configHash: intent.identity.configHash,
      codeCommitSha: intent.identity.codeCommitSha,
      requestedAt: intent.requestedAt,
      ...intent.metadata,
    };

    if (!Number.isFinite(intent.leverage) || intent.leverage <= 0) {
      return denied(intent, 'INVALID_LEVERAGE', baseMetadata);
    }
    if (
      !Number.isFinite(intent.positionFraction) ||
      intent.positionFraction <= 0 ||
      intent.positionFraction > 1
    ) {
      return denied(intent, 'INVALID_SIZE', baseMetadata);
    }
    const hasStopRoe = intent.stopRoe !== undefined;
    const hasStructuralStop = intent.structuralStopPrice !== undefined;
    if (hasStopRoe && (!Number.isFinite(intent.stopRoe) || Number(intent.stopRoe) >= 0)) {
      return denied(intent, 'INVALID_SIZE', { ...baseMetadata, reasonDetail: 'invalid_stop_roe' });
    }
    if (
      hasStructuralStop &&
      (!Number.isFinite(intent.structuralStopPrice) || Number(intent.structuralStopPrice) <= 0)
    ) {
      return denied(intent, 'INVALID_SIZE', {
        ...baseMetadata,
        reasonDetail: 'invalid_structural_stop_price',
      });
    }
    if (hasStopRoe && hasStructuralStop) {
      return denied(intent, 'INVALID_SIZE', {
        ...baseMetadata,
        reasonDetail: 'ambiguous_stop_specification',
      });
    }
    if (intent.protection.requireStop && !hasStopRoe && !hasStructuralStop) {
      return denied(intent, 'INVALID_SIZE', {
        ...baseMetadata,
        reasonDetail: 'missing_stop_specification',
      });
    }
    const stopSource = hasStructuralStop ? 'STRUCTURAL_PRICE' : hasStopRoe ? 'ROE' : undefined;
    const useTakeProfit = intent.protection.requireTakeProfit || intent.takeProfitRoe !== undefined;
    if (
      useTakeProfit &&
      (!Number.isFinite(intent.takeProfitRoe) || Number(intent.takeProfitRoe) <= 0)
    ) {
      return denied(intent, 'INVALID_SIZE', {
        ...baseMetadata,
        reasonDetail: 'invalid_take_profit_roe',
      });
    }

    let opened = false;
    let openedQuantity = 0;
    let openedSideMode: PositionInfo['sideMode'] = 'BOTH';
    let marketOpenAttempt = 0;
    let failureStage: 'POSITION_CONFIRMATION' | 'PROTECTION' | 'EXCHANGE' | undefined;
    let emergencyCloseError: string | undefined;
    const quantityAdjustments: Array<Record<string, unknown>> = [];
    try {
      await this.exchange.setLeverage(intent.symbol, intent.leverage);
      await this.exchange.ensureMarginType(intent.symbol, 'ISOLATED');

      const wallet = await this.exchange.getUSDTBalance();
      const account = await this.readAccountSnapshot(wallet);
      const availableWallet = finite(account.availableBalance)
        ? Math.max(0, Math.min(wallet, Number(account.availableBalance)))
        : wallet;
      const effectiveWallet = availableWallet * (1 - clamp(this.config.feeBufferPct, 0, 0.5));
      const markPrice = await this.exchange.getMarkPrice(intent.symbol);
      const filters = await this.exchange.getSymbolFilters(intent.symbol, intent.leverage);
      const requestedNotional = effectiveWallet * intent.positionFraction * intent.leverage;
      const cappedNotional =
        finite(filters.notionalCap) && Number(filters.notionalCap) > 0
          ? Math.min(requestedNotional, Number(filters.notionalCap))
          : requestedNotional;
      let quantity = roundQuantity(cappedNotional / markPrice, filters);

      if (!finite(quantity) || quantity <= 0 || quantity * markPrice < filters.minNotional) {
        return denied(intent, 'INVALID_SIZE', {
          ...baseMetadata,
          wallet,
          availableWallet,
          requestedNotional,
          minNotional: filters.minNotional,
        });
      }

      marketOpenAttempt = 1;
      let order: { avgPrice: number; orderId: string };
      const clientOrderId = marketOpenClientOrderId(intent);
      while (true) {
        try {
          order = await this.exchange.marketOpen(intent.symbol, intent.side, quantity, clientOrderId);
          break;
        } catch (error) {
          let reconciledOrder: { avgPrice: number; orderId: string } | null;
          try {
            reconciledOrder = await this.exchange.readMarketOpenByClientOrderId(
              intent.symbol,
              clientOrderId,
            );
          } catch (reconciliationError) {
            this.logger.error('shared_execution_market_open_reconciliation_failed', {
              ...baseMetadata,
              symbol: intent.symbol,
              side: intent.side,
              tradeId: intent.tradeId,
              clientOrderId,
              error: String(reconciliationError),
            });
            throw reconciliationError;
          }
          if (reconciledOrder) {
            order = reconciledOrder;
            break;
          }
          if (
            !isRecoverableEntrySizeError(error) ||
            marketOpenAttempt >= this.config.maxMarketOpenAttempts
          ) {
            throw error;
          }
          const refreshed = await this.readAccountSnapshot();
          const refreshedAvailable = finite(refreshed.availableBalance)
            ? Math.max(0, Number(refreshed.availableBalance))
            : undefined;
          const balanceLimitedQuantity =
            refreshedAvailable === undefined
              ? quantity
              : roundQuantity(
                  Math.min(
                    refreshedAvailable *
                      (1 - clamp(this.config.feeBufferPct, 0, 0.5)) *
                      intent.positionFraction *
                      intent.leverage,
                    finite(filters.notionalCap) && Number(filters.notionalCap) > 0
                      ? Number(filters.notionalCap)
                      : Number.POSITIVE_INFINITY,
                  ) / markPrice,
                  filters,
                );
          const reducedQuantity = roundQuantity(quantity * 0.9, filters);
          const nextQuantity = roundQuantity(
            Math.min(reducedQuantity, balanceLimitedQuantity),
            filters,
          );
          const canRetry =
            nextQuantity > 0 &&
            nextQuantity < quantity &&
            nextQuantity * markPrice >= filters.minNotional;
          this.logger.warn('shared_execution_quantity_retry', {
            ...baseMetadata,
            symbol: intent.symbol,
            side: intent.side,
            marketOpenAttempt,
            quantity,
            nextQuantity,
            canRetry,
            error: String(error),
          });
          if (!canRetry) throw error;
          quantityAdjustments.push({
            attempt: marketOpenAttempt,
            previousQuantity: quantity,
            nextQuantity,
            availableBalance: refreshedAvailable,
            error: String(error),
          });
          quantity = nextQuantity;
          marketOpenAttempt += 1;
        }
      }

      opened = true;
      openedQuantity = quantity;
      const position = await this.confirmPosition(intent.symbol, intent.side);
      if (!position) {
        failureStage = 'POSITION_CONFIRMATION';
        const recovery = await this.attemptEmergencyClose(
          intent,
          quantity,
          'BOTH',
          intent.failureCloseReasons?.positionConfirmation ?? 'POSITION_CONFIRMATION_FAILED',
          true,
        );
        return failed(intent, 'POSITION_CONFIRMATION_FAILED', {
          ...baseMetadata,
          failureStage,
          orderId: order.orderId,
          entryPrice: order.avgPrice,
          quantity: recovery.quantity,
          sideMode: recovery.sideMode,
          emergencyCloseError: recovery.emergencyCloseError,
          positionStillOpen: recovery.positionStillOpen,
        });
      }
      openedSideMode = position.sideMode;
      openedQuantity = position.qtyAbs || quantity;

      const entryPrice = position.entryPrice > 0 ? position.entryPrice : order.avgPrice;
      const stopPrice = hasStructuralStop
        ? roundPrice(Number(intent.structuralStopPrice), filters)
        : hasStopRoe
          ? roundPrice(
              bracketPrice(
                intent.side,
                entryPrice,
                Number(intent.stopRoe),
                intent.leverage,
                'STOP',
              ),
              filters,
            )
          : undefined;
      const takeProfitPrice = useTakeProfit
        ? roundPrice(
            bracketPrice(
              intent.side,
              entryPrice,
              Number(intent.takeProfitRoe),
              intent.leverage,
              'TP',
            ),
            filters,
          )
        : undefined;
      const stopAuditMetadata =
        stopSource === 'STRUCTURAL_PRICE'
          ? {
              stopSource,
              requestedStructuralStopPrice: intent.structuralStopPrice,
              effectiveStopPrice: stopPrice,
            }
          : stopSource === 'ROE'
            ? { stopSource, effectiveStopPrice: stopPrice }
            : {};

      let stopOk = false;
      let takeProfitOk = false;
      let protectionFailureDetail: string | undefined;
      try {
        if (
          stopSource === 'STRUCTURAL_PRICE' &&
          !isValidStructuralStopGeometry(intent.side, entryPrice, stopPrice)
        ) {
          protectionFailureDetail = 'invalid_structural_stop_geometry';
          throw new Error('INVALID_STRUCTURAL_STOP_GEOMETRY');
        }
        if (stopPrice !== undefined) {
          stopOk = await this.exchange.placeStopClose(intent.symbol, intent.side, stopPrice);
        }
        if (intent.protection.requireStop && !stopOk)
          throw new Error('SHARED_EXECUTION_STOP_REJECTED');
        if (takeProfitPrice !== undefined) {
          takeProfitOk = await this.exchange.placeTpClose(
            intent.symbol,
            intent.side,
            takeProfitPrice,
          );
        }
        if (intent.protection.requireTakeProfit && !takeProfitOk)
          throw new Error('SHARED_EXECUTION_TP_REJECTED');
      } catch (error) {
        failureStage = 'PROTECTION';
        const recovery = intent.protection.closeIfProtectionFails
          ? await this.attemptEmergencyClose(
              intent,
              openedQuantity,
              openedSideMode,
              intent.failureCloseReasons?.protection ?? 'SHARED_EXECUTION_PROTECTION_FAILED',
            )
          : { quantity: openedQuantity, sideMode: openedSideMode, positionStillOpen: true };
        return failed(intent, 'BRACKETS_FAILED', {
          ...baseMetadata,
          failureStage,
          orderId: order.orderId,
          entryPrice,
          quantity: recovery.quantity,
          sideMode: recovery.sideMode,
          stopPrice,
          takeProfitPrice,
          ...stopAuditMetadata,
          stopOk,
          takeProfitOk,
          ...(protectionFailureDetail ? { reasonDetail: protectionFailureDetail } : {}),
          error: String(error),
          emergencyCloseError: recovery.emergencyCloseError,
          positionStillOpen: recovery.positionStillOpen,
        });
      }

      let closeOrders: Awaited<ReturnType<Exchange['listCloseOrdersForSide']>> = [];
      if (intent.protection.requireStop || intent.protection.requireTakeProfit) {
        try {
          closeOrders = await this.exchange.listCloseOrdersForSide(intent.symbol, intent.side);
        } catch (error) {
          failureStage = 'PROTECTION';
          const recovery = intent.protection.closeIfProtectionFails
            ? await this.attemptEmergencyClose(
                intent,
                openedQuantity,
                openedSideMode,
                intent.failureCloseReasons?.protection ??
                  'SHARED_EXECUTION_PROTECTION_VERIFY_FAILED',
              )
            : { quantity: openedQuantity, sideMode: openedSideMode, positionStillOpen: true };
          return failed(intent, 'BRACKETS_FAILED', {
            ...baseMetadata,
            failureStage,
            orderId: order.orderId,
            entryPrice,
            quantity: recovery.quantity,
            sideMode: recovery.sideMode,
            stopPrice,
            takeProfitPrice,
            ...stopAuditMetadata,
            stopOk,
            takeProfitOk,
            error: String(error),
            emergencyCloseError: recovery.emergencyCloseError,
            positionStillOpen: recovery.positionStillOpen,
          });
        }
      }
      const hasStop = closeOrders.some(
        (order) =>
          order.type.includes('STOP') &&
          (stopSource !== 'STRUCTURAL_PRICE' || roundPrice(order.stopPrice, filters) === stopPrice),
      );
      const hasTakeProfit = closeOrders.some((order) => order.type.includes('TAKE_PROFIT'));
      if (
        (intent.protection.requireStop && !hasStop) ||
        (intent.protection.requireTakeProfit && !hasTakeProfit)
      ) {
        failureStage = 'PROTECTION';
        const recovery = intent.protection.closeIfProtectionFails
          ? await this.attemptEmergencyClose(
              intent,
              openedQuantity,
              openedSideMode,
              intent.failureCloseReasons?.protection ?? 'SHARED_EXECUTION_PROTECTION_VERIFY_FAILED',
            )
          : { quantity: openedQuantity, sideMode: openedSideMode, positionStillOpen: true };
        return failed(intent, 'BRACKETS_FAILED', {
          ...baseMetadata,
          failureStage,
          orderId: order.orderId,
          entryPrice,
          quantity: recovery.quantity,
          sideMode: recovery.sideMode,
          stopPrice,
          takeProfitPrice,
          ...stopAuditMetadata,
          stopOk,
          takeProfitOk,
          hasStop,
          hasTakeProfit,
          ...(stopSource === 'STRUCTURAL_PRICE' && intent.protection.requireStop && !hasStop
            ? { reasonDetail: 'structural_stop_verification_failed' }
            : {}),
          emergencyCloseError: recovery.emergencyCloseError,
          positionStillOpen: recovery.positionStillOpen,
        });
      }

      const openedAt = await this.exchange.getServerTime();
      const marginUsed = position.isolatedMargin ?? (entryPrice * openedQuantity) / intent.leverage;
      const actualPositionFraction =
        effectiveWallet > 0 ? Math.min(intent.positionFraction, marginUsed / effectiveWallet) : 0;

      return {
        status: 'OPENED',
        identity: intent.identity,
        tradeId: intent.tradeId,
        symbol: intent.symbol,
        side: intent.side,
        orderId: order.orderId,
        entryPrice,
        quantity: openedQuantity,
        leverage: intent.leverage,
        positionFraction: actualPositionFraction,
        openedAt,
        metadata: {
          ...baseMetadata,
          wallet,
          availableWallet,
          marginUsed,
          stopPrice,
          takeProfitPrice,
          ...stopAuditMetadata,
          stopOk,
          takeProfitOk,
          hasStop,
          hasTakeProfit,
          bracketsConfirmed:
            (!intent.protection.requireStop || hasStop) &&
            (!intent.protection.requireTakeProfit || hasTakeProfit),
          sideMode: position.sideMode,
          marketOpenAttempts: marketOpenAttempt,
          quantityAdjustments,
          clientOrderId,
        },
      };
    } catch (error) {
      failureStage ??= 'EXCHANGE';
      this.logger.error('shared_strategy_execution_failed', {
        ...baseMetadata,
        symbol: intent.symbol,
        side: intent.side,
        tradeId: intent.tradeId,
        error: String(error),
      });
      if (opened) {
        try {
          await this.exchange.closeSideMarketSafe(
            intent.symbol,
            intent.side,
            openedQuantity,
            openedSideMode,
            intent.failureCloseReasons?.unexpected ?? 'SHARED_EXECUTION_ERROR_CLOSED',
          );
          opened = false;
        } catch (closeError) {
          emergencyCloseError = String(closeError);
          this.logger.error('shared_strategy_execution_emergency_close_failed', {
            ...baseMetadata,
            symbol: intent.symbol,
            side: intent.side,
            tradeId: intent.tradeId,
            error: String(closeError),
          });
        }
      }
      return failed(intent, 'EXCHANGE_REJECTED', {
        ...baseMetadata,
        error: String(error),
        marketOpenAttempts: marketOpenAttempt,
        recoverableEntrySizeError: isRecoverableEntrySizeError(error),
        failureStage,
        emergencyCloseError,
        positionStillOpen: opened,
        quantity: openedQuantity || undefined,
        sideMode: opened ? openedSideMode : undefined,
        quantityAdjustments,
      });
    }
  }

  private async readAccountSnapshot(walletFallback?: number): Promise<USDTAccountSnapshot> {
    const reader = this.exchange.getUSDTAccountSnapshot;
    if (typeof reader !== 'function') {
      return walletFallback === undefined ? {} : { walletBalance: walletFallback };
    }
    try {
      const snapshot = await reader.call(this.exchange);
      return {
        walletBalance: finite(snapshot.walletBalance)
          ? Number(snapshot.walletBalance)
          : walletFallback,
        availableBalance: finite(snapshot.availableBalance)
          ? Number(snapshot.availableBalance)
          : undefined,
        unrealizedPnlTotal: finite(snapshot.unrealizedPnlTotal)
          ? Number(snapshot.unrealizedPnlTotal)
          : undefined,
        equityTotal: finite(snapshot.equityTotal) ? Number(snapshot.equityTotal) : undefined,
      };
    } catch {
      return walletFallback === undefined ? {} : { walletBalance: walletFallback };
    }
  }

  private async confirmPosition(
    symbol: string,
    side: 'LONG' | 'SHORT',
  ): Promise<PositionInfo | null> {
    const attempts = Math.max(1, this.config.confirmationAttempts);
    for (let index = 0; index < attempts; index += 1) {
      const delay =
        this.config.confirmationDelaysMs[index] ??
        this.config.confirmationDelaysMs[this.config.confirmationDelaysMs.length - 1] ??
        300;
      await sleep(delay);
      const position = await this.exchange.readActivePosition(symbol, side);
      if (position) return position;
    }
    return null;
  }

  private async attemptEmergencyClose(
    intent: StrategyExecutionIntent,
    quantity: number,
    sideMode: PositionInfo['sideMode'],
    reason: string,
    reconcilePosition = false,
  ): Promise<{
    quantity: number;
    sideMode: PositionInfo['sideMode'];
    emergencyCloseError?: string;
    positionStillOpen: boolean;
  }> {
    let closeQuantity = quantity;
    let closeSideMode = sideMode;
    if (reconcilePosition) {
      try {
        const position = await this.exchange.readActivePosition(intent.symbol, intent.side);
        closeQuantity = position?.qtyAbs ?? closeQuantity;
        closeSideMode = position?.sideMode ?? closeSideMode;
      } catch (error) {
        this.logger.warn('shared_strategy_execution_emergency_close_reconciliation_failed', {
          strategyId: intent.identity.strategyId,
          symbol: intent.symbol,
          side: intent.side,
          tradeId: intent.tradeId,
          error: String(error),
        });
      }
    }
    try {
      await this.exchange.closeSideMarketSafe(
        intent.symbol,
        intent.side,
        closeQuantity,
        closeSideMode,
        reason,
      );
      return { quantity: closeQuantity, sideMode: closeSideMode, positionStillOpen: false };
    } catch (error) {
      this.logger.error('shared_strategy_execution_emergency_close_failed', {
        strategyId: intent.identity.strategyId,
        symbol: intent.symbol,
        side: intent.side,
        tradeId: intent.tradeId,
        error: String(error),
      });
      return {
        quantity: closeQuantity,
        sideMode: closeSideMode,
        emergencyCloseError: String(error),
        positionStillOpen: true,
      };
    }
  }
}

function denied(
  intent: StrategyExecutionIntent,
  reason: Extract<StrategyExecutionResult, { status: 'DENIED' }>['reason'],
  metadata: Record<string, unknown>,
): StrategyExecutionResult {
  return {
    status: 'DENIED',
    identity: intent.identity,
    tradeId: intent.tradeId,
    symbol: intent.symbol,
    reason,
    metadata,
  };
}

function failed(
  intent: StrategyExecutionIntent,
  reason: Extract<StrategyExecutionResult, { status: 'FAILED' }>['reason'],
  metadata: Record<string, unknown>,
): StrategyExecutionResult {
  return {
    status: 'FAILED',
    identity: intent.identity,
    tradeId: intent.tradeId,
    symbol: intent.symbol,
    reason,
    metadata,
  };
}

function roundQuantity(quantity: number, filters: SymbolFilters): number {
  if (!finite(quantity) || quantity <= 0) return 0;
  const step =
    finite(filters.stepSize) && filters.stepSize > 0
      ? filters.stepSize
      : 10 ** -filters.qtyPrecision;
  const stepped = Math.floor(quantity / step) * step;
  return Number(stepped.toFixed(filters.qtyPrecision));
}

function roundPrice(price: number, filters: SymbolFilters): number {
  const tick =
    finite(filters.tickSize) && filters.tickSize > 0
      ? filters.tickSize
      : 10 ** -filters.pricePrecision;
  const stepped = Math.round(price / tick) * tick;
  return Number(stepped.toFixed(filters.pricePrecision));
}

function bracketPrice(
  side: 'LONG' | 'SHORT',
  entryPrice: number,
  roe: number,
  leverage: number,
  kind: 'STOP' | 'TP',
): number {
  const move = Math.abs(roe) / leverage;
  if (kind === 'STOP') return side === 'LONG' ? entryPrice * (1 - move) : entryPrice * (1 + move);
  return side === 'LONG' ? entryPrice * (1 + move) : entryPrice * (1 - move);
}

function isValidStructuralStopGeometry(
  side: 'LONG' | 'SHORT',
  entryPrice: number,
  stopPrice: number | undefined,
): boolean {
  if (!finite(entryPrice) || entryPrice <= 0 || !finite(stopPrice) || stopPrice <= 0) return false;
  return side === 'LONG' ? stopPrice < entryPrice : stopPrice > entryPrice;
}

function isRecoverableEntrySizeError(error: unknown): boolean {
  const candidate = error as {
    code?: unknown;
    message?: unknown;
    response?: { data?: { code?: unknown; msg?: unknown } };
    body?: { code?: unknown; msg?: unknown };
  };
  const codes = [candidate?.code, candidate?.response?.data?.code, candidate?.body?.code]
    .map((value) => Number(value))
    .filter(Number.isFinite);
  if (codes.some((code) => [-2019, -2027, -4005].includes(code))) return true;
  const message = [
    candidate?.message,
    candidate?.response?.data?.msg,
    candidate?.body?.msg,
    String(error),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return (
    message.includes('margin is insufficient') ||
    message.includes('insufficient margin') ||
    message.includes('insufficient balance') ||
    message.includes('quantity greater than max quantity') ||
    message.includes('maximum allowable position')
  );
}

function marketOpenClientOrderId(intent: StrategyExecutionIntent): string {
  const executionIntent = [
    intent.identity.strategyId,
    intent.identity.strategyVersion,
    intent.identity.strategyHash ?? '',
    intent.identity.configHash ?? '',
    intent.identity.codeCommitSha,
    intent.signalId ?? '',
    intent.tradeId,
    intent.symbol,
    intent.side,
    intent.requestedAt,
  ].join('|');
  // Binance accepts client order IDs up to 36 characters; retain a fixed prefix for auditability.
  return `se_${createHash('sha256').update(executionIntent).digest('hex').slice(0, 33)}`;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
