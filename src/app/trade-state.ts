import { BotState } from '../core/types';

export function tradeStateResetPatch(): Partial<BotState> {
  return {
    lastTradeId: undefined,
    lastStrategyName: undefined,
    lastEntryWallet: undefined,
    lastEntryUsedBalance: undefined,
    lastEntryFilters: undefined,
    lastCommissionEstimate: undefined,
    lastOrderId: undefined,
  };
}
