import { BotState } from '../../core/types';
export interface StateStore {
  get(): BotState;
  set(patch: Partial<BotState>): BotState;
  reset(): void;
  flush?(): Promise<void>;
  forSymbol?(symbol: string): StateStore;
}
