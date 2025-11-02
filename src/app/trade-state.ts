import { BotState, Side } from '../core/types';

export function tradeStateResetPatch(): Partial<BotState> {
  return {
    lastTradeId: undefined,
    lastStrategyName: undefined,
    lastEntryWallet: undefined,
    lastEntryUsedBalance: undefined,
    lastEntryFilters: undefined,
    lastCommissionEstimate: undefined,
    lastOrderId: undefined,
    lowFundsActive: undefined,
  };
}

export function postExitSetupPatch(params: {
  side?: Side;
  exitPrice?: number;
  exitAt?: number;
  condition?: 'pullback' | 'breakout' | 'timeout';
}): Partial<BotState> {
  const { side, exitPrice, exitAt = Date.now(), condition } = params;
  if (!side || typeof exitPrice !== 'number' || !Number.isFinite(exitPrice)) {
    return postExitClearPatch();
  }
  return {
    postExitSide: side,
    postExitPrice: exitPrice,
    postExitAt: exitAt,
    postExitMin: exitPrice,
    postExitMax: exitPrice,
    postExitReady: condition ? true : false,
    postExitCondition: condition,
  };
}

export function postExitClearPatch(): Partial<BotState> {
  return {
    postExitSide: undefined,
    postExitPrice: undefined,
    postExitAt: undefined,
    postExitMin: undefined,
    postExitMax: undefined,
    postExitReady: undefined,
    postExitCondition: undefined,
    lowFundsActive: undefined,
  };
}
