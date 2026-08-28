import { describe, expect, it, vi } from 'vitest';
import { MicroBurstAggTradeBuffer } from './MicroBurstAggTradeBuffer';
import { AggTradeEvent } from './MicroBurstMarketDataTypes';

const NOW_MS = 1_700_000_000_000;

function makeTrade(overrides: Partial<AggTradeEvent> = {}): AggTradeEvent {
  return {
    eventTime: NOW_MS,
    price: 100,
    quantity: 1,
    isBuyerMaker: false,
    ...overrides,
  };
}

describe('MicroBurstAggTradeBuffer', () => {
  it('uses the configured size only as an emergency capacity cap', () => {
    const clock = { now: vi.fn(() => NOW_MS) };
    const buffer = new MicroBurstAggTradeBuffer(clock, 5);

    for (let i = 0; i < 10; i++) {
      buffer.push(makeTrade({ eventTime: NOW_MS + i }));
    }

    expect(buffer.size()).toBe(5);
  });

  it('ignores invalid trades', () => {
    const clock = { now: vi.fn(() => NOW_MS) };
    const buffer = new MicroBurstAggTradeBuffer(clock);

    buffer.push(makeTrade({ price: NaN }));
    buffer.push(makeTrade({ price: -1 }));
    buffer.push(makeTrade({ quantity: -1 }));
    buffer.push(makeTrade({ eventTime: 0 }));

    expect(buffer.size()).toBe(0);
  });

  it('getRecent filters by age', () => {
    const clock = { now: vi.fn(() => NOW_MS) };
    const buffer = new MicroBurstAggTradeBuffer(clock, 100, 5000);

    buffer.push(makeTrade({ eventTime: NOW_MS - 10_000 }));
    buffer.push(makeTrade({ eventTime: NOW_MS - 3000 }));
    buffer.push(makeTrade({ eventTime: NOW_MS - 1000 }));

    const recent = buffer.getRecent();
    expect(recent).toHaveLength(2);
  });

  it('retains a full event-time window at low rates without consulting the local clock', () => {
    const clock = { now: vi.fn(() => NOW_MS + 9_999_999) };
    const buffer = new MicroBurstAggTradeBuffer(clock, 50_000, 5_000);

    buffer.push(makeTrade({ eventTime: NOW_MS - 4_000 }));
    buffer.push(makeTrade({ eventTime: NOW_MS }));

    expect(buffer.getRecent()).toHaveLength(2);
    expect(clock.now).not.toHaveBeenCalled();
  });

  it('retains a full event-time window at high rates', () => {
    const clock = { now: vi.fn(() => NOW_MS) };
    const buffer = new MicroBurstAggTradeBuffer(clock, 50_000, 5_000);

    for (let i = 0; i < 1_000; i++) {
      buffer.push(makeTrade({ eventTime: NOW_MS - 4_999 + i }));
    }

    expect(buffer.getTakerFlow()).toMatchObject({
      tradeCount: 1_000,
      observedSampleCount: 1_000,
      requestedWindowMs: 5_000,
      capacityTruncated: false,
    });
  });

  it('uses the maximum exchange event time as the watermark for out-of-order trades', () => {
    const clock = { now: vi.fn(() => NOW_MS + 1_000_000) };
    const buffer = new MicroBurstAggTradeBuffer(clock, 50_000, 5_000);

    buffer.push(makeTrade({ eventTime: NOW_MS }));
    buffer.push(makeTrade({ eventTime: NOW_MS - 4_000, quantity: 2 }));
    buffer.push(makeTrade({ eventTime: NOW_MS - 6_000, quantity: 10 }));

    expect(buffer.getTakerFlow()).toMatchObject({
      buyVolume: 3,
      tradeCount: 2,
      eventWatermarkMs: NOW_MS,
      observedWindowMs: 4_000,
    });
    expect(clock.now).not.toHaveBeenCalled();
  });

  it('reports when the emergency cap truncates the requested flow window', () => {
    const clock = { now: vi.fn(() => NOW_MS) };
    const buffer = new MicroBurstAggTradeBuffer(clock, 3, 5_000);

    for (let i = 0; i < 4; i++) {
      buffer.push(makeTrade({ eventTime: NOW_MS + i }));
    }

    expect(buffer.getTakerFlow()).toMatchObject({
      tradeCount: 3,
      requestedWindowMs: 5_000,
      observedWindowMs: 2,
      observedSampleCount: 3,
      capacityTruncated: true,
    });
  });

  it('is incomplete at startup, but sparse trades become complete causally', () => {
    const buffer = new MicroBurstAggTradeBuffer({ now: () => NOW_MS }, 100, 5_000);
    expect(buffer.getTakerFlow()).toMatchObject({
      coverageStartedAtMs: null,
      eventWatermarkMs: null,
      windowComplete: false,
      capacityTruncated: false,
      gapFree: true,
      tradeCount: 0,
    });
    buffer.push(makeTrade({ eventTime: NOW_MS - 5_000 }));
    buffer.push(makeTrade({ eventTime: NOW_MS }));
    expect(buffer.getTakerFlow()).toMatchObject({
      coverageStartedAtMs: NOW_MS - 5_000,
      eventWatermarkMs: NOW_MS,
      windowComplete: true,
      gapFree: true,
    });
  });

  it('invalidates the window when aggregate trade ids prove a gap', () => {
    const buffer = new MicroBurstAggTradeBuffer({ now: () => NOW_MS }, 100, 5_000);
    buffer.push(makeTrade({ eventTime: NOW_MS - 5_000, firstTradeId: 10, lastTradeId: 10 }));
    buffer.push(makeTrade({ eventTime: NOW_MS, firstTradeId: 12, lastTradeId: 12 }));
    expect(buffer.getTakerFlow()).toMatchObject({ windowComplete: false, gapFree: false });
  });

  it('emits the causal interval when aggregate trade ids prove a gap', () => {
    const onGap = vi.fn();
    const buffer = new MicroBurstAggTradeBuffer({ now: () => NOW_MS }, 100, 5_000, onGap);
    buffer.push(makeTrade({ eventTime: NOW_MS - 1_000, firstTradeId: 10, lastTradeId: 10 }));
    buffer.push(makeTrade({ eventTime: NOW_MS, firstTradeId: 12, lastTradeId: 12 }));

    expect(onGap).toHaveBeenCalledWith({
      previousTradeId: 10,
      nextTradeId: 12,
      previousEventTimeMs: NOW_MS - 1_000,
      nextEventTimeMs: NOW_MS,
      dedupeKey: '10:12',
    });
  });

  it('allows a gap after it expires from the active event-time window', () => {
    const buffer = new MicroBurstAggTradeBuffer({ now: () => NOW_MS }, 100, 5_000);
    buffer.push(makeTrade({ eventTime: NOW_MS - 5_000, firstTradeId: 10, lastTradeId: 10 }));
    buffer.push(makeTrade({ eventTime: NOW_MS, firstTradeId: 12, lastTradeId: 12 }));
    expect(buffer.getTakerFlow().gapFree).toBe(false);

    buffer.push(makeTrade({ eventTime: NOW_MS + 5_001, firstTradeId: 13, lastTradeId: 13 }));
    expect(buffer.getTakerFlow().gapFree).toBe(true);
  });

  it('deduplicates a replayed sequence discontinuity', () => {
    const onGap = vi.fn();
    const buffer = new MicroBurstAggTradeBuffer({ now: () => NOW_MS }, 100, 5_000, onGap);
    buffer.push(makeTrade({ eventTime: NOW_MS - 1_000, firstTradeId: 10, lastTradeId: 10 }));
    buffer.push(makeTrade({ eventTime: NOW_MS, firstTradeId: 12, lastTradeId: 12 }));
    buffer.push(makeTrade({ eventTime: NOW_MS + 1, firstTradeId: 12, lastTradeId: 12 }));
    expect(onGap).toHaveBeenCalledTimes(1);
  });

  it('prunes dedupe keys with expired gap intervals but retains active keys', () => {
    const onGap = vi.fn();
    const buffer = new MicroBurstAggTradeBuffer({ now: () => NOW_MS }, 100, 5_000, onGap);
    buffer.push(makeTrade({ eventTime: NOW_MS - 4_000, firstTradeId: 10, lastTradeId: 10 }));
    buffer.push(makeTrade({ eventTime: NOW_MS - 3_000, firstTradeId: 12, lastTradeId: 12 }));
    buffer.push(makeTrade({ eventTime: NOW_MS - 2_000, firstTradeId: 14, lastTradeId: 14 }));

    // The first gap expires; the second remains in the active event-time window.
    buffer.push(makeTrade({ eventTime: NOW_MS + 2_001, firstTradeId: 16, lastTradeId: 16 }));
    expect(onGap).toHaveBeenCalledTimes(3);
    expect((buffer as any).gapKeys).toEqual(new Set(['12:14', '14:16']));
  });

  it('uses persisted relevant gaps and fails closed when the query fails', () => {
    const query = vi.fn(() => true);
    const buffer = new MicroBurstAggTradeBuffer(
      { now: () => NOW_MS },
      100,
      5_000,
      undefined,
      query,
    );
    buffer.push(makeTrade({ eventTime: NOW_MS - 5_000 }));
    buffer.push(makeTrade({ eventTime: NOW_MS }));
    expect(buffer.getTakerFlow()).toMatchObject({ windowComplete: false, gapFree: false });
    expect(query).toHaveBeenCalledWith(NOW_MS - 5_000, NOW_MS);

    const failing = new MicroBurstAggTradeBuffer(
      { now: () => NOW_MS },
      100,
      5_000,
      undefined,
      () => {
        throw new Error('storage unavailable');
      },
    );
    failing.push(makeTrade({ eventTime: NOW_MS - 5_000 }));
    failing.push(makeTrade({ eventTime: NOW_MS }));
    expect(failing.getTakerFlow().gapFree).toBe(false);
  });

  it('getTakerFlow computes buy/sell volumes', () => {
    const clock = { now: vi.fn(() => NOW_MS) };
    const buffer = new MicroBurstAggTradeBuffer(clock, 100, 60_000);

    buffer.push(makeTrade({ isBuyerMaker: false, quantity: 2 }));
    buffer.push(makeTrade({ isBuyerMaker: true, quantity: 3 }));
    buffer.push(makeTrade({ isBuyerMaker: false, quantity: 1 }));

    const flow = buffer.getTakerFlow();
    expect(flow.buyVolume).toBe(3);
    expect(flow.sellVolume).toBe(3);
    expect(flow.netTakerVolume).toBe(0);
    expect(flow.tradeCount).toBe(3);
  });

  it('clear empties buffer', () => {
    const clock = { now: vi.fn(() => NOW_MS) };
    const buffer = new MicroBurstAggTradeBuffer(clock);

    buffer.push(makeTrade());
    buffer.push(makeTrade());
    expect(buffer.size()).toBe(2);

    buffer.clear();
    expect(buffer.size()).toBe(0);
  });
});
