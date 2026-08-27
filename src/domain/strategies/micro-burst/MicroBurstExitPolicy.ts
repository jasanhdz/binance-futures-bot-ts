import { MicroBurstConfig, MicroBurstExitContext, MicroBurstExitDecision } from './MicroBurstTypes';
import { decimalReturnToBps } from './MicroBurstUnits';

function favorableExcursionBps(context: MicroBurstExitContext, side: 'LONG' | 'SHORT'): number {
  const priceReturn =
    side === 'LONG'
      ? (context.peakPrice - context.entryPrice) / context.entryPrice
      : (context.entryPrice - context.troughPrice) / context.entryPrice;
  return Math.max(0, decimalReturnToBps(priceReturn));
}

function adverseExcursionBps(context: MicroBurstExitContext, side: 'LONG' | 'SHORT'): number {
  const priceReturn =
    side === 'LONG'
      ? (context.entryPrice - context.troughPrice) / context.entryPrice
      : (context.peakPrice - context.entryPrice) / context.entryPrice;
  return Math.max(0, decimalReturnToBps(priceReturn));
}

function currentFavorableReturnBps(context: MicroBurstExitContext, side: 'LONG' | 'SHORT'): number {
  const signedReturn = (context.currentPrice - context.entryPrice) / context.entryPrice;
  return decimalReturnToBps(side === 'LONG' ? signedReturn : -signedReturn);
}

function invalidPriceContract(context: MicroBurstExitContext): boolean {
  return [
    context.currentPrice,
    context.entryPrice,
    context.peakPrice,
    context.troughPrice,
    context.structuralInvalidationPrice,
    context.destinationPrice,
  ].some((price) => !Number.isFinite(price) || price <= 0);
}

function hardInvalidated(context: MicroBurstExitContext, side: 'LONG' | 'SHORT'): boolean {
  return side === 'LONG'
    ? context.currentPrice <= context.structuralInvalidationPrice
    : context.currentPrice >= context.structuralInvalidationPrice;
}

function targetReached(context: MicroBurstExitContext, side: 'LONG' | 'SHORT'): boolean {
  return side === 'LONG'
    ? context.currentPrice >= context.destinationPrice
    : context.currentPrice <= context.destinationPrice;
}

function breakEvenImprovesProtection(
  context: MicroBurstExitContext,
  side: 'LONG' | 'SHORT',
): boolean {
  if (context.currentStopPrice === null) return true;
  if (!Number.isFinite(context.currentStopPrice)) return false;
  return side === 'LONG'
    ? context.currentStopPrice < context.entryPrice
    : context.currentStopPrice > context.entryPrice;
}

export function evaluateMicroBurstExit(
  context: MicroBurstExitContext,
  config: MicroBurstConfig,
  side: 'LONG' | 'SHORT',
): MicroBurstExitDecision {
  // Priority 1: the persisted structural thesis boundary is price-based, never ROE-based.
  if (!invalidPriceContract(context) && hardInvalidated(context, side)) {
    return {
      action: 'CLOSE_MARKET',
      reason: 'HARD_INVALIDATION',
      diagnostics: {
        currentPrice: context.currentPrice,
        structuralInvalidationPrice: context.structuralInvalidationPrice,
      },
    };
  }

  // Priority 2: corrupt or anomalous market state wins attribution over profitable exits.
  if (
    invalidPriceContract(context) ||
    context.anomalyExitFlag ||
    (context.currentBookPressure !== null && context.currentBookPressure.status !== 'HEALTHY')
  ) {
    return {
      action: 'CLOSE_MARKET',
      reason: 'ANOMALY',
      diagnostics: {
        anomalyFlag: context.anomalyExitFlag,
        bookStatus: context.currentBookPressure?.status,
        invalidPriceContract: invalidPriceContract(context),
      },
    };
  }

  // Priority 3: strong BTC reversal.
  if (context.currentBtcContext?.conflictFlag) {
    return {
      action: 'CLOSE_MARKET',
      reason: 'BTC_REVERSAL',
      diagnostics: { btcConflict: true },
    };
  }

  const maxFavorableExcursionBps = favorableExcursionBps(context, side);
  const maxAdverseExcursionBps = adverseExcursionBps(context, side);
  const favorableReturnBps = currentFavorableReturnBps(context, side);

  // Priority 4: strong adverse evidence may fail immediately inside the proving window.
  if (
    context.timeInTradeMs < config.exitProofWindowMs &&
    maxAdverseExcursionBps >= config.exitImmediateAdverseBps
  ) {
    return {
      action: 'CLOSE_MARKET',
      reason: 'EARLY_FAILURE',
      diagnostics: {
        phase: 'IMMEDIATE_ADVERSE',
        maxAdverseExcursionBps,
        thresholdBps: config.exitImmediateAdverseBps,
      },
    };
  }

  // Priority 5: destination is the structural target persisted at entry.
  if (targetReached(context, side)) {
    return {
      action: 'CLOSE_MARKET',
      reason: 'TARGET',
      diagnostics: {
        currentPrice: context.currentPrice,
        destinationPrice: context.destinationPrice,
      },
    };
  }

  // Priority 6: deterministic software trailing callback closes at market.
  if (maxFavorableExcursionBps >= config.exitTrailingActivationBps) {
    const callbackBps =
      side === 'LONG'
        ? decimalReturnToBps((context.peakPrice - context.currentPrice) / context.peakPrice)
        : decimalReturnToBps((context.currentPrice - context.troughPrice) / context.troughPrice);
    const callbackReached =
      side === 'LONG'
        ? context.currentPrice < context.peakPrice
        : context.currentPrice > context.troughPrice;
    if (callbackReached && callbackBps >= config.exitTrailingCallbackBps) {
      return {
        action: 'CLOSE_MARKET',
        reason: 'TRAILING',
        diagnostics: {
          callbackBps,
          favorableExtremePrice: side === 'LONG' ? context.peakPrice : context.troughPrice,
        },
      };
    }
  }

  // Priority 7: break-even is a one-way stop improvement and is never re-requested.
  if (
    maxFavorableExcursionBps >= config.exitBreakEvenActivationBps &&
    favorableReturnBps > 0 &&
    breakEvenImprovesProtection(context, side)
  ) {
    return {
      action: 'MOVE_STOP',
      reason: 'BREAK_EVEN',
      requestedStopPrice: context.entryPrice,
      diagnostics: {
        maxFavorableExcursionBps,
        currentStopPrice: context.currentStopPrice,
      },
    };
  }

  // Priority 8: only conclude "never proved" once the proving window is complete.
  if (
    context.timeInTradeMs >= config.exitProofWindowMs &&
    maxFavorableExcursionBps < config.exitMinProofExcursionBps
  ) {
    return {
      action: 'CLOSE_MARKET',
      reason: 'EARLY_FAILURE',
      diagnostics: {
        phase: 'PROOF_WINDOW_EXPIRED',
        maxFavorableExcursionBps,
        thresholdBps: config.exitMinProofExcursionBps,
      },
    };
  }

  // Priority 9: break-even intentionally wins once; an already protected trade then times out.
  if (context.timeInTradeMs >= config.exitMaxHoldMs) {
    return {
      action: 'CLOSE_MARKET',
      reason: 'MAX_HOLD',
      diagnostics: { timeMs: context.timeInTradeMs },
    };
  }

  return {
    action: 'HOLD',
    reason: 'HOLD',
    diagnostics: {
      timeMs: context.timeInTradeMs,
      favorableReturnBps,
      maxFavorableExcursionBps,
      maxAdverseExcursionBps,
    },
  };
}
