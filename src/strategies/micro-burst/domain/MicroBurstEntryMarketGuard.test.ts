import { describe, expect, it } from 'vitest';
import { validateMicroBurstEntryMarket } from './MicroBurstEntryMarketGuard';
import { createMicroBurstExecutionIntent } from './MicroBurstExecutionIntentFactory';
import { createMicroBurstIdentity } from './MicroBurstIdentity';
import { defaultMicroBurstConfig, OrderBookSnapshot } from './MicroBurstTypes';

const now = 1_700_000_000_000;
const config = defaultMicroBurstConfig();
function fixture(side: 'LONG' | 'SHORT' = 'LONG') {
  const intent = createMicroBurstExecutionIntent({
    identity: createMicroBurstIdentity(),
    symbol: 'ETHUSDT',
    side,
    requestedAt: now,
    signalSnapshotAtMs: now - 1000,
    tradeId: 'test',
    leverage: 20,
    positionFraction: 0.9,
    stopInvalidationPrice: side === 'LONG' ? 99.5 : 100.5,
    targetPrice: side === 'LONG' ? 102 : 98,
  });
  const book: OrderBookSnapshot = {
    observedAtMs: now,
    status: 'HEALTHY',
    bidDepth: [{ price: 99.99, qty: 100 }],
    askDepth: [{ price: 100.01, qty: 100 }],
  };
  return { intent, book };
}
describe('Micro final executable admission', () => {
  it.each(['LONG', 'SHORT'] as const)(
    'retains gross gates and adds quantity-adjusted net costs for %s',
    (side) => {
      const { intent, book } = fixture(side);
      intent.destinationPrice = side === 'LONG' ? 100.9 : 99.1;
      expect(validateMicroBurstEntryMarket(intent, 2, book, now, config)).toBe(
        'MICRO_EXECUTABLE_NET_ROOM_LOST',
      );
      intent.destinationPrice = side === 'LONG' ? 102 : 98;
      expect(validateMicroBurstEntryMarket(intent, 2, book, now, config)).toBeUndefined();
      expect(validateMicroBurstEntryMarket(intent, 101, book, now, config)).toBe(
        'MICRO_EXECUTABLE_DEPTH_INSUFFICIENT',
      );
    },
  );
  it.each(['LONG', 'SHORT'] as const)(
    'accepts fresh executable %s without changing identity or protection',
    (side) => {
      const { intent, book } = fixture(side);
      const before = JSON.stringify(intent);
      expect(validateMicroBurstEntryMarket(intent, 2, book, now, config)).toBeUndefined();
      expect(JSON.stringify(intent)).toBe(before);
    },
  );
  it('expires during a persistence await with the same intent', () => {
    const { intent, book } = fixture();
    expect(validateMicroBurstEntryMarket(intent, 2, book, now, config)).toBeUndefined();
    expect(
      validateMicroBurstEntryMarket(intent, 2, book, now + config.bookFreshnessMaxMs + 1, config),
    ).toBe('MICRO_SIGNAL_EXPIRED');
  });
  it.each([undefined, NaN, now + 1, now - config.candleFreshness1mMaxMs - 1])(
    'rejects invalid snapshot %s',
    (snapshot) => {
      const { intent, book } = fixture();
      intent.metadata.signalSnapshotAtMs = snapshot;
      expect(validateMicroBurstEntryMarket(intent, 2, book, now, config)).toBe(
        'MICRO_SIGNAL_EXPIRED',
      );
    },
  );
  it('requires a fresh synchronized book', () => {
    const { intent, book } = fixture();
    expect(validateMicroBurstEntryMarket(intent, 2, undefined, now, config)).toBe(
      'MICRO_EXECUTABLE_BOOK_NOT_FRESH',
    );
    book.observedAtMs = now + 1;
    expect(validateMicroBurstEntryMarket(intent, 2, book, now, config)).toBe(
      'MICRO_EXECUTABLE_BOOK_NOT_FRESH',
    );
  });
  it('rejects insufficient depth at the actual intended quantity', () => {
    const { intent, book } = fixture();
    expect(validateMicroBurstEntryMarket(intent, 101, book, now, config)).toBe(
      'MICRO_EXECUTABLE_DEPTH_INSUFFICIENT',
    );
  });
  it('uses VWAP rather than a tiny attractive best ask', () => {
    const { intent, book } = fixture();
    book.askDepth = [
      { price: 100.01, qty: 0.01 },
      { price: 102, qty: 100 },
    ];
    expect(validateMicroBurstEntryMarket(intent, 10, book, now, config)).toBe(
      'MICRO_REACTION_DISPLACED',
    );
  });
  it.each(['LONG', 'SHORT'] as const)('rejects %s invalidation crossed before send', (side) => {
    const { intent, book } = fixture(side);
    const price = side === 'LONG' ? 99.4 : 100.6;
    book.bidDepth[0].price = price;
    book.askDepth[0].price = price + 0.01;
    expect(validateMicroBurstEntryMarket(intent, 2, book, now, config)).toBe(
      'MICRO_EXECUTABLE_GEOMETRY_INVALID',
    );
  });
});
