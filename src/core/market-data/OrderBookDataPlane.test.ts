import { describe, expect, it, vi } from 'vitest';
import { OrderBookDataPlane } from './OrderBookDataPlane';
import type { OrderBookPort } from '../../app/ports/MarketData';

function fakeBook(): OrderBookPort {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    getState: vi.fn(() => ({
      bids: [],
      asks: [],
      lastUpdateId: 0,
      health: 'UNAVAILABLE' as const,
      observedAtMs: 0,
      lastSyncAtMs: 0,
      lastDiffAtMs: 0,
      gapCount: 0,
      resyncCount: 0,
    })),
    getHealth: vi.fn(() => 'UNAVAILABLE' as const),
    getSnapshot: vi.fn(() => undefined),
  };
}

describe('OrderBookDataPlane', () => {
  it('shares one canonical book and one lifecycle across same-symbol leases', () => {
    const books: OrderBookPort[] = [];
    const plane = new OrderBookDataPlane((symbol) => {
      const book = fakeBook();
      books.push(book);
      return book;
    });

    const first = plane.acquire('ethusdt');
    const second = plane.acquire('ETHUSDT');

    expect(first.book).toBe(second.book);
    expect(books).toHaveLength(1);
    expect(first.book.start).toHaveBeenCalledTimes(1);
    expect(plane.getReferenceCount('ETHUSDT')).toBe(2);

    first.release();
    expect(first.book.stop).not.toHaveBeenCalled();
    expect(plane.getReferenceCount('ETHUSDT')).toBe(1);

    second.release();
    expect(first.book.stop).toHaveBeenCalledTimes(1);
    expect(plane.get('ETHUSDT')).toBeUndefined();

    const reacquired = plane.acquire('ETHUSDT');
    expect(reacquired.book).not.toBe(first.book);
    expect(books).toHaveLength(2);
    reacquired.release();
  });

  it('keeps symbols independent and exposes canonical failure state to all consumers', () => {
    const eth = fakeBook();
    const btc = fakeBook();
    const plane = new OrderBookDataPlane((symbol) => (symbol === 'ETHUSDT' ? eth : btc));
    const ethA = plane.acquire('ETHUSDT');
    const ethB = plane.acquire('ETHUSDT');
    const btcLease = plane.acquire('BTCUSDT');

    expect(ethA.book).toBe(ethB.book);
    expect(ethA.book).not.toBe(btcLease.book);
    expect(plane.get('ETHUSDT')).toBe(eth);
    expect(plane.get('BTCUSDT')).toBe(btc);
    expect(plane.getReferenceCount('ETHUSDT')).toBe(2);
    expect(plane.getReferenceCount('BTCUSDT')).toBe(1);

    ethA.book.getHealth = vi.fn(() => 'UNSYNCED' as const);
    expect(ethB.book.getHealth()).toBe('UNSYNCED');

    ethA.release();
    ethB.release();
    btcLease.release();
  });
});
