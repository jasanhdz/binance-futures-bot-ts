import { describe, expect, it } from 'vitest';
import { MicroBurstTradeHistoryStore } from './MicroBurstTradeHistoryStore';

const trade = (eventTime: number, price: number) => ({
  eventTime,
  receivedAtMs: eventTime + 3,
  price,
  quantity: 1,
  isBuyerMaker: false,
});

describe('MicroBurstTradeHistoryStore', () => {
  it('orders out-of-order events deterministically and queries exclusive/inclusive bounds', () => {
    const store = new MicroBurstTradeHistoryStore();
    store.append('BTCUSDT', trade(30, 103));
    store.append('BTCUSDT', trade(10, 101));
    store.append('BTCUSDT', trade(20, 102));

    expect(store.query('BTCUSDT', 10, 20).map((item) => item.price)).toEqual([102]);
  });

  it('retains more than 10k events in 300 seconds and prunes strictly by exchange event time', () => {
    const store = new MicroBurstTradeHistoryStore();
    for (let index = 10_500; index >= 0; index--) {
      store.append('ETHUSDT', trade(1_000_000 + Math.floor(index * 300_000 / 10_500), index === 1 ? 90 : 100));
    }

    const history = store.query('ETHUSDT', 999_999, 1_300_000);
    expect(history).toHaveLength(10_501);
    expect(history.some((item) => item.price === 90)).toBe(true);

    store.prune(1_900_000);
    expect(store.query('ETHUSDT', 0, 2_000_000)).toHaveLength(0);
  });

  it('deduplicates canonical aggregate IDs and orders same-time trades by exchange ID', () => {
    const store = new MicroBurstTradeHistoryStore();
    store.append('BTCUSDT', { ...trade(20, 102), aggregateTradeId: 2 });
    store.append('BTCUSDT', { ...trade(20, 101), aggregateTradeId: 1 });
    store.append('BTCUSDT', { ...trade(20, 999), aggregateTradeId: 1 });

    expect(store.query('BTCUSDT', 0, 20).map((item) => item.price)).toEqual([101, 102]);
  });
});
