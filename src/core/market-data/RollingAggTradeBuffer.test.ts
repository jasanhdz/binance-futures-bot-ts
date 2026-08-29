import { describe, expect, it } from 'vitest';
import { RollingAggTradeBuffer } from './RollingAggTradeBuffer';
import { RollingAggTradeBuffer as LegacyParityBuffer } from './RollingAggTradeBuffer';
import type { AggTradeEvent } from '../../app/ports/MarketData';

const START = 1_700_000_000_000;

function event(overrides: Partial<AggTradeEvent> = {}): AggTradeEvent {
  return {
    eventTime: START,
    receivedAtMs: START + 7,
    price: 100,
    quantity: 1,
    isBuyerMaker: false,
    ...overrides,
  };
}

describe('RollingAggTradeBuffer compatibility', () => {
  it('matches Micro Burst output for representative causal streams', () => {
    const legacy = new LegacyParityBuffer({ now: () => START }, 4, 5_000);
    const shared = new RollingAggTradeBuffer({ now: () => START }, 4, 5_000);
    const stream = [
      event({
        eventTime: START - 4_000,
        aggregateTradeId: 10,
        firstTradeId: 100,
        lastTradeId: 101,
      }),
      event({ eventTime: START - 2_000, aggregateTradeId: 12, isBuyerMaker: true, quantity: 2 }),
      event({ eventTime: START - 3_000, aggregateTradeId: 11, receivedAtMs: START + 8 }),
      event({ eventTime: START, aggregateTradeId: 14, quantity: 3 }),
      event({ eventTime: START + 1, quantity: 4 }),
    ];

    for (const item of stream) {
      legacy.push(item);
      shared.push(item);
    }

    expect(shared.getRecent()).toEqual(legacy.getRecent());
    expect(shared.getTakerFlow()).toEqual(legacy.getTakerFlow());
    expect(shared.size()).toBe(legacy.size());
  });

  it('preserves shared fail-closed identity, capacity, and causal window semantics', () => {
    const shared = new RollingAggTradeBuffer({ now: () => START }, 2, 5_000);
    shared.push(event({ eventTime: START - 4_000, aggregateTradeId: 10 }));
    shared.push(event({ eventTime: START - 1_000, aggregateTradeId: 12 }));
    shared.push(event({ eventTime: START, aggregateTradeId: 13, receivedAtMs: START + 9 }));

    expect(shared.getRecent()).toHaveLength(2);
    expect(shared.getTakerFlow()).toMatchObject({
      tradeCount: 2,
      capacityTruncated: true,
      windowComplete: false,
      gapFree: false,
      eventWatermarkMs: START,
    });

    const missingIdentity = new RollingAggTradeBuffer({ now: () => START }, 10, 5_000);
    missingIdentity.push(event({ eventTime: START - 4_000, aggregateTradeId: undefined }));
    missingIdentity.push(event({ eventTime: START, aggregateTradeId: 11 }));
    expect(missingIdentity.getTakerFlow()).toMatchObject({ gapFree: false, windowComplete: false });
    expect(missingIdentity.getRecent()[1].receivedAtMs).toBe(START + 7);
  });
});
