import { describe, expect, it } from 'vitest';
import type { AggTradeEvent } from '../../../app/ports/MarketData';
import type { OrderBookSnapshot } from '../domain/MicroBurstTypes';
import {
  MicroBurstFastMarketState,
  type MicroBurstFastTradeReader,
} from './MicroBurstFastMarketState';

const NOW = 1_700_000_000_000;

function trades(stepMs = 250): AggTradeEvent[] {
  const result: AggTradeEvent[] = [];
  let id = 1;
  for (let offset = -12_000; offset <= 0; offset += stepMs) {
    result.push({
      eventTime: NOW + offset,
      receivedAtMs: NOW + offset + 5,
      price: 100 + ((offset + 12_000) / 12_000) * 1.2,
      quantity: id % 2 === 0 ? 2 : 1,
      isBuyerMaker: id % 3 === 0,
      aggregateTradeId: id++,
    });
  }
  return result;
}

function reader(events: AggTradeEvent[], quality: Partial<ReturnType<MicroBurstFastTradeReader['getTakerFlow']>> = {}): MicroBurstFastTradeReader {
  return {
    getRecent: () => events,
    getTakerFlow: (requestedWindowMs = 10_000) => ({
      buyVolume: 10,
      sellVolume: 4,
      netTakerVolume: 6,
      tradeCount: events.length,
      requestedWindowMs,
      observedWindowMs: 12_000,
      observedSampleCount: events.length,
      eventWatermarkMs: events.at(-1)?.eventTime ?? null,
      capacityTruncated: false,
      coverageStartedAtMs: events.at(0)?.eventTime ?? null,
      windowComplete: true,
      gapFree: true,
      ...quality,
    }),
  };
}

function book(overrides: Partial<OrderBookSnapshot> = {}): OrderBookSnapshot {
  return {
    bidDepth: [
      { price: 101.19, qty: 20 },
      { price: 101.18, qty: 10 },
    ],
    askDepth: [
      { price: 101.21, qty: 5 },
      { price: 101.22, qty: 5 },
    ],
    observedAtMs: NOW - 10,
    status: 'HEALTHY',
    lastUpdateId: 100,
    temporalHistory: [],
    ...overrides,
  };
}

function state(events = trades(), bookSnapshot: OrderBookSnapshot | undefined = book(), quality = {}) {
  return new MicroBurstFastMarketState('SOLUSDT', {
    trades: reader(events, quality),
    book: { getSnapshot: () => bookSnapshot },
    clock: { now: () => NOW },
  });
}

describe('MicroBurstFastMarketState', () => {
  it('computes deterministic causal returns without looking after observation time', () => {
    const events = trades();
    events.push({
      eventTime: NOW + 250,
      price: 500,
      quantity: 100,
      isBuyerMaker: false,
      aggregateTradeId: 999,
    });

    const snapshot = state(events).read();
    const second = state(events).read();

    expect(snapshot).toEqual(second);
    expect(snapshot.lastTradeAtMs).toBe(NOW);
    expect(snapshot.lastPrice).toBeCloseTo(101.2);
    expect(snapshot.returnsBps.ms250).not.toBeNull();
    expect(snapshot.returnsBps.s1).not.toBeNull();
    expect(snapshot.returnsBps.s3).not.toBeNull();
    expect(snapshot.returnsBps.s5).not.toBeNull();
    expect(snapshot.returnsBps.s10).not.toBeNull();
    expect(snapshot.returnsBps.s1!).toBeGreaterThan(0);
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  it('rejects a stale horizon anchor instead of inventing coverage', () => {
    const events: AggTradeEvent[] = [
      { eventTime: NOW - 2_000, price: 100, quantity: 1, isBuyerMaker: false },
      { eventTime: NOW, price: 101, quantity: 1, isBuyerMaker: false },
    ];
    const snapshot = state(events).read();

    expect(snapshot.returnsBps.ms250).toBeNull();
    expect(snapshot.returnsBps.s1).toBeNull();
    expect(snapshot.velocityBpsPerSecond).toBeNull();
  });

  it('uses Binance buyer-maker semantics for signed taker flow', () => {
    const events: AggTradeEvent[] = [
      { eventTime: NOW - 500, price: 100, quantity: 3, isBuyerMaker: false },
      { eventTime: NOW - 250, price: 100.1, quantity: 1, isBuyerMaker: true },
      { eventTime: NOW, price: 100.2, quantity: 2, isBuyerMaker: false },
    ];
    const snapshot = state(events).read();

    expect(snapshot.buyTakerVolume).toBe(5);
    expect(snapshot.sellTakerVolume).toBe(1);
    expect(snapshot.takerImbalance).toBeCloseTo(4 / 6);
    expect(snapshot.tradeIntensityPerSecond).toBe(3);
  });

  it('maps live synchronized-book evidence without opening another data source', () => {
    const snapshot = state().read();

    expect(snapshot.bestBid).toBe(101.19);
    expect(snapshot.bestAsk).toBe(101.21);
    expect(snapshot.midPrice).toBeCloseTo(101.2);
    expect(snapshot.spreadBps).toBeGreaterThan(0);
    expect(snapshot.signedBookImbalance).not.toBeNull();
    expect(snapshot.dataQuality.bookStatus).toBe('HEALTHY');
    expect(snapshot.dataQuality.bookAgeMs).toBe(10);
  });

  it('surfaces missing book and aggTrade continuity as explicit quality state', () => {
    const snapshot = state(trades(), undefined, {
      gapFree: false,
      windowComplete: false,
      capacityTruncated: true,
    }).read();

    expect(snapshot.bestBid).toBeNull();
    expect(snapshot.bestAsk).toBeNull();
    expect(snapshot.signedBookImbalance).toBeNull();
    expect(snapshot.dataQuality.bookStatus).toBe('UNAVAILABLE');
    expect(snapshot.dataQuality.gapFree).toBe(false);
    expect(snapshot.dataQuality.windowComplete).toBe(false);
    expect(snapshot.dataQuality.capacityTruncated).toBe(true);
  });

  it('returns an explicit empty snapshot when no trades have arrived', () => {
    const snapshot = state([], undefined, {
      windowComplete: false,
    }).read();

    expect(snapshot.lastPrice).toBeNull();
    expect(snapshot.lastTradeAtMs).toBeNull();
    expect(snapshot.returnsBps.s1).toBeNull();
    expect(snapshot.tradeIntensityPerSecond).toBeNull();
    expect(snapshot.takerImbalance).toBeNull();
    expect(snapshot.dataQuality.tradeAgeMs).toBeNull();
  });
});
