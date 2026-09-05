import { describe, expect, it } from 'vitest';
import { InMemoryExecutionJournal, isValidTransition } from './ExecutionJournal';

describe('InMemoryExecutionJournal', () => {
  it('appends and reads entries in order', async () => {
    const journal = new InMemoryExecutionJournal();
    await journal.append({ id: '1', symbol: 'XRPUSDT', side: 'LONG', strategyId: 'MICRO', event: 'PREPARED', timestampMs: 1000 });
    await journal.append({ id: '2', symbol: 'XRPUSDT', side: 'LONG', strategyId: 'MICRO', event: 'SUBMITTED', timestampMs: 2000 });

    const entries = await journal.read('XRPUSDT');
    expect(entries).toHaveLength(2);
    expect(entries[0].event).toBe('PREPARED');
    expect(entries[0].version).toBe(1);
    expect(entries[1].event).toBe('SUBMITTED');
    expect(entries[1].version).toBe(2);
  });

  it('returns empty array for unknown symbol', async () => {
    const journal = new InMemoryExecutionJournal();
    expect(await journal.read('UNKNOWN')).toEqual([]);
  });

  it('reads latest entry', async () => {
    const journal = new InMemoryExecutionJournal();
    await journal.append({ id: '1', symbol: 'XRPUSDT', side: 'LONG', strategyId: 'MICRO', event: 'PREPARED', timestampMs: 1000 });
    await journal.append({ id: '2', symbol: 'XRPUSDT', side: 'LONG', strategyId: 'MICRO', event: 'SUBMITTED', timestampMs: 2000 });

    const latest = await journal.readLatest('XRPUSDT');
    expect(latest?.event).toBe('SUBMITTED');
    expect(latest?.version).toBe(2);
  });

  it('returns null for latest of unknown symbol', async () => {
    const journal = new InMemoryExecutionJournal();
    expect(await journal.readLatest('UNKNOWN')).toBeNull();
  });

  it('reads entries by event type', async () => {
    const journal = new InMemoryExecutionJournal();
    await journal.append({ id: '1', symbol: 'XRPUSDT', side: 'LONG', strategyId: 'MICRO', event: 'PREPARED', timestampMs: 1000 });
    await journal.append({ id: '2', symbol: 'XRPUSDT', side: 'LONG', strategyId: 'MICRO', event: 'SUBMITTED', timestampMs: 2000 });
    await journal.append({ id: '3', symbol: 'XRPUSDT', side: 'LONG', strategyId: 'MICRO', event: 'PREPARED', timestampMs: 3000 });

    const prepared = await journal.readByEvent('XRPUSDT', 'PREPARED');
    expect(prepared).toHaveLength(2);
    expect(prepared.every((e) => e.event === 'PREPARED')).toBe(true);
  });

  it('tracks submitted client order ids', async () => {
    const journal = new InMemoryExecutionJournal();
    expect(await journal.isSubmitted('C1')).toBe(false);
    await journal.append({ id: '1', symbol: 'XRPUSDT', side: 'LONG', strategyId: 'MICRO', event: 'SUBMITTED', timestampMs: 1000, clientOrderId: 'C1' });
    expect(await journal.isSubmitted('C1')).toBe(true);
    expect(await journal.isSubmitted('C2')).toBe(false);
  });

  it('versions are monotonically increasing per symbol', async () => {
    const journal = new InMemoryExecutionJournal();
    const e1 = await journal.append({ id: '1', symbol: 'XRPUSDT', side: 'LONG', strategyId: 'MICRO', event: 'PREPARED', timestampMs: 1000 });
    const e2 = await journal.append({ id: '2', symbol: 'BTCUSDT', side: 'SHORT', strategyId: 'AEGIS', event: 'PREPARED', timestampMs: 2000 });
    const e3 = await journal.append({ id: '3', symbol: 'XRPUSDT', side: 'LONG', strategyId: 'MICRO', event: 'SUBMITTED', timestampMs: 3000 });

    expect(e1.version).toBe(1);
    expect(e2.version).toBe(1); // Different symbol, starts at 1.
    expect(e3.version).toBe(2); // Same symbol as e1, continues.
  });

  it('flush is a no-op', async () => {
    const journal = new InMemoryExecutionJournal();
    await journal.flush(); // Should not throw.
  });

  it('isolates entries by symbol', async () => {
    const journal = new InMemoryExecutionJournal();
    await journal.append({ id: '1', symbol: 'XRPUSDT', side: 'LONG', strategyId: 'MICRO', event: 'PREPARED', timestampMs: 1000 });
    await journal.append({ id: '2', symbol: 'BTCUSDT', side: 'SHORT', strategyId: 'AEGIS', event: 'PREPARED', timestampMs: 2000 });

    expect(await journal.read('XRPUSDT')).toHaveLength(1);
    expect(await journal.read('BTCUSDT')).toHaveLength(1);
  });

  it('preserves metadata', async () => {
    const journal = new InMemoryExecutionJournal();
    await journal.append({
      id: '1', symbol: 'XRPUSDT', side: 'LONG', strategyId: 'MICRO', event: 'PREPARED',
      timestampMs: 1000, metadata: { stopPrice: 0.9, entryPrice: 1.0 },
    });
    const entry = await journal.readLatest('XRPUSDT');
    expect(entry?.metadata).toEqual({ stopPrice: 0.9, entryPrice: 1.0 });
  });
});

describe('isValidTransition', () => {
  it('accepts valid transitions', () => {
    expect(isValidTransition('PREPARED', 'SUBMITTED')).toBe(true);
    expect(isValidTransition('SUBMITTED', 'OPEN_CONFIRMED')).toBe(true);
    expect(isValidTransition('OPEN_CONFIRMED', 'PROTECTED')).toBe(true);
    expect(isValidTransition('PROTECTED', 'CLOSE_PENDING')).toBe(true);
    expect(isValidTransition('CLOSE_PENDING', 'CLOSED')).toBe(true);
    expect(isValidTransition('PREPARED', 'UNKNOWN')).toBe(true);
    expect(isValidTransition('SUBMITTED', 'RECOVERY_REQUIRED')).toBe(true);
    expect(isValidTransition('UNKNOWN', 'RECOVERY_REQUIRED')).toBe(true);
    expect(isValidTransition('RECOVERY_REQUIRED', 'CLOSE_PENDING')).toBe(true);
  });

  it('rejects invalid transitions', () => {
    expect(isValidTransition('CLOSED', 'PREPARED')).toBe(false);
    expect(isValidTransition('PREPARED', 'CLOSED')).toBe(false);
    expect(isValidTransition('SUBMITTED', 'PROTECTED')).toBe(false);
    expect(isValidTransition('CLOSED', 'UNKNOWN')).toBe(false);
  });
});
