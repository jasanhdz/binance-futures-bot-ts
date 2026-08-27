import { MicroBurstConfig, MicroBurstExitContext, MicroBurstExitDecision } from './MicroBurstTypes';

function hold(reason: string, diagnostics: Record<string, unknown> = {}): MicroBurstExitDecision {
  return { action: 'HOLD', reason: 'HOLD', diagnostics: { ...diagnostics, holdReason: reason } };
}

function closeMarket(reason: MicroBurstExitDecision['reason'], diagnostics: Record<string, unknown> = {}): MicroBurstExitDecision {
  return { action: 'CLOSE_MARKET', reason, diagnostics };
}

function moveStop(reason: MicroBurstExitDecision['reason'], stopPrice: number, diagnostics: Record<string, unknown> = {}): MicroBurstExitDecision {
  return { action: 'MOVE_STOP', reason, requestedStopPrice: stopPrice, diagnostics };
}

export function evaluateMicroBurstExit(
  context: MicroBurstExitContext,
  config: MicroBurstConfig,
  entryPrice: number,
  side: 'LONG' | 'SHORT',
  currentPrice: number,
): MicroBurstExitDecision {
  const diag: Record<string, unknown> = {
    unrealizedRoe: context.unrealizedRoe,
    timeInTradeMs: context.timeInTradeMs,
    favorableExcursion: context.favorableExcursion,
    adverseExcursion: context.adverseExcursion,
  };

  if (context.timeInTradeMs > config.exitMaxHoldMs) {
    return closeMarket('MAX_HOLD', diag);
  }

  if (context.anomalyExitFlag) {
    return closeMarket('ANOMALY', diag);
  }

  if (context.currentBookPressure?.anomalyFlag) {
    return closeMarket('ANOMALY', { ...diag, exitTrigger: 'BOOK_ANOMALY' });
  }

  if (context.currentBtcContext?.conflictFlag && Math.abs(context.currentBtcContext.ret3m) > 0.005) {
    return closeMarket('ANOMALY', { ...diag, exitTrigger: 'BTC_REVERSAL' });
  }

  if (context.momentumDecayFlag && context.unrealizedRoe < config.exitEarlyFailureMinExcursionRoe) {
    return closeMarket('EARLY_FAILURE', diag);
  }

  if (
    context.timeInTradeMs < config.exitEarlyFailureWindowMs &&
    context.favorableExcursion < config.exitEarlyFailureMinExcursionRoe &&
    context.adverseExcursion > config.exitEarlyFailureMinExcursionRoe * 2
  ) {
    return closeMarket('EARLY_FAILURE', diag);
  }

  if (context.unrealizedRoe >= config.exitBreakEvenThresholdRoe && context.adverseExcursion > 0) {
    const breakEvenStop = entryPrice;
    const currentStopIsWorse = side === 'LONG'
      ? currentPrice > breakEvenStop
      : currentPrice < breakEvenStop;
    if (currentStopIsWorse) {
      return moveStop('BREAK_EVEN', breakEvenStop, diag);
    }
  }

  if (context.unrealizedRoe >= config.exitTrailingActivationRoe) {
    const trailingStopRoe = context.unrealizedRoe - config.exitTrailingCallbackRoe;
    const trailingStopPrice = side === 'LONG'
      ? entryPrice * (1 + trailingStopRoe)
      : entryPrice * (1 - trailingStopRoe);
    return moveStop('TRAILING', trailingStopPrice, diag);
  }

  if (context.unrealizedRoe <= -config.exitBreakEvenThresholdRoe) {
    return closeMarket('EARLY_FAILURE', { ...diag, exitTrigger: 'ADVERSE_EXCURSION' });
  }

  return hold('POSITION_ACTIVE', diag);
}
