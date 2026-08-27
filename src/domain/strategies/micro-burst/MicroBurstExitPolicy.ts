import { MicroBurstConfig, MicroBurstExitContext, MicroBurstExitDecision } from './MicroBurstTypes';

export function evaluateMicroBurstExit(
  ctx: MicroBurstExitContext,
  config: MicroBurstConfig,
  side: 'LONG' | 'SHORT',
): MicroBurstExitDecision {
  const dirMul = side === 'LONG' ? 1 : -1;

  // ── Priority 1: HARD_INVALIDATION ──
  if (ctx.unrealizedRoe < -config.structuralInvalidationBufferBps / 10_000) {
    return {
      action: 'CLOSE_MARKET',
      reason: 'HARD_INVALIDATION',
      diagnostics: { roe: ctx.unrealizedRoe },
    };
  }

  // ── Priority 2: ANOMALY ──
  if (ctx.anomalyExitFlag) {
    return {
      action: 'CLOSE_MARKET',
      reason: 'ANOMALY',
      diagnostics: { anomalyFlag: true },
    };
  }

  // ── Priority 3: BTC_REVERSAL ──
  if (ctx.currentBtcContext?.conflictFlag) {
    return {
      action: 'CLOSE_MARKET',
      reason: 'BTC_REVERSAL',
      diagnostics: { btcConflict: true },
    };
  }

  // ── Priority 4: EARLY_FAILURE ──
  if (
    ctx.timeInTradeMs < config.exitEarlyFailureWindowMs &&
    ctx.priceReturn * dirMul < config.exitEarlyFailureMinPriceReturn
  ) {
    return {
      action: 'CLOSE_MARKET',
      reason: 'EARLY_FAILURE',
      diagnostics: { timeMs: ctx.timeInTradeMs, priceReturn: ctx.priceReturn },
    };
  }

  // ── Priority 6: TRAILING ──
  // Once favorable excursion exceeds activation, close if price retraces from peak.
  if (ctx.priceReturn * dirMul >= config.exitTrailingActivationPriceReturn) {
    if (side === 'LONG') {
      const drawdown = ctx.peakPrice > 0 ? (ctx.peakPrice - ctx.currentPrice) / ctx.peakPrice : 0;
      if (drawdown >= config.exitTrailingCallbackPriceReturn) {
        return {
          action: 'CLOSE_MARKET',
          reason: 'TRAILING',
          diagnostics: { peakPrice: ctx.peakPrice, drawdown },
        };
      }
    } else {
      const drawup = ctx.peakPrice > 0 ? (ctx.currentPrice - ctx.peakPrice) / ctx.peakPrice : 0;
      if (drawup >= config.exitTrailingCallbackPriceReturn) {
        return {
          action: 'CLOSE_MARKET',
          reason: 'TRAILING',
          diagnostics: { peakPrice: ctx.peakPrice, drawup },
        };
      }
    }
  }

  // ── Priority 7: BREAK_EVEN ──
  // Once favorable excursion exceeds activation, move stop to entry if price is still favorable.
  if (ctx.priceReturn * dirMul >= config.exitBreakEvenMinPriceReturn) {
    const stillFavorable =
      side === 'LONG' ? ctx.currentPrice >= ctx.entryPrice : ctx.currentPrice <= ctx.entryPrice;
    if (stillFavorable) {
      return {
        action: 'MOVE_STOP',
        reason: 'BREAK_EVEN',
        requestedStopPrice: ctx.entryPrice,
        diagnostics: { currentPrice: ctx.currentPrice, entryPrice: ctx.entryPrice },
      };
    }
  }

  // ── Priority 8: MAX_HOLD ──
  if (ctx.timeInTradeMs >= config.exitMaxHoldMs) {
    return {
      action: 'CLOSE_MARKET',
      reason: 'MAX_HOLD',
      diagnostics: { timeMs: ctx.timeInTradeMs },
    };
  }

  // ── Default: HOLD ──
  return {
    action: 'HOLD',
    reason: 'HOLD',
    diagnostics: { timeMs: ctx.timeInTradeMs, priceReturn: ctx.priceReturn },
  };
}
