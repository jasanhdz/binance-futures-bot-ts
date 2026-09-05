import { describe, expect, it } from 'vitest';
import { SharedEntryReservation } from './SharedEntryReservation';

describe('SharedEntryReservation', () => {
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
