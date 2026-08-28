import { describe, expect, it, vi } from 'vitest';
import { OrderBookDataPlane } from './OrderBookDataPlane';
import { OrderBookQuoteProvider } from './OrderBookQuoteProvider';
import type { OrderBookPort, OrderBookState } from '../../app/ports/MarketData';

function fakeBook(
  state: Partial<OrderBookState> = {},
  health: OrderBookState['health'] = state.health ?? 'HEALTHY',
): OrderBookPort {
  const snapshot: OrderBookState = {
    bids: [{ price: 99, qty: 1 }],
    asks: [{ price: 101, qty: 2 }],
    lastUpdateId: 1,
    health,
    observedAtMs: 1_700_000_000_000,
    lastSyncAtMs: 1_700_000_000_000,
    lastDiffAtMs: 1_700_000_000_000,
    gapCount: 0,
    resyncCount: 0,
    ...state,
  };
  return {
    start: vi.fn(),
    stop: vi.fn(),
    getState: vi.fn(() => ({ ...snapshot, bids: [...snapshot.bids], asks: [...snapshot.asks] })),
    getHealth: vi.fn(() => health),
    getSnapshot: vi.fn(),
  };
}

describe('OrderBookQuoteProvider', () => {
  it('derives an immutable healthy quote with causal timestamp and spread', () => {
    const quote = new OrderBookQuoteProvider('ethusdt', fakeBook()).getQuote();

    expect(quote).toEqual({
      symbol: 'ethusdt',
      bid: 99,
      ask: 101,
      mid: 100,
      spread: 2,
      spreadBps: (2 / 99) * 10_000,
      health: 'HEALTHY',
      observedAtMs: 1_700_000_000_000,
      source: 'SYNCHRONIZED_ORDER_BOOK',
    });
    expect(Object.isFrozen(quote)).toBe(true);
    expect(() => {
      (quote as { bid: number | null }).bid = 1;
    }).toThrow();
  });

  it.each(['STALE', 'UNSYNCED', 'UNAVAILABLE'] as const)(
    'fails closed for %s source health',
    (health) => {
      const quote = new OrderBookQuoteProvider('ETHUSDT', fakeBook({}, health)).getQuote();

      expect(quote.health).toBe(health);
      expect(quote.bid).toBeNull();
      expect(quote.ask).toBeNull();
      expect(quote.mid).toBeNull();
      expect(quote.spread).toBeNull();
      expect(quote.spreadBps).toBeNull();
    },
  );

  it.each([
    { name: 'crossed', bids: [{ price: 101, qty: 1 }], asks: [{ price: 99, qty: 1 }] },
    { name: 'empty', bids: [], asks: [] },
    { name: 'zero bid', bids: [{ price: 0, qty: 1 }], asks: [{ price: 101, qty: 1 }] },
    { name: 'negative ask', bids: [{ price: 99, qty: 1 }], asks: [{ price: -1, qty: 1 }] },
    { name: 'NaN bid', bids: [{ price: Number.NaN, qty: 1 }], asks: [{ price: 101, qty: 1 }] },
  ])('reports anomalous health for %s source levels', ({ bids, asks }) => {
    const quote = new OrderBookQuoteProvider('ETHUSDT', fakeBook({ bids, asks })).getQuote();

    expect(quote.health).toBe('ANOMALOUS');
    expect(quote.bid).toBeNull();
    expect(quote.ask).toBeNull();
  });

  it('reports anomalous health when the source timestamp is invalid', () => {
    const quote = new OrderBookQuoteProvider(
      'ETHUSDT',
      fakeBook({ observedAtMs: Number.NaN }),
    ).getQuote();

    expect(quote.health).toBe('ANOMALOUS');
    expect(quote.observedAtMs).toBeNull();
  });

  it('shares the same canonical book observation without another lifecycle', () => {
    const books: OrderBookPort[] = [];
    const plane = new OrderBookDataPlane((symbol) => {
      const book = fakeBook({ observedAtMs: 1234 });
      books.push(book);
      return book;
    });
    const firstLease = plane.acquire('ethusdt');
    const secondLease = plane.acquire('ETHUSDT');
    const first = new OrderBookQuoteProvider('ETHUSDT', firstLease.book).getQuote();
    const second = new OrderBookQuoteProvider('ETHUSDT', secondLease.book).getQuote();

    expect(first).toEqual(second);
    expect(books).toHaveLength(1);
    expect(books[0].start).toHaveBeenCalledTimes(1);
    expect(plane.getReferenceCount('ETHUSDT')).toBe(2);

    firstLease.release();
    secondLease.release();
    expect(books[0].stop).toHaveBeenCalledTimes(1);
  });

  it('keeps different symbols isolated', () => {
    const eth = fakeBook({ observedAtMs: 1_000 });
    const btc = fakeBook({
      bids: [{ price: 49, qty: 1 }],
      asks: [{ price: 51, qty: 1 }],
      observedAtMs: 2_000,
    });
    const plane = new OrderBookDataPlane((symbol) => (symbol === 'ETHUSDT' ? eth : btc));
    const ethLease = plane.acquire('ETHUSDT');
    const btcLease = plane.acquire('BTCUSDT');

    expect(new OrderBookQuoteProvider('ETHUSDT', ethLease.book).getQuote().mid).toBe(100);
    expect(new OrderBookQuoteProvider('BTCUSDT', btcLease.book).getQuote().mid).toBe(50);

    ethLease.release();
    btcLease.release();
  });
});
