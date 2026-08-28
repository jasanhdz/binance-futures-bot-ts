import { describe, expect, it, vi } from 'vitest';
import { SynchronizedOrderBook } from './SynchronizedOrderBook';

describe('shared synchronized order book', () => {
  it('exposes a neutral read-only snapshot after the USD-M bridge', async () => {
    let emit: ((event: any) => void) | undefined;
    const clock = { now: vi.fn(() => 1_700_000_000_000) };
    const book = new SynchronizedOrderBook('ETHUSDT', {
      snapshotSource: {
        getSnapshot: vi.fn(async () => ({
          lastUpdateId: 100,
          bids: [['100', '10'] as [string, string]],
          asks: [['101', '10'] as [string, string]],
          receivedAtMs: clock.now(),
        })),
      },
      diffSource: {
        onDiff: vi.fn((_symbol, callback) => {
          emit = callback;
          return () => {
            emit = undefined;
          };
        }),
      },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      clock,
    });

    book.start();
    emit?.({
      U: 100,
      u: 101,
      pu: 99,
      bids: [['100', '12']],
      asks: [],
      E: 1_700_000_000_001,
      T: 1_700_000_000_001,
      receivedAtMs: 1_700_000_000_001,
    });

    await vi.waitFor(() => expect(book.getHealth()).toBe('HEALTHY'));
    expect(book.getSnapshot()).toEqual(
      expect.objectContaining({
        bidDepth: [{ price: 100, qty: 12 }],
        askDepth: [{ price: 101, qty: 10 }],
        status: 'HEALTHY',
      }),
    );
    book.stop();
  });
});
