import { describe, expect, it, vi } from 'vitest';
import { InMemoryExecutionJournal, FileBackedExecutionJournal, isValidTransition } from './ExecutionJournal';

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
    // Use UNKNOWN (valid from SUBMITTED) for a second event of same type.
    await journal.append({ id: '3', symbol: 'XRPUSDT', side: 'LONG', strategyId: 'MICRO', event: 'UNKNOWN', timestampMs: 3000 });

    const submitted = await journal.readByEvent('XRPUSDT', 'SUBMITTED');
    expect(submitted).toHaveLength(1);
    expect(submitted.every((e) => e.event === 'SUBMITTED')).toBe(true);
  });

  it('tracks submitted client order ids only on SUBMITTED event', async () => {
    const journal = new InMemoryExecutionJournal();
    // PREPARED with clientOrderId should NOT mark as submitted.
    await journal.append({ id: '1', symbol: 'XRPUSDT', side: 'LONG', strategyId: 'MICRO', event: 'PREPARED', timestampMs: 1000, clientOrderId: 'C1' });
    expect(await journal.isSubmitted('C1')).toBe(false);

    // SUBMITTED with clientOrderId should mark as submitted.
    await journal.append({ id: '2', symbol: 'XRPUSDT', side: 'LONG', strategyId: 'MICRO', event: 'SUBMITTED', timestampMs: 2000, clientOrderId: 'C1' });
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

describe('InMemoryExecutionJournal transition enforcement', () => {
  it('throws on invalid transition', async () => {
    const journal = new InMemoryExecutionJournal();
    await journal.append({ id: '1', symbol: 'XRPUSDT', side: 'LONG', strategyId: 'MICRO', event: 'PREPARED', timestampMs: 1000 });
    await journal.append({ id: '2', symbol: 'XRPUSDT', side: 'LONG', strategyId: 'MICRO', event: 'SUBMITTED', timestampMs: 2000 });

    // Cannot jump from SUBMITTED to CLOSED.
    await expect(
      journal.append({ id: '3', symbol: 'XRPUSDT', side: 'LONG', strategyId: 'MICRO', event: 'CLOSED', timestampMs: 3000 }),
    ).rejects.toThrow('Invalid transition: SUBMITTED -> CLOSED');
  });

  it('allows valid transitions', async () => {
    const journal = new InMemoryExecutionJournal();
    await journal.append({ id: '1', symbol: 'XRPUSDT', side: 'LONG', strategyId: 'MICRO', event: 'PREPARED', timestampMs: 1000 });
    await journal.append({ id: '2', symbol: 'XRPUSDT', side: 'LONG', strategyId: 'MICRO', event: 'SUBMITTED', timestampMs: 2000 });
    await journal.append({ id: '3', symbol: 'XRPUSDT', side: 'LONG', strategyId: 'MICRO', event: 'OPEN_CONFIRMED', timestampMs: 3000 });
    await journal.append({ id: '4', symbol: 'XRPUSDT', side: 'LONG', strategyId: 'MICRO', event: 'PROTECTED', timestampMs: 4000 });
    await journal.append({ id: '5', symbol: 'XRPUSDT', side: 'LONG', strategyId: 'MICRO', event: 'CLOSE_PENDING', timestampMs: 5000 });
    await journal.append({ id: '6', symbol: 'XRPUSDT', side: 'LONG', strategyId: 'MICRO', event: 'CLOSED', timestampMs: 6000 });

    const entries = await journal.read('XRPUSDT');
    expect(entries).toHaveLength(6);
    expect(entries.map((e) => e.event)).toEqual([
      'PREPARED', 'SUBMITTED', 'OPEN_CONFIRMED', 'PROTECTED', 'CLOSE_PENDING', 'CLOSED',
    ]);
  });
});

describe('FileBackedExecutionJournal', () => {
  it('persists to file and restores on read', async () => {
    const fs = {
      writeFileSync: vi.fn(),
      readFileSync: vi.fn().mockReturnValue('[]'),
    };
    const journal = new FileBackedExecutionJournal('/tmp/test-journal.json', fs as any);

    await journal.append({ id: '1', symbol: 'XRPUSDT', side: 'LONG', strategyId: 'MICRO', event: 'PREPARED', timestampMs: 1000 });
    await journal.append({ id: '2', symbol: 'XRPUSDT', side: 'LONG', strategyId: 'MICRO', event: 'SUBMITTED', timestampMs: 2000, clientOrderId: 'C1' });

    // File was written.
    expect(fs.writeFileSync).toHaveBeenCalled();
    const writtenData = JSON.parse(fs.writeFileSync.mock.calls[fs.writeFileSync.mock.calls.length - 1][1]);
    expect(writtenData).toHaveLength(2);
    expect(writtenData[0].event).toBe('PREPARED');
    expect(writtenData[1].event).toBe('SUBMITTED');

    // Read works.
    const entries = await journal.read('XRPUSDT');
    expect(entries).toHaveLength(2);
  });

  it('enforces transitions like InMemory', async () => {
    const fs = {
      writeFileSync: vi.fn(),
      readFileSync: vi.fn().mockReturnValue('[]'),
    };
    const journal = new FileBackedExecutionJournal('/tmp/test-journal.json', fs as any);

    await journal.append({ id: '1', symbol: 'XRPUSDT', side: 'LONG', strategyId: 'MICRO', event: 'PREPARED', timestampMs: 1000 });

    await expect(
      journal.append({ id: '2', symbol: 'XRPUSDT', side: 'LONG', strategyId: 'MICRO', event: 'CLOSED', timestampMs: 2000 }),
    ).rejects.toThrow('Invalid transition: PREPARED -> CLOSED');
  });
});
