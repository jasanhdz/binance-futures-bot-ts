import { describe, expect, it } from 'vitest';
import { SharedEntryReservation } from './SharedEntryReservation';

describe('SharedEntryReservation', () => {
  it.each(['ETHUSDT', 'BTCUSDT'])(
    'does not let a stale release unlock a subsequent %s reservation',
    (symbol) => {
      const reservation = new SharedEntryReservation();
      const first = reservation.tryAcquire('ETHUSDT');
      if (!first.acquired) throw new Error('expected first lease');
      first.release();
      const current = reservation.tryAcquire(symbol);
      if (!current.acquired) throw new Error('expected current lease');
      first.release();
      expect(reservation.tryAcquire(symbol)).toEqual({ acquired: false, reason: 'SYMBOL_BUSY' });
      expect(reservation.tryAcquire('SOLUSDT')).toEqual({
        acquired: false,
        reason: 'ACCOUNT_BUSY',
      });
      current.release();
      expect(reservation.tryAcquire('SOLUSDT').acquired).toBe(true);
    },
  );

  it('returns a lease and releases it idempotently', () => {
    const reservation = new SharedEntryReservation();
    const lease = reservation.tryAcquire('ETHUSDT');

    expect(lease).toMatchObject({ acquired: true, symbol: 'ETHUSDT' });
    if (!lease.acquired) throw new Error('expected lease');
    lease.release();
    lease.release();

    expect(reservation.tryAcquire('BTCUSDT')).toMatchObject({
      acquired: true,
      symbol: 'BTCUSDT',
    });
  });

  it('distinguishes same-symbol and account-wide contention', () => {
    const reservation = new SharedEntryReservation();
    const lease = reservation.tryAcquire('ETHUSDT');

    expect(reservation.tryAcquire('ETHUSDT')).toEqual({
      acquired: false,
      reason: 'SYMBOL_BUSY',
    });
    expect(reservation.tryAcquire('BTCUSDT')).toEqual({
      acquired: false,
      reason: 'ACCOUNT_BUSY',
    });
    if (lease.acquired) lease.release();
  });
});
