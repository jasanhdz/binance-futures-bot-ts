import {
  ClosedTradeOutcome,
  ConsecutiveLossTracker,
  ConsecutiveLossUpdate,
} from './ConsecutiveLossTracker';

export type AegisClosedTradeOutcome = ClosedTradeOutcome;
export type AegisConsecutiveLossUpdate = ConsecutiveLossUpdate;

export class AegisConsecutiveLossTracker extends ConsecutiveLossTracker {
  restorePersistedValue(value: number): void {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error('AEGIS_CONSECUTIVE_LOSS_VALUE_INVALID');
    }
    super.restorePersistedValue(value);
  }
}
