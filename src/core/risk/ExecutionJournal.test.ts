import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  InMemoryExecutionJournal,
  FileBackedExecutionJournal,
  isValidTransition,
  JournalEntry,
} from './ExecutionJournal';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'journal-test-'));
}

function makeEntry(overrides: Partial<Omit<JournalEntry, 'version' | 'sequence'>> = {}): Omit<JournalEntry, 'version' | 'sequence'> {
  return {
    id: `id-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    operationId: overrides.operationId ?? 'op-xrpusdt-001',
    scope: { account: 'default', environment: 'testnet' },
    symbol: 'XRPUSDT',
    side: 'LONG',
    strategyId: 'MICRO',
    event: 'PREPARED',
    timestampMs: Date.now(),
    ...overrides,
  };
}

// ─── InMemoryExecutionJournal ─────────────────────────────────────────────────

describe('InMemoryExecutionJournal', () => {
  it('appends and reads entries in order with version and sequence', async () => {
    const journal = new InMemoryExecutionJournal();
    const e1 = await journal.append(makeEntry({ event: 'PREPARED' }));
    const e2 = await journal.append(makeEntry({ event: 'SUBMITTED' }));

    expect(e1.version).toBe(1);
    expect(e1.sequence).toBe(1);
    expect(e2.version).toBe(2);
    expect(e2.sequence).toBe(2);

    const entries = await journal.read(e1.operationId);
    expect(entries).toHaveLength(2);
    expect(entries[0].event).toBe('PREPARED');
    expect(entries[1].event).toBe('SUBMITTED');
  });

  it('returns empty array for unknown operationId', async () => {
    const journal = new InMemoryExecutionJournal();
    expect(await journal.read('nonexistent')).toEqual([]);
  });

  it('reads latest entry', async () => {
    const journal = new InMemoryExecutionJournal();
    await journal.append(makeEntry({ event: 'PREPARED' }));
    const e2 = await journal.append(makeEntry({ event: 'SUBMITTED' }));

    const latest = await journal.readLatest(e2.operationId);
    expect(latest?.event).toBe('SUBMITTED');
    expect(latest?.version).toBe(2);
  });

  it('returns null for latest of unknown operationId', async () => {
    const journal = new InMemoryExecutionJournal();
    expect(await journal.readLatest('nonexistent')).toBeNull();
  });

  it('reads entries by event type', async () => {
    const journal = new InMemoryExecutionJournal();
    await journal.append(makeEntry({ event: 'PREPARED' }));
    await journal.append(makeEntry({ event: 'SUBMITTED' }));
    await journal.append(makeEntry({ event: 'UNKNOWN' }));

    const submitted = await journal.readByEvent('op-xrpusdt-001', 'SUBMITTED');
    expect(submitted).toHaveLength(1);
    expect(submitted[0].event).toBe('SUBMITTED');
  });

  it('tracks submitted client order ids only on SUBMITTED event', async () => {
    const journal = new InMemoryExecutionJournal();
    await journal.append(makeEntry({ event: 'PREPARED', clientOrderId: 'C1' }));
    expect(await journal.isSubmitted('C1')).toBe(false);

    await journal.append(makeEntry({ event: 'SUBMITTED', clientOrderId: 'C1' }));
    expect(await journal.isSubmitted('C1')).toBe(true);
    expect(await journal.isSubmitted('C2')).toBe(false);
  });

  it('versions are per-operation, not per-symbol', async () => {
    const journal = new InMemoryExecutionJournal();
    const e1 = await journal.append(makeEntry({ operationId: 'op-A', symbol: 'XRPUSDT' }));
    const e2 = await journal.append(makeEntry({ operationId: 'op-B', symbol: 'XRPUSDT' }));
    const e3 = await journal.append(makeEntry({ operationId: 'op-A', symbol: 'XRPUSDT', event: 'SUBMITTED' }));

    expect(e1.version).toBe(1);
    expect(e2.version).toBe(1); // Different operation, starts at 1
    expect(e3.version).toBe(2); // Same operation as e1, continues
    expect(e3.sequence).toBe(3); // Global sequence is monotonic
  });

  it('two operations of same symbol can be concurrent', async () => {
    const journal = new InMemoryExecutionJournal();
    await journal.append(makeEntry({ operationId: 'op-1', event: 'PREPARED', symbol: 'XRPUSDT' }));
    await journal.append(makeEntry({ operationId: 'op-2', event: 'PREPARED', symbol: 'XRPUSDT' }));
    await journal.append(makeEntry({ operationId: 'op-1', event: 'SUBMITTED' }));
    await journal.append(makeEntry({ operationId: 'op-2', event: 'SUBMITTED' }));

    expect(await journal.read('op-1')).toHaveLength(2);
    expect(await journal.read('op-2')).toHaveLength(2);
  });

  it('new PREPARED after CLOSED is valid', async () => {
    const journal = new InMemoryExecutionJournal();
    await journal.append(makeEntry({ event: 'PREPARED' }));
    await journal.append(makeEntry({ event: 'SUBMITTED' }));
    await journal.append(makeEntry({ event: 'OPEN_CONFIRMED' }));
    await journal.append(makeEntry({ event: 'PROTECTED' }));
    await journal.append(makeEntry({ event: 'CLOSE_PENDING' }));
    await journal.append(makeEntry({ event: 'CLOSED' }));
    // New operation after CLOSED
    await journal.append(makeEntry({ event: 'PREPARED' }));

    const entries = await journal.read('op-xrpusdt-001');
    expect(entries).toHaveLength(7);
    expect(entries[6].event).toBe('PREPARED');
    expect(entries[6].version).toBe(7);
  });

  it('rejects invalid transition', async () => {
    const journal = new InMemoryExecutionJournal();
    await journal.append(makeEntry({ event: 'PREPARED' }));
    await journal.append(makeEntry({ event: 'SUBMITTED' }));

    await expect(
      journal.append(makeEntry({ event: 'CLOSED' })),
    ).rejects.toThrow('Invalid transition: SUBMITTED -> CLOSED');
  });

  it('idempotent: same id + same content returns existing', async () => {
    const journal = new InMemoryExecutionJournal();
    const entry = makeEntry({ id: 'fixed-id' });
    const e1 = await journal.append(entry);
    const e2 = await journal.append({ ...entry });

    expect(e1.id).toBe(e2.id);
    expect(e1.version).toBe(e2.version);
    expect(e1.sequence).toBe(e2.sequence);
    expect(await journal.read('op-xrpusdt-001')).toHaveLength(1);
  });

  it('conflict: same id + different content throws', async () => {
    const journal = new InMemoryExecutionJournal();
    await journal.append(makeEntry({ id: 'fixed-id', event: 'PREPARED' }));

    await expect(
      journal.append(makeEntry({ id: 'fixed-id', event: 'SUBMITTED' })),
    ).rejects.toThrow('ID_CONFLICT');
  });

  it('defensive copy: returned entry cannot mutate journal', async () => {
    const journal = new InMemoryExecutionJournal();
    const e1 = await journal.append(makeEntry({ metadata: { foo: 'bar' } }));
    e1.metadata!.foo = 'MUTATED';
    e1.event = 'SUBMITTED';

    const read = await journal.readLatest(e1.operationId);
    expect(read?.metadata?.foo).toBe('bar');
    expect(read?.event).toBe('PREPARED');
  });

  it('listNonTerminal returns operations not in terminal state', async () => {
    const journal = new InMemoryExecutionJournal();
    await journal.append(makeEntry({ operationId: 'op-A', event: 'PREPARED' }));
    await journal.append(makeEntry({ operationId: 'op-B', event: 'PREPARED' }));
    await journal.append(makeEntry({ operationId: 'op-B', event: 'SUBMITTED' }));
    // op-B is not closed yet
    await journal.append(makeEntry({ operationId: 'op-C', event: 'PREPARED' }));
    await journal.append(makeEntry({ operationId: 'op-C', event: 'SUBMITTED' }));
    await journal.append(makeEntry({ operationId: 'op-C', event: 'OPEN_CONFIRMED' }));
    await journal.append(makeEntry({ operationId: 'op-C', event: 'PROTECTED' }));
    await journal.append(makeEntry({ operationId: 'op-C', event: 'CLOSE_PENDING' }));
    await journal.append(makeEntry({ operationId: 'op-C', event: 'CLOSED' }));

    const nonTerminal = await journal.listNonTerminal();
    expect(nonTerminal).toContain('op-A');
    expect(nonTerminal).toContain('op-B');
    expect(nonTerminal).not.toContain('op-C');
  });

  it('flush is a no-op', async () => {
    const journal = new InMemoryExecutionJournal();
    await journal.flush();
  });

  it('close prevents new appends', async () => {
    const journal = new InMemoryExecutionJournal();
    await journal.close();
    await expect(journal.append(makeEntry())).rejects.toThrow('JOURNAL_CLOSED');
  });
});

// ─── isValidTransition ────────────────────────────────────────────────────────

describe('isValidTransition', () => {
  it('accepts valid transitions', () => {
    expect(isValidTransition('PREPARED', 'SUBMITTED')).toBe(true);
    expect(isValidTransition('SUBMITTED', 'OPEN_CONFIRMED')).toBe(true);
    expect(isValidTransition('OPEN_CONFIRMED', 'PROTECTED')).toBe(true);
    expect(isValidTransition('PROTECTED', 'CLOSE_PENDING')).toBe(true);
    expect(isValidTransition('CLOSE_PENDING', 'CLOSED')).toBe(true);
    expect(isValidTransition('CLOSED', 'PREPARED')).toBe(true);
    expect(isValidTransition('UNKNOWN', 'RECOVERY_REQUIRED')).toBe(true);
    expect(isValidTransition('RECOVERY_REQUIRED', 'CLOSE_PENDING')).toBe(true);
  });

  it('rejects invalid transitions', () => {
    expect(isValidTransition('CLOSED', 'SUBMITTED')).toBe(false);
    expect(isValidTransition('PREPARED', 'CLOSED')).toBe(false);
    expect(isValidTransition('SUBMITTED', 'PROTECTED')).toBe(false);
    expect(isValidTransition('CLOSED', 'UNKNOWN')).toBe(false);
    expect(isValidTransition('CLOSED', 'CLOSE_PENDING')).toBe(false);
  });
});

// ─── FileBackedExecutionJournal ──────────────────────────────────────────────

describe('FileBackedExecutionJournal', () => {
  let dir: string;

  beforeEach(() => {
    dir = tmpDir();
  });

  afterEach(() => {
    // Clean up any lock files and the directory
    try {
      const files = fs.readdirSync(dir);
      for (const f of files) {
        fs.unlinkSync(path.join(dir, f));
      }
      fs.rmdirSync(dir);
    } catch {
      // Best effort cleanup
    }
  });

  it('appends JSONL lines and reads them back', async () => {
    const filePath = path.join(dir, 'journal.jsonl');
    const journal = new FileBackedExecutionJournal(filePath);

    const e1 = await journal.append(makeEntry({ event: 'PREPARED' }));
    const e2 = await journal.append(makeEntry({ event: 'SUBMITTED' }));

    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).event).toBe('PREPARED');
    expect(JSON.parse(lines[1]).event).toBe('SUBMITTED');

    const entries = await journal.read(e1.operationId);
    expect(entries).toHaveLength(2);
    await journal.close();
  });

  it('loads existing file on construction', async () => {
    const filePath = path.join(dir, 'journal.jsonl');

    // Create and populate with first instance
    const journal1 = new FileBackedExecutionJournal(filePath);
    await journal1.append(makeEntry({ event: 'PREPARED' }));
    await journal1.append(makeEntry({ event: 'SUBMITTED' }));
    await journal1.close();

    // Open second instance — should load existing data
    const journal2 = new FileBackedExecutionJournal(filePath);
    const entries = await journal2.read('op-xrpusdt-001');
    expect(entries).toHaveLength(2);
    expect(entries[0].event).toBe('PREPARED');
    expect(entries[0].version).toBe(1);
    expect(entries[1].event).toBe('SUBMITTED');
    expect(entries[1].version).toBe(2);
    await journal2.close();
  });

  it('survives restart and continues versioning', async () => {
    const filePath = path.join(dir, 'journal.jsonl');

    const j1 = new FileBackedExecutionJournal(filePath);
    await j1.append(makeEntry({ event: 'PREPARED' }));
    await j1.append(makeEntry({ event: 'SUBMITTED' }));
    await j1.close();

    const j2 = new FileBackedExecutionJournal(filePath);
    const e3 = await j2.append(makeEntry({ event: 'OPEN_CONFIRMED' }));
    expect(e3.version).toBe(3);
    expect(e3.sequence).toBe(3);

    const entries = await j2.read('op-xrpusdt-001');
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.event)).toEqual(['PREPARED', 'SUBMITTED', 'OPEN_CONFIRMED']);
    await j2.close();
  });

  it('new operation after CLOSED works (per-operation state machine)', async () => {
    const filePath = path.join(dir, 'journal.jsonl');
    const j = new FileBackedExecutionJournal(filePath);

    await j.append(makeEntry({ event: 'PREPARED' }));
    await j.append(makeEntry({ event: 'SUBMITTED' }));
    await j.append(makeEntry({ event: 'OPEN_CONFIRMED' }));
    await j.append(makeEntry({ event: 'PROTECTED' }));
    await j.append(makeEntry({ event: 'CLOSE_PENDING' }));
    await j.append(makeEntry({ event: 'CLOSED' }));
    // New PREPARED after CLOSED
    await j.append(makeEntry({ event: 'PREPARED' }));

    const entries = await j.read('op-xrpusdt-001');
    expect(entries).toHaveLength(7);
    expect(entries[6].event).toBe('PREPARED');
    expect(entries[6].version).toBe(7);
    await j.close();
  });

  it('concurrent operations on same symbol', async () => {
    const filePath = path.join(dir, 'journal.jsonl');
    const j = new FileBackedExecutionJournal(filePath);

    await j.append(makeEntry({ operationId: 'op-A', event: 'PREPARED', symbol: 'XRPUSDT' }));
    await j.append(makeEntry({ operationId: 'op-B', event: 'PREPARED', symbol: 'XRPUSDT' }));
    await j.append(makeEntry({ operationId: 'op-A', event: 'SUBMITTED' }));
    await j.append(makeEntry({ operationId: 'op-B', event: 'SUBMITTED' }));
    await j.append(makeEntry({ operationId: 'op-A', event: 'OPEN_CONFIRMED' }));
    await j.append(makeEntry({ operationId: 'op-A', event: 'PROTECTED' }));
    await j.append(makeEntry({ operationId: 'op-A', event: 'CLOSE_PENDING' }));
    await j.append(makeEntry({ operationId: 'op-A', event: 'CLOSED' }));
    await j.append(makeEntry({ operationId: 'op-B', event: 'OPEN_CONFIRMED' }));

    const entriesA = await j.read('op-A');
    const entriesB = await j.read('op-B');
    expect(entriesA).toHaveLength(6);
    expect(entriesB).toHaveLength(3);

    const nonTerminal = await j.listNonTerminal();
    expect(nonTerminal).toContain('op-B');
    expect(nonTerminal).not.toContain('op-A');
    await j.close();
  });

  it('rejects invalid transition', async () => {
    const filePath = path.join(dir, 'journal.jsonl');
    const j = new FileBackedExecutionJournal(filePath);

    await j.append(makeEntry({ event: 'PREPARED' }));
    await j.append(makeEntry({ event: 'SUBMITTED' }));

    await expect(
      j.append(makeEntry({ event: 'CLOSED' })),
    ).rejects.toThrow('Invalid transition');
    await j.close();
  });

  it('idempotent: same id + same content returns existing', async () => {
    const filePath = path.join(dir, 'journal.jsonl');
    const j = new FileBackedExecutionJournal(filePath);

    const entry = makeEntry({ id: 'idem-1' });
    const e1 = await j.append(entry);
    const e2 = await j.append({ ...entry });

    expect(e1.version).toBe(e2.version);
    expect(e1.sequence).toBe(e2.sequence);
    expect(await j.read('op-xrpusdt-001')).toHaveLength(1);
    await j.close();
  });

  it('conflict: same id + different event throws', async () => {
    const filePath = path.join(dir, 'journal.jsonl');
    const j = new FileBackedExecutionJournal(filePath);

    await j.append(makeEntry({ id: 'idem-2', event: 'PREPARED' }));

    await expect(
      j.append(makeEntry({ id: 'idem-2', event: 'SUBMITTED' })),
    ).rejects.toThrow('ID_CONFLICT');
    await j.close();
  });

  it('defensive copy on read', async () => {
    const filePath = path.join(dir, 'journal.jsonl');
    const j = new FileBackedExecutionJournal(filePath);

    await j.append(makeEntry({ metadata: { key: 'value' } }));
    const entries = await j.read('op-xrpusdt-001');
    entries[0].metadata!.key = 'MUTATED';
    entries[0].event = 'SUBMITTED';

    const read = await j.readLatest('op-xrpusdt-001');
    expect(read?.metadata?.key).toBe('value');
    expect(read?.event).toBe('PREPARED');
    await j.close();
  });

  it('persists crash-safe: append succeeds or fails, never partial', async () => {
    const filePath = path.join(dir, 'journal.jsonl');
    const j = new FileBackedExecutionJournal(filePath);

    await j.append(makeEntry({ event: 'PREPARED' }));
    await j.append(makeEntry({ event: 'SUBMITTED' }));
    await j.close();

    // Verify file is valid JSONL
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(2);

    // Each line is valid JSON
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed.id).toBeDefined();
      expect(parsed.version).toBeDefined();
      expect(parsed.sequence).toBeDefined();
    }
  });

  it('rejects corrupt JSON line', () => {
    const filePath = path.join(dir, 'journal.jsonl');
    fs.writeFileSync(filePath, 'not valid json\n', 'utf8');

    expect(() => new FileBackedExecutionJournal(filePath)).toThrow('JOURNAL_CORRUPT_LINE');
  });

  it('rejects schema invalid entry', () => {
    const filePath = path.join(dir, 'journal.jsonl');
    fs.writeFileSync(filePath, JSON.stringify({ id: 'x', invalid: true }) + '\n', 'utf8');

    expect(() => new FileBackedExecutionJournal(filePath)).toThrow('JOURNAL_INVALID_LINE');
  });

  it('rejects sequence gap', () => {
    const filePath = path.join(dir, 'journal.jsonl');
    const entry1 = { id: '1', operationId: 'op-1', scope: { account: 'a', environment: 'e' }, symbol: 'XRPUSDT', side: 'LONG', strategyId: 'S', event: 'PREPARED', timestampMs: 1000, version: 1, sequence: 1 };
    const entry2 = { ...entry1, id: '2', event: 'SUBMITTED', version: 2, sequence: 3 }; // gap: 1 -> 3
    fs.writeFileSync(filePath, JSON.stringify(entry1) + '\n' + JSON.stringify(entry2) + '\n', 'utf8');

    expect(() => new FileBackedExecutionJournal(filePath)).toThrow('JOURNAL_SEQUENCE_GAP');
  });

  it('rejects invalid transition on load', () => {
    const filePath = path.join(dir, 'journal.jsonl');
    const entry1 = { id: '1', operationId: 'op-1', scope: { account: 'a', environment: 'e' }, symbol: 'XRPUSDT', side: 'LONG', strategyId: 'S', event: 'PREPARED', timestampMs: 1000, version: 1, sequence: 1 };
    const entry2 = { ...entry1, id: '2', event: 'CLOSED', version: 2, sequence: 2 }; // invalid: PREPARED -> CLOSED
    fs.writeFileSync(filePath, JSON.stringify(entry1) + '\n' + JSON.stringify(entry2) + '\n', 'utf8');

    expect(() => new FileBackedExecutionJournal(filePath)).toThrow('JOURNAL_TRANSITION_INVALID');
  });

  it('rejects version gap', () => {
    const filePath = path.join(dir, 'journal.jsonl');
    const entry1 = { id: '1', operationId: 'op-1', scope: { account: 'a', environment: 'e' }, symbol: 'XRPUSDT', side: 'LONG', strategyId: 'S', event: 'PREPARED', timestampMs: 1000, version: 1, sequence: 1 };
    const entry2 = { ...entry1, id: '2', event: 'SUBMITTED', version: 5, sequence: 2 }; // gap: 1 -> 5
    fs.writeFileSync(filePath, JSON.stringify(entry1) + '\n' + JSON.stringify(entry2) + '\n', 'utf8');

    expect(() => new FileBackedExecutionJournal(filePath)).toThrow('JOURNAL_VERSION_GAP');
  });

  it('preserves file bytes on corruption (does not truncate)', async () => {
    const filePath = path.join(dir, 'journal.jsonl');
    const j = new FileBackedExecutionJournal(filePath);
    await j.append(makeEntry({ event: 'PREPARED' }));
    await j.close();

    // Append corrupt data
    fs.appendFileSync(filePath, 'CORRUPT DATA\n', 'utf8');

    // Should throw but not modify the file
    const originalSize = fs.statSync(filePath).size;
    expect(() => new FileBackedExecutionJournal(filePath)).toThrow('JOURNAL_CORRUPT_LINE');
    expect(fs.statSync(filePath).size).toBe(originalSize);
  });

  it('lock file prevents second writer', async () => {
    const filePath = path.join(dir, 'journal.jsonl');
    const j1 = new FileBackedExecutionJournal(filePath);

    // Second instance should fail with JOURNAL_WRITER_LOCKED
    expect(() => new FileBackedExecutionJournal(filePath)).toThrow('JOURNAL_WRITER_LOCKED');
    await j1.close();
  });

  it('stale lock is recovered', async () => {
    const filePath = path.join(dir, 'journal.jsonl');
    const lockPath = `${filePath}.lock`;

    // Create a lock file with a PID that doesn't exist
    fs.writeFileSync(lockPath, '99999999', 'utf8');

    // Should not throw — stale lock is recovered
    const j = new FileBackedExecutionJournal(filePath);
    await j.append(makeEntry());
    await j.close();
  });

  it('close prevents new appends', async () => {
    const filePath = path.join(dir, 'journal.jsonl');
    const j = new FileBackedExecutionJournal(filePath);
    await j.close();

    await expect(j.append(makeEntry())).rejects.toThrow('JOURNAL_CLOSED');
  });

  it('idempotent append survives restart', async () => {
    const filePath = path.join(dir, 'journal.jsonl');

    const j1 = new FileBackedExecutionJournal(filePath);
    const entry = makeEntry({ id: 'persist-idem' });
    await j1.append(entry);
    await j1.close();

    const j2 = new FileBackedExecutionJournal(filePath);
    // Same id + same content = idempotent, no duplication
    const result = await j2.append({ ...entry });
    expect(result.version).toBe(1);
    expect(await j2.read('op-xrpusdt-001')).toHaveLength(1);
    await j2.close();
  });

  it('RECOVERY_REQUIRED state is preserved across restart', async () => {
    const filePath = path.join(dir, 'journal.jsonl');

    const j1 = new FileBackedExecutionJournal(filePath);
    await j1.append(makeEntry({ event: 'PREPARED' }));
    await j1.append(makeEntry({ event: 'SUBMITTED' }));
    await j1.append(makeEntry({ event: 'RECOVERY_REQUIRED' }));
    await j1.close();

    const j2 = new FileBackedExecutionJournal(filePath);
    const nonTerminal = await j2.listNonTerminal();
    expect(nonTerminal).toContain('op-xrpusdt-001');

    const entries = await j2.read('op-xrpusdt-001');
    expect(entries[2].event).toBe('RECOVERY_REQUIRED');
    await j2.close();
  });

  it('multiple operations with different scopes are isolated', async () => {
    const filePath = path.join(dir, 'journal.jsonl');
    const j = new FileBackedExecutionJournal(filePath);

    await j.append(makeEntry({
      operationId: 'op-prod',
      scope: { account: 'prod', environment: 'live' },
      event: 'PREPARED',
    }));
    await j.append(makeEntry({
      operationId: 'op-test',
      scope: { account: 'test', environment: 'testnet' },
      event: 'PREPARED',
    }));
    await j.append(makeEntry({
      operationId: 'op-prod',
      event: 'SUBMITTED',
    }));

    const prodEntries = await j.read('op-prod');
    const testEntries = await j.read('op-test');
    expect(prodEntries).toHaveLength(2);
    expect(testEntries).toHaveLength(1);
    expect(prodEntries[0].scope.environment).toBe('live');
    expect(testEntries[0].scope.environment).toBe('testnet');
    await j.close();
  });

  it('flush and close lifecycle', async () => {
    const filePath = path.join(dir, 'journal.jsonl');
    const j = new FileBackedExecutionJournal(filePath);
    await j.append(makeEntry());
    await j.flush(); // Should not throw
    await j.close();
    // Close is idempotent
    await j.close();
  });

  it('empty file is valid (new journal)', async () => {
    const filePath = path.join(dir, 'journal.jsonl');
    fs.writeFileSync(filePath, '', 'utf8');
    const j = new FileBackedExecutionJournal(filePath);
    expect(await j.read('nonexistent')).toEqual([]);
    await j.close();
  });

  it('idempotent append: same id + different event throws conflict', async () => {
    const filePath = path.join(dir, 'journal.jsonl');
    const j = new FileBackedExecutionJournal(filePath);

    await j.append(makeEntry({ id: 'conflict-test', event: 'PREPARED' }));

    await expect(
      j.append(makeEntry({ id: 'conflict-test', event: 'UNKNOWN' })),
    ).rejects.toThrow('ID_CONFLICT');
    await j.close();
  });

  it('CLOSED allows new PREPARED with same operationId (restart)', async () => {
    const filePath = path.join(dir, 'journal.jsonl');
    const j = new FileBackedExecutionJournal(filePath);

    await j.append(makeEntry({ event: 'PREPARED' }));
    await j.append(makeEntry({ event: 'SUBMITTED' }));
    await j.append(makeEntry({ event: 'OPEN_CONFIRMED' }));
    await j.append(makeEntry({ event: 'PROTECTED' }));
    await j.append(makeEntry({ event: 'CLOSE_PENDING' }));
    await j.append(makeEntry({ event: 'CLOSED' }));
    // Restart scenario: new PREPARED after CLOSED
    await j.append(makeEntry({ event: 'PREPARED' }));

    const entries = await j.read('op-xrpusdt-001');
    expect(entries).toHaveLength(7);
    expect(entries[5].event).toBe('CLOSED');
    expect(entries[6].event).toBe('PREPARED');
    expect(entries[6].version).toBe(7);
    await j.close();
  });

  it('UNKNOWN allows new PREPARED (recovery path)', async () => {
    const filePath = path.join(dir, 'journal.jsonl');
    const j = new FileBackedExecutionJournal(filePath);

    await j.append(makeEntry({ event: 'PREPARED' }));
    await j.append(makeEntry({ event: 'UNKNOWN' }));
    await j.append(makeEntry({ event: 'PREPARED' }));

    const entries = await j.read('op-xrpusdt-001');
    expect(entries).toHaveLength(3);
    expect(entries[2].event).toBe('PREPARED');
    await j.close();
  });
});
