import {
  AggTradeGap,
  RollingAggTradeBuffer,
} from '../../../core/market-data/RollingAggTradeBuffer';

export type { AggTradeGap as MicroBurstAggTradeGap } from '../../../core/market-data/RollingAggTradeBuffer';

/** Compatibility name for Micro Burst's shared rolling market-data state. */
export class MicroBurstAggTradeBuffer extends RollingAggTradeBuffer {
  constructor(
    clock: { now(): number },
    maxSize?: number,
    maxAgeMs?: number,
    onGap?: (gap: AggTradeGap) => void,
    hasPersistedGap?: (fromMs: number, toMs: number) => boolean,
  ) {
    super(clock, maxSize, maxAgeMs, onGap, hasPersistedGap);
  }
}
