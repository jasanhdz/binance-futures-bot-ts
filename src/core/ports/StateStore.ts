import { BotState } from '../types';
export interface StateStore {
  get(): BotState;
  set(patch: Partial<BotState>): BotState;
  reset(): void;
}
