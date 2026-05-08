import { BotState } from '../../domain/types';
export interface StateStore {
  get(): BotState;
  set(patch: Partial<BotState>): BotState;
  reset(): void;
  forSymbol?(symbol: string): StateStore;
}
