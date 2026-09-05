import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  FileBackedExecutionJournal,
  InMemoryExecutionJournal,
  type JournalEntry,
  type JournalInput,
} from './ExecutionJournal';

type Journal = InMemoryExecutionJournal | FileBackedExecutionJournal;
let serial = 0;
let dir: string;
let filePath: string;
let journals: Journal[];
let children: { process: ChildProcess; exited: Promise<void> }[];
let retainedFds: Set<number>;

function input(overrides: Partial<JournalInput> = {}): JournalInput {
  return {
    id: `event-${++serial}`,
    operationId: 'op-A',
    scope: { account: 'account-A', environment: 'testnet' },
    symbol: 'XRPUSDT',
    side: 'LONG',
    strategyId: 'MICRO',
    event: 'PREPARED',
    timestampMs: 1700000000000,
    ...overrides,
  };
}

function diskEntry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return { ...input(), schemaVersion: 1, version: 1, sequence: 1, ...overrides };
}

function open(fsModule: typeof fs = fs, target = filePath): FileBackedExecutionJournal {
  const journal = new FileBackedExecutionJournal(target, fsModule);
  journals.push(journal);
  return journal;
}

// Keep real realpath/fstat semantics; only the selected synchronous I/O is replaced.
function proxyFs(overrides: Partial<typeof fs>): typeof fs {
  return new Proxy(fs, {
    get(target, key) {
      return Reflect.get(overrides, key) ?? Reflect.get(target, key);
    },
  });
}

function bytes(): Buffer {
  return fs.readFileSync(filePath);
}

function rows(): JournalEntry[] {
  const raw = bytes().toString('utf8');
  expect(raw.endsWith('\n')).toBe(true);
  return raw
    .slice(0, -1)
    .split('\n')
    .map((line) => JSON.parse(line) as JournalEntry);
}

async function expectPoisoned(journal: Journal): Promise<void> {
  const checks = [
    () => journal.append(input({ operationId: 'must-not-publish' })),
    () => journal.read('op-A'),
    () => journal.readLatest('op-A'),
    () => journal.readByEvent('op-A', 'PREPARED'),
    () => journal.listNonTerminal(),
    () => journal.isSubmitted('CID-A'),
    () => journal.flush(),
  ];
  for (const check of checks) {
    await expect(check()).rejects.toThrow(/JOURNAL_STORAGE_UNCERTAIN/);
  }
}

beforeEach(() => {
  // Match the journal's canonical path (macOS /var is an alias of /private/var).
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'execution-journal-test-')));
  filePath = path.join(dir, 'journal.jsonl');
  journals = [];
  children = [];
  retainedFds = new Set();
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const child of children) {
    if (child.process.exitCode === null && child.process.signalCode === null) {
      child.process.kill('SIGKILL');
    }
    await child.exited;
  }
  // Failure cases assert close errors in the test; cleanup must still release other resources.
  for (const journal of journals) {
    await journal.close().catch(() => undefined);
  }
  for (const fd of retainedFds) {
    try {
      fs.closeSync(fd);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EBADF') throw error;
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe.each(['memory', 'file'] as const)('%s journal contract', (backend) => {
  let journal: Journal;

  beforeEach(() => {
    journal = backend === 'file' ? open() : new InMemoryExecutionJournal();
    if (backend === 'memory') journals.push(journal);
  });

  it('linearizes unawaited calls with global sequence and per-operation versions', async () => {
    const first = journal.append(input());
    const snapshot = journal.read('op-A');
    const other = journal.append(input({ operationId: 'op-B' }));
    const submitted = journal.append(input({ event: 'SUBMITTED', clientOrderId: 'CID-A' }));
    expect(await first).toMatchObject({ schemaVersion: 1, version: 1, sequence: 1 });
    expect(await snapshot).toHaveLength(1);
    expect(await other).toMatchObject({ version: 1, sequence: 2 });
    expect(await submitted).toMatchObject({ version: 2, sequence: 3 });
    expect((await journal.read('op-A')).map((entry) => entry.event)).toEqual([
      'PREPARED',
      'SUBMITTED',
    ]);
    expect(await journal.readLatest('op-A')).toMatchObject({ event: 'SUBMITTED', version: 2 });
    expect(await journal.readByEvent('op-A', 'SUBMITTED')).toEqual([await submitted]);
    expect(await journal.read('absent')).toEqual([]);
    expect(await journal.readLatest('absent')).toBeNull();
    expect(await journal.readByEvent('absent', 'PREPARED')).toEqual([]);
  });

  it('reports submission history, not permission to resend a pending request', async () => {
    await journal.append(input({ clientOrderId: 'CID-A' }));
    expect(await journal.isSubmitted('CID-A')).toBe(false);
    expect(await journal.listNonTerminal()).toEqual(['op-A']);
    await journal.append(input({ event: 'SUBMITTED', clientOrderId: 'CID-A' }));
    await journal.append(input({ event: 'UNKNOWN', clientOrderId: 'CID-A' }));
    expect(await journal.isSubmitted('CID-A')).toBe(true);
    expect(await journal.isSubmitted('absent')).toBe(false);
    expect(await journal.listNonTerminal()).toEqual(['op-A']);
  });

  it.each([
    'SUBMITTED',
    'OPEN_CONFIRMED',
    'PROTECTED',
    'CLOSE_PENDING',
    'CLOSED',
    'UNKNOWN',
    'RECOVERY_REQUIRED',
  ] as const)('rejects initial %s without consuming counters', async (event) => {
    await expect(journal.append(input({ event }))).rejects.toThrow(/JOURNAL_INITIAL_EVENT_INVALID/);
    expect(await journal.append(input())).toMatchObject({ sequence: 1, version: 1 });
  });

  it.each(['PREPARED', 'SUBMITTED', 'OPEN_CONFIRMED', 'PROTECTED'] as const)(
    'allows closing from %s but never resets a CLOSED operation',
    async (last) => {
      const route = ['PREPARED', 'SUBMITTED', 'OPEN_CONFIRMED', 'PROTECTED'] as const;
      for (const event of route.slice(0, route.indexOf(last) + 1))
        await journal.append(input({ event }));
      await journal.append(input({ event: 'CLOSE_PENDING' }));
      const closed = await journal.append(input({ event: 'CLOSED' }));
      // CLOSED -> PREPARED was previously asserted valid, incorrectly reusing an operation ID.
      await expect(journal.append(input())).rejects.toThrow(/JOURNAL_TRANSITION_INVALID/);
      expect(await journal.readLatest('op-A')).toEqual(closed);
      expect(await journal.append(input({ operationId: 'op-B' }))).toMatchObject({
        version: 1,
        sequence: closed.sequence + 1,
      });
      expect(await journal.listNonTerminal()).toEqual(['op-B']);
    },
  );

  it.each(['UNKNOWN', 'RECOVERY_REQUIRED'] as const)(
    'does not turn %s into a fresh attempt',
    async (event) => {
      await journal.append(input());
      await journal.append(input({ event: 'SUBMITTED' }));
      await journal.append(input({ event }));
      await expect(journal.append(input())).rejects.toThrow(/JOURNAL_TRANSITION_INVALID/);
      expect(await journal.listNonTerminal()).toEqual(['op-A']);
      if (event === 'UNKNOWN') await journal.append(input({ event: 'RECOVERY_REQUIRED' }));
      await journal.append(input({ event: 'CLOSE_PENDING' }));
      await journal.append(input({ event: 'CLOSED' }));
      expect(await journal.listNonTerminal()).toEqual([]);
    },
  );

  it('rejects a skipped transition without changing history', async () => {
    await journal.append(input());
    await expect(journal.append(input({ event: 'CLOSED' }))).rejects.toThrow(
      /JOURNAL_TRANSITION_INVALID/,
    );
    expect(await journal.append(input({ event: 'SUBMITTED' }))).toMatchObject({
      version: 2,
      sequence: 2,
    });
  });

  it('uses canonical deep payload equality and normalizes optional top-level undefined', async () => {
    const entry = input({ metadata: { z: [{ b: 2, a: 1 }], a: true } });
    const first = await journal.append(entry);
    await journal.append(input({ event: 'SUBMITTED' }));
    const before = backend === 'file' ? bytes() : undefined;
    expect(
      await journal.append({
        ...entry,
        scope: { environment: 'testnet', account: 'account-A' },
        metadata: { a: true, z: [{ a: 1, b: 2 }] },
        reason: undefined,
      }),
    ).toEqual(first);
    expect(await journal.read('op-A')).toHaveLength(2);
    if (before) expect(bytes()).toEqual(before);
    expect(await journal.append(input({ operationId: 'op-B' }))).toMatchObject({
      version: 1,
      sequence: 3,
    });
  });

  it.each([
    { quantity: 999 },
    { event: 'SUBMITTED' },
    { operationId: 'op-B' },
    { metadata: { nested: [2, 1] } },
    { timestampMs: 1700000000001 },
  ] as Partial<JournalInput>[])('rejects global event ID conflict: %j', async (change) => {
    const entry = input({ quantity: 1, metadata: { nested: [1, 2] } });
    await journal.append(entry);
    await expect(journal.append({ ...entry, ...change })).rejects.toThrow(/ID_CONFLICT/);
    expect(await journal.append(input({ operationId: 'op-C' }))).toMatchObject({
      sequence: 2,
      version: 1,
    });
  });

  it.each([
    { scope: { account: 'account-B', environment: 'testnet' } },
    { scope: { account: 'account-A', environment: 'sandbox' } },
    { symbol: 'BTCUSDT' },
    { side: 'SHORT' },
    { strategyId: 'OTHER' },
  ] as Partial<JournalInput>[])('keeps operation identity immutable: %j', async (change) => {
    await journal.append(input());
    await expect(journal.append(input({ event: 'SUBMITTED', ...change }))).rejects.toThrow(
      /OPERATION_IDENTITY_CONFLICT/,
    );
    expect(await journal.append(input({ event: 'SUBMITTED' }))).toMatchObject({
      sequence: 2,
      version: 2,
    });
  });

  it('scopes client IDs by both account and environment, not by operation', async () => {
    await journal.append(input({ clientOrderId: 'CID-A', quantity: 1 }));
    await expect(
      journal.append(input({ operationId: 'op-B', clientOrderId: 'CID-A' })),
    ).rejects.toThrow(/CLIENT_ORDER_CONFLICT/);
    await journal.append(
      input({
        operationId: 'op-B',
        clientOrderId: 'CID-A',
        scope: { account: 'account-B', environment: 'testnet' },
      }),
    );
    await journal.append(
      input({
        operationId: 'op-C',
        clientOrderId: 'CID-A',
        scope: { account: 'account-A', environment: 'sandbox' },
      }),
    );
    expect(await journal.listNonTerminal()).toEqual(
      expect.arrayContaining(['op-A', 'op-B', 'op-C']),
    );
  });

  it.each([
    { quantity: 2 },
    { stopPrice: 3 },
    { entryPrice: 4 },
    { leverage: 5 },
    { orderId: 'order-B' },
  ])('rejects contradictory request fields: %j', async (change) => {
    await journal.append(
      input({
        clientOrderId: 'CID-A',
        quantity: 1,
        stopPrice: 1,
        entryPrice: 1,
        leverage: 1,
        orderId: 'order-A',
      }),
    );
    await expect(
      journal.append(input({ event: 'SUBMITTED', clientOrderId: 'CID-A', ...change })),
    ).rejects.toThrow(/CLIENT_ORDER_CONFLICT/);
    expect(
      await journal.append(input({ event: 'SUBMITTED', clientOrderId: 'CID-A' })),
    ).toMatchObject({ version: 2, sequence: 2 });
  });

  it('can enrich missing request fields and change metadata without losing immutable fields', async () => {
    await journal.append(input({ clientOrderId: 'CID-A' }));
    await journal.append(
      input({
        event: 'SUBMITTED',
        clientOrderId: 'CID-A',
        quantity: 1,
        orderId: 'order-A',
        metadata: { phase: 1 },
      }),
    );
    await journal.append(
      input({ event: 'OPEN_CONFIRMED', clientOrderId: 'CID-A', metadata: { phase: 2 } }),
    );
    await expect(
      journal.append(input({ event: 'PROTECTED', clientOrderId: 'CID-A', quantity: 999 })),
    ).rejects.toThrow(/CLIENT_ORDER_CONFLICT/);
  });

  it('deeply snapshots input before promise resolution and every returned entry', async () => {
    const entry = input({ metadata: { nested: [{ values: [1, { label: 'original' }] }] } });
    const expected = JSON.parse(JSON.stringify(entry)) as JournalInput;
    const pending = journal.append(entry);
    entry.scope.account = 'mutated-input';
    (entry.metadata!.nested as { values: unknown[] }[])[0].values.push('mutated');
    const returned = await pending;
    const copies = [
      returned,
      (await journal.read('op-A'))[0],
      (await journal.readLatest('op-A'))!,
      (await journal.readByEvent('op-A', 'PREPARED'))[0],
    ];
    for (const copy of copies) {
      copy.scope.environment = 'mutated-output';
      (copy.metadata!.nested as { values: unknown[] }[])[0].values[1] = { label: 'changed' };
      copy.event = 'CLOSED';
    }
    expect(await journal.readLatest('op-A')).toEqual({
      ...expected,
      schemaVersion: 1,
      version: 1,
      sequence: 1,
    });
    const operations = await journal.listNonTerminal();
    operations.length = 0;
    expect(await journal.listNonTerminal()).toEqual(['op-A']);
    if (backend === 'file') {
      expect(rows()).toEqual([{ ...expected, schemaVersion: 1, version: 1, sequence: 1 }]);
      await journal.close();
      expect(await open().readLatest('op-A')).toMatchObject(expected);
    }
  });

  const invalidFields: [string, unknown][] = [
    ['timestampMs', NaN],
    ['timestampMs', Infinity],
    ['timestampMs', -1],
    ['side', 'BUY'],
    ['event', 'INVALID'],
    ...['id', 'operationId', 'symbol', 'strategyId', 'clientOrderId', 'orderId'].flatMap(
      (key): [string, unknown][] =>
        ['', ' leading', 'trailing ', 'bad\nidentifier', 'bad\u0000identifier'].map((value) => [
          key,
          value,
        ]),
    ),
    ...['quantity', 'stopPrice', 'entryPrice', 'leverage'].flatMap((key): [string, unknown][] =>
      [0, -1, NaN, Infinity, '1'].map((value) => [key, value]),
    ),
    ['scope', { account: '', environment: 'testnet' }],
    ['scope', { account: 'account-A', environment: ' testnet' }],
    ['scope', null],
    ['schemaVersion', 1],
    ['version', 1],
    ['sequence', 1],
  ];

  it.each(invalidFields)(
    'rejects invalid %s=%j without counters or disk changes',
    async (key, value) => {
      const before = backend === 'file' ? bytes() : undefined;
      await expect(journal.append({ ...input(), [key]: value } as JournalInput)).rejects.toThrow(
        /ENTRY_INVALID/,
      );
      expect(await journal.read('op-A')).toEqual([]);
      if (before) expect(bytes()).toEqual(before);
      expect(await journal.append(input())).toMatchObject({ version: 1, sequence: 1 });
      if (backend === 'file') {
        await journal.close();
        const restarted = open();
        expect(await restarted.readLatest('op-A')).toMatchObject({ version: 1, sequence: 1 });
        expect(await restarted.append(input({ event: 'SUBMITTED' }))).toMatchObject({
          version: 2,
          sequence: 2,
        });
      }
    },
  );

  it.each([
    'NaN',
    'Infinity',
    'bigint',
    'symbol',
    'function',
    'undefined',
    'cycle',
    'accessor',
    'Date',
    'class',
    'array',
  ])('rejects non-JSON/plain metadata (%s) without invoking accessors', async (kind) => {
    const getter = vi.fn(() => 'unsafe');
    const metadata: Record<string, unknown> = { nested: [{ valid: true }] };
    if (kind === 'NaN') metadata.nested = [{ value: NaN }];
    if (kind === 'Infinity') metadata.nested = [Infinity];
    if (kind === 'bigint') metadata.nested = [BigInt(1)];
    if (kind === 'symbol') metadata.nested = [Symbol('invalid')];
    if (kind === 'function') metadata.nested = [() => undefined];
    if (kind === 'undefined') metadata.nested = [{ value: undefined }];
    if (kind === 'cycle') metadata.self = metadata;
    if (kind === 'accessor')
      Object.defineProperty(metadata, 'value', { enumerable: true, get: getter });
    if (kind === 'Date') metadata.nested = [new Date(0)];
    if (kind === 'class')
      metadata.nested = [
        new (class Payload {
          value = 1;
        })(),
      ];
    const before = backend === 'file' ? bytes() : undefined;
    await expect(
      journal.append(
        input({
          metadata: kind === 'array' ? ([] as unknown as Record<string, unknown>) : metadata,
        }),
      ),
    ).rejects.toThrow(/ENTRY_INVALID/);
    expect(getter).not.toHaveBeenCalled();
    if (before) expect(bytes()).toEqual(before);
    expect(await journal.append(input())).toMatchObject({ version: 1, sequence: 1 });
  });

  it('rejects accessors on the input and scope without evaluating them', async () => {
    const getter = vi.fn(() => 'account-A');
    const scoped = input();
    Object.defineProperty(scoped.scope, 'account', { enumerable: true, get: getter });
    await expect(journal.append(scoped)).rejects.toThrow(/ENTRY_INVALID/);
    const top = input();
    Object.defineProperty(top, 'id', { enumerable: true, get: getter });
    await expect(journal.append(top)).rejects.toThrow(/ENTRY_INVALID/);
    expect(getter).not.toHaveBeenCalled();
    expect(await journal.append(input())).toMatchObject({ version: 1, sequence: 1 });
  });

  it('requires plain records for the input and scope, not inherited payloads', async () => {
    const inherited = Object.create(input()) as JournalInput;
    await expect(journal.append(inherited)).rejects.toThrow(/ENTRY_INVALID/);
    const scoped = input();
    scoped.scope = Object.create(scoped.scope) as JournalInput['scope'];
    await expect(journal.append(scoped)).rejects.toThrow(/ENTRY_INVALID/);
    expect(await journal.append(input())).toMatchObject({ version: 1, sequence: 1 });
  });

  it('flushes and closes idempotently, blocking even duplicate appends', async () => {
    const entry = input();
    await journal.append(entry);
    await journal.flush();
    const closing = journal.close();
    await expect(journal.append(entry)).rejects.toThrow(/JOURNAL_CLOSED/);
    await closing;
    await journal.close();
  });
});

describe('file replay and filesystem ownership', () => {
  it('replays interleaved operations, idempotency, submitted IDs and recovery state', async () => {
    const first = open();
    const prepared = input({ clientOrderId: 'CID-A', quantity: 1 });
    await first.append(prepared);
    await first.append(input({ operationId: 'op-B' }));
    await first.append(input({ event: 'SUBMITTED', clientOrderId: 'CID-A' }));
    await first.append(input({ event: 'RECOVERY_REQUIRED' }));
    await first.close();
    const before = bytes();
    const restarted = open();
    expect(await restarted.append(prepared)).toMatchObject({ version: 1, sequence: 1 });
    expect(bytes()).toEqual(before);
    expect(await restarted.isSubmitted('CID-A')).toBe(true);
    expect(await restarted.readLatest('op-A')).toMatchObject({
      event: 'RECOVERY_REQUIRED',
      version: 3,
    });
    expect(await restarted.listNonTerminal()).toEqual(['op-A', 'op-B']);
    await expect(
      restarted.append(input({ operationId: 'op-C', clientOrderId: 'CID-A' })),
    ).rejects.toThrow(/CLIENT_ORDER_CONFLICT/);
    await expect(restarted.append({ ...prepared, quantity: 999 })).rejects.toThrow(/ID_CONFLICT/);
    await expect(
      restarted.append(input({ event: 'CLOSE_PENDING', side: 'SHORT' })),
    ).rejects.toThrow(/OPERATION_IDENTITY_CONFLICT/);
    await expect(
      restarted.append(input({ event: 'CLOSE_PENDING', clientOrderId: 'CID-A', quantity: 999 })),
    ).rejects.toThrow(/CLIENT_ORDER_CONFLICT/);
    expect(await restarted.append(input({ event: 'CLOSE_PENDING' }))).toMatchObject({
      version: 4,
      sequence: 5,
    });
    await restarted.append(input({ event: 'CLOSED' }));
    await restarted.close();
    const again = open();
    await expect(again.append(input())).rejects.toThrow(/JOURNAL_TRANSITION_INVALID/);
    expect(await again.append(input({ operationId: 'op-C' }))).toMatchObject({
      version: 1,
      sequence: 7,
    });
  });

  it.each(['new', 'empty'] as const)('accepts a %s journal', async (kind) => {
    if (kind === 'empty') fs.writeFileSync(filePath, '');
    const journal = open();
    expect(await journal.read('absent')).toEqual([]);
    expect(await journal.append(input())).toMatchObject({
      schemaVersion: 1,
      sequence: 1,
      version: 1,
    });
  });

  it.each([
    'unversioned',
    'unsupported schema',
    'sequence gap',
    'version gap',
    'unsafe sequence',
    'unsafe version',
    'initial CLOSED',
    'transition',
    'duplicate event',
    'identity',
    'client reuse',
    'client payload',
    'invalid payload',
    'malformed JSON',
    'blank line',
    'whitespace line',
    'missing LF',
    'partial tail',
  ])('rejects replay %s, preserving the exact bytes', (kind) => {
    const first = diskEntry({ id: 'first', clientOrderId: 'CID-A', quantity: 1 });
    const second = { ...first, id: 'second', event: 'SUBMITTED', version: 2, sequence: 2 };
    let records: Record<string, unknown>[] = [first as unknown as Record<string, unknown>, second];
    let error =
      /JOURNAL_|ENTRY_INVALID|ID_CONFLICT|OPERATION_IDENTITY_CONFLICT|CLIENT_ORDER_CONFLICT/;
    if (kind === 'unversioned') {
      delete records[0].schemaVersion;
      error = /JOURNAL_SCHEMA_UNSUPPORTED/;
    }
    if (kind === 'unsupported schema') {
      records[0].schemaVersion = 19;
      error = /JOURNAL_SCHEMA_UNSUPPORTED/;
    }
    if (kind === 'sequence gap') {
      second.sequence = 3;
      error = /JOURNAL_SEQUENCE_GAP/;
    }
    if (kind === 'version gap') {
      second.version = 3;
      error = /JOURNAL_VERSION_GAP/;
    }
    if (kind === 'unsafe sequence') second.sequence = Number.MAX_SAFE_INTEGER + 1;
    if (kind === 'unsafe version') second.version = Number.MAX_SAFE_INTEGER + 1;
    if (kind === 'initial CLOSED') {
      records = [{ ...first, event: 'CLOSED' }];
      error = /JOURNAL_INITIAL_EVENT_INVALID/;
    }
    if (kind === 'transition') {
      second.event = 'CLOSED';
      error = /JOURNAL_TRANSITION_INVALID/;
    }
    if (kind === 'duplicate event') {
      second.id = first.id;
      second.quantity = 999;
    }
    if (kind === 'identity') second.scope = { account: 'account-B', environment: 'testnet' };
    if (kind === 'client reuse') {
      second.operationId = 'op-B';
      second.version = 1;
      second.event = 'PREPARED';
    }
    if (kind === 'client payload') second.quantity = 999;
    if (kind === 'invalid payload') second.quantity = -1;
    let raw = records.map((entry) => JSON.stringify(entry) + '\n').join('');
    if (kind === 'malformed JSON') raw += 'not JSON\n';
    if (kind === 'blank line') raw += '\n';
    if (kind === 'whitespace line') raw += ' \t\n';
    if (kind === 'missing LF') {
      raw = raw.slice(0, -1);
      error = /JOURNAL_TRUNCATED/;
    }
    if (kind === 'partial tail') {
      raw += '{"id":';
      error = /JOURNAL_TRUNCATED/;
    }
    fs.writeFileSync(filePath, raw);
    const before = bytes();
    expect(() => open()).toThrow(error);
    expect(bytes()).toEqual(before);
    expect(fs.existsSync(`${filePath}.lock`)).toBe(false);
    // Constructor failure must not leak ownership and mask the original corruption on retry.
    expect(() => open()).toThrow(error);
    expect(bytes()).toEqual(before);
  });

  it('requires an existing parent and rejects file symlinks and hardlinks', () => {
    expect(() => open(fs, path.join(dir, 'missing', 'journal.jsonl'))).toThrow();
    expect(fs.existsSync(path.join(dir, 'missing'))).toBe(false);
    const target = path.join(dir, 'target.jsonl');
    fs.writeFileSync(target, '');
    fs.symlinkSync(target, filePath);
    expect(() => open()).toThrow();
    expect(fs.lstatSync(filePath).isSymbolicLink()).toBe(true);
    fs.unlinkSync(filePath);
    fs.linkSync(target, filePath);
    expect(() => open()).toThrow();
    expect(fs.statSync(target).nlink).toBe(2);
    expect(fs.readFileSync(target, 'utf8')).toBe('');
  });

  it('canonicalizes parent aliases to the same writer lock', async () => {
    const alias = path.join(dir, 'alias');
    fs.symlinkSync(dir, alias, 'dir');
    const journal = open(fs, path.join(alias, 'journal.jsonl'));
    expect(() => open()).toThrow(/JOURNAL_WRITER_LOCKED/);
    await journal.close();
    await open().append(input());
  });

  it.each(['', '99999999', '{"pid":99999999,"token":"orphan"}'])(
    'never recovers an existing lock (%j) or probes a PID',
    (lock) => {
      fs.writeFileSync(`${filePath}.lock`, lock);
      const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
        throw new Error('PID probing forbidden');
      });
      expect(() => open()).toThrow(/JOURNAL_WRITER_LOCKED/);
      expect(kill).not.toHaveBeenCalled();
      expect(fs.readFileSync(`${filePath}.lock`, 'utf8')).toBe(lock);
      expect(fs.existsSync(filePath)).toBe(false);
    },
  );

  it('locks before loading even a corrupt journal', () => {
    fs.writeFileSync(filePath, 'broken\n');
    fs.writeFileSync(`${filePath}.lock`, 'owned');
    const read = vi.fn(fs.readFileSync);
    expect(() => open(proxyFs({ readFileSync: read as typeof fs.readFileSync }))).toThrow(
      /JOURNAL_WRITER_LOCKED/,
    );
    expect(
      read.mock.calls.some(([target]) => target === filePath || typeof target === 'number'),
    ).toBe(false);
    expect(bytes().toString()).toBe('broken\n');
  });

  it('excludes a second constructor during the empty lock creation window', async () => {
    let checked = false;
    let contenderError: unknown;
    const injected = proxyFs({
      openSync: ((target: fs.PathLike, flags: string | number, mode?: fs.Mode) => {
        const fd = fs.openSync(target, flags, mode);
        if (String(target) === `${filePath}.lock` && !checked) {
          checked = true;
          expect(fs.readFileSync(target, 'utf8')).toBe('');
          try {
            open();
          } catch (error) {
            contenderError = error;
          }
        }
        return fd;
      }) as typeof fs.openSync,
    });
    const journal = open(injected);
    expect(checked).toBe(true);
    expect(contenderError).toBeInstanceOf(Error);
    expect(String(contenderError)).toMatch(/JOURNAL_WRITER_LOCKED/);
    await journal.append(input());
  });

  it.each(['inode', 'token'] as const)(
    'detects lost lock %s and never removes another owner on close',
    async (kind) => {
      const journal = open();
      const lockPath = `${filePath}.lock`;
      const original = fs.readFileSync(lockPath);
      expect(original.toString()).toContain(String(process.pid));
      if (kind === 'inode') {
        // Rename keeps the original inode allocated, preventing immediate inode reuse.
        fs.renameSync(lockPath, `${lockPath}.old`);
        fs.writeFileSync(lockPath, original);
      } else {
        fs.writeFileSync(lockPath, '{"pid":1,"token":"replacement-owner"}');
      }
      const foreign = fs.readFileSync(lockPath);
      const before = bytes();
      await expect(journal.read('op-A')).rejects.toThrow(
        /JOURNAL_LOCK_LOST|JOURNAL_STORAGE_UNCERTAIN/,
      );
      await expect(journal.append(input())).rejects.toThrow(
        /JOURNAL_LOCK_LOST|JOURNAL_STORAGE_UNCERTAIN/,
      );
      await expect(journal.flush()).rejects.toThrow(/JOURNAL_LOCK_LOST|JOURNAL_STORAGE_UNCERTAIN/);
      await expect(journal.close()).rejects.toThrow(/JOURNAL_LOCK_LOST|JOURNAL_STORAGE_UNCERTAIN/);
      expect(fs.readFileSync(lockPath)).toEqual(foreign);
      expect(bytes()).toEqual(before);
      expect(() => open()).toThrow(/JOURNAL_WRITER_LOCKED/);
    },
  );

  it('opens one persistent append descriptor and syncs creation and directory before publication', async () => {
    const events: string[] = [];
    let dataFd = -1;
    let dataOpens = 0;
    const injected = proxyFs({
      openSync: ((target: fs.PathLike, flags: string | number, mode?: fs.Mode) => {
        const fd = fs.openSync(target, flags, mode);
        if (String(target) === `${filePath}.lock`) events.push('lock');
        if (String(target) === filePath) {
          dataFd = fd;
          dataOpens++;
          events.push('open-data');
          expect(typeof flags).toBe('number');
          expect((Number(flags) & fs.constants.O_APPEND) !== 0).toBe(true);
          expect((Number(flags) & fs.constants.O_RDWR) !== 0).toBe(true);
          expect((Number(flags) & fs.constants.O_NOFOLLOW) !== 0).toBe(true);
        }
        return fd;
      }) as typeof fs.openSync,
      fsyncSync: (fd) => {
        events.push(
          fs.fstatSync(fd).isDirectory() ? 'sync-dir' : fd === dataFd ? 'sync-data' : 'sync-lock',
        );
        fs.fsyncSync(fd);
      },
      closeSync: (fd) => {
        if (fd === dataFd) events.push('close-data');
        fs.closeSync(fd);
      },
    });
    const journal = open(injected);
    expect(events.indexOf('lock')).toBeLessThan(events.indexOf('open-data'));
    expect(events).toContain('sync-data');
    expect(events.lastIndexOf('sync-dir')).toBeGreaterThan(events.indexOf('sync-data'));
    expect(events).not.toContain('close-data');
    events.length = 0;
    const pending = journal.append(input());
    expect(events).toContain('sync-data');
    expect(rows()).toHaveLength(1);
    await pending;
    await journal.append(input({ event: 'SUBMITTED' }));
    expect(dataOpens).toBe(1);
    expect(events).not.toContain('close-data');
    await journal.close();
    expect(events).toContain('close-data');
  });
});

describe('file storage fault injection', () => {
  it('loops Buffer short writes to complete UTF-8 JSONL before successful publication', async () => {
    let armed = false;
    let calls = 0;
    const injected = proxyFs({
      writeSync: ((fd: number, buffer: Buffer, offset: number, length: number, position: null) => {
        if (!armed) return fs.writeSync(fd, buffer, offset, length, position);
        calls++;
        expect(Buffer.isBuffer(buffer)).toBe(true);
        expect(position).toBeNull();
        return fs.writeSync(fd, buffer, offset, Math.min(length, 7), position);
      }) as typeof fs.writeSync,
    });
    const journal = open(injected);
    armed = true;
    const entry = input({ metadata: { text: '\u00e9\u20ac\ud83d\ude80'.repeat(10) } });
    const saved = await journal.append(entry);
    expect(calls).toBeGreaterThan(1);
    expect(rows()).toEqual([saved]);
    expect(await journal.readLatest('op-A')).toEqual(saved);
    await journal.close();
    expect(await open().readLatest('op-A')).toEqual(saved);
  });

  it.each(['zero', 'throw', 'negative', 'NaN', 'oversized'] as const)(
    'poisons after partial bytes followed by %s progress, never truncating or writing again',
    async (failure) => {
      let armed = false;
      let calls = 0;
      const injected = proxyFs({
        writeSync: ((
          fd: number,
          buffer: Buffer,
          offset: number,
          length: number,
          position: null,
        ) => {
          if (!armed) return fs.writeSync(fd, buffer, offset, length, position);
          calls++;
          if (calls === 1) return fs.writeSync(fd, buffer, offset, Math.min(11, length), position);
          if (failure === 'throw') throw new Error('injected write failure');
          return failure === 'zero'
            ? 0
            : failure === 'negative'
              ? -1
              : failure === 'NaN'
                ? NaN
                : length + 1;
        }) as typeof fs.writeSync,
      });
      const journal = open(injected);
      armed = true;
      await expect(journal.append(input())).rejects.toThrow(/JOURNAL_STORAGE_UNCERTAIN/);
      const partial = bytes();
      expect(partial.length).toBe(11);
      expect(partial.toString().endsWith('\n')).toBe(false);
      const failedCalls = calls;
      await expectPoisoned(journal);
      expect(calls).toBe(failedCalls);
      expect(bytes()).toEqual(partial);
      await expect(journal.close()).rejects.toThrow(/JOURNAL_STORAGE_UNCERTAIN/);
      await expect(journal.close()).rejects.toThrow(/JOURNAL_STORAGE_UNCERTAIN/);
      expect(fs.existsSync(`${filePath}.lock`)).toBe(false);
      expect(() => open()).toThrow(/JOURNAL_TRUNCATED/);
      expect(bytes()).toEqual(partial);
    },
  );

  it('rejects fsync after complete bytes, poisons all APIs, and requires explicit validated reopen', async () => {
    let armed = false;
    let syncCalls = 0;
    const journal = open(
      proxyFs({
        fsyncSync: (fd) => {
          syncCalls++;
          if (armed && fs.fstatSync(fd).isFile()) throw new Error('injected fsync failure');
          fs.fsyncSync(fd);
        },
      }),
    );
    armed = true;
    const entry = input({ clientOrderId: 'CID-A' });
    await expect(journal.append(entry)).rejects.toThrow(/JOURNAL_STORAGE_UNCERTAIN/);
    const complete = bytes();
    expect(rows()).toEqual([{ ...entry, schemaVersion: 1, version: 1, sequence: 1 }]);
    const failedCalls = syncCalls;
    await expectPoisoned(journal);
    expect(syncCalls).toBe(failedCalls);
    expect(bytes()).toEqual(complete);
    await expect(journal.close()).rejects.toThrow(/JOURNAL_STORAGE_UNCERTAIN/);
    expect(fs.existsSync(`${filePath}.lock`)).toBe(false);
    let replaySynced = false;
    const restarted = open(
      proxyFs({
        fsyncSync: (fd) => {
          if (fs.fstatSync(fd).isFile() && fs.fstatSync(fd).ino === fs.statSync(filePath).ino)
            replaySynced = true;
          fs.fsyncSync(fd);
        },
      }),
    );
    expect(replaySynced).toBe(true);
    expect(await restarted.readLatest('op-A')).toMatchObject({
      event: 'PREPARED',
      version: 1,
      sequence: 1,
    });
    // A negative submission lookup does not resolve an ambiguous persisted PREPARED request.
    expect(await restarted.isSubmitted('CID-A')).toBe(false);
    expect(await restarted.listNonTerminal()).toEqual(['op-A']);
    expect(await restarted.append(entry)).toMatchObject({ version: 1, sequence: 1 });
    expect(bytes()).toEqual(complete);
    expect(await restarted.append(input({ operationId: 'op-B' }))).toMatchObject({
      version: 1,
      sequence: 2,
    });
  });

  it('poisons a flush I/O failure as well as an append failure', async () => {
    let armed = false;
    const journal = open(
      proxyFs({
        fsyncSync: (fd) => {
          if (armed) throw new Error('injected flush failure');
          fs.fsyncSync(fd);
        },
      }),
    );
    await journal.append(input());
    const before = bytes();
    armed = true;
    await expect(journal.flush()).rejects.toThrow(/JOURNAL_STORAGE_UNCERTAIN/);
    await expectPoisoned(journal);
    expect(bytes()).toEqual(before);
    await expect(journal.close()).rejects.toThrow(/JOURNAL_STORAGE_UNCERTAIN/);
  });

  it('rejects constructor directory fsync failure before accepting entries', () => {
    let failed = false;
    expect(() =>
      open(
        proxyFs({
          fsyncSync: (fd) => {
            if (fs.fstatSync(fd).isDirectory()) {
              failed = true;
              throw new Error('injected directory fsync failure');
            }
            fs.fsyncSync(fd);
          },
        }),
      ),
    ).toThrow();
    expect(failed).toBe(true);
  });

  it('does not accept complete replay bytes until the reopened data descriptor is synced', async () => {
    const journal = open();
    await journal.append(input());
    await journal.close();
    const before = bytes();
    const inode = fs.statSync(filePath).ino;
    let failed = false;
    expect(() =>
      open(
        proxyFs({
          fsyncSync: (fd) => {
            const stat = fs.fstatSync(fd);
            if (stat.isFile() && stat.ino === inode) {
              failed = true;
              throw new Error('injected replay fsync failure');
            }
            fs.fsyncSync(fd);
          },
        }),
      ),
    ).toThrow();
    expect(failed).toBe(true);
    expect(bytes()).toEqual(before);
    expect(fs.existsSync(`${filePath}.lock`)).toBe(false);
    expect(await open().readLatest('op-A')).toMatchObject({ version: 1, sequence: 1 });
  });

  it('retains the writer lock conservatively if closing the data descriptor fails', async () => {
    let armed = false;
    let dataFd = -1;
    const journal = open(
      proxyFs({
        openSync: ((target: fs.PathLike, flags: string | number, mode?: fs.Mode) => {
          const fd = fs.openSync(target, flags, mode);
          if (String(target) === filePath) {
            dataFd = fd;
            retainedFds.add(fd);
          }
          return fd;
        }) as typeof fs.openSync,
        closeSync: (fd) => {
          if (armed && fd === dataFd) throw new Error('injected close failure');
          fs.closeSync(fd);
          retainedFds.delete(fd);
        },
      }),
    );
    await journal.append(input());
    armed = true;
    await expect(journal.close()).rejects.toThrow(/JOURNAL_STORAGE_UNCERTAIN/);
    const lock = fs.readFileSync(`${filePath}.lock`);
    await expect(journal.close()).rejects.toThrow(/JOURNAL_STORAGE_UNCERTAIN/);
    expect(fs.readFileSync(`${filePath}.lock`)).toEqual(lock);
    expect(() => open()).toThrow(/JOURNAL_WRITER_LOCKED/);
    await expectPoisoned(journal);
  });
});

// The child loads only the journal module, never the application, dotenv or exchange adapters.
const childScript = `
  const { FileBackedExecutionJournal } = require(process.argv[1]);
  let journal;
  process.on('message', async (message) => {
    if (message !== 'close' || !journal) return;
    try {
      await journal.close();
      process.send({ type: 'closed' }, () => process.disconnect());
    } catch (error) {
      process.send({ type: 'error', message: String(error) }, () => process.disconnect());
    }
  });
  try {
    journal = new FileBackedExecutionJournal(process.argv[2]);
    process.send({ type: 'ready' });
  } catch (error) {
    process.send({ type: 'error', message: String(error) }, () => process.disconnect());
  }
`;

function childWriter(): {
  process: ChildProcess;
  exited: Promise<void>;
  message: Promise<{ type: string; message?: string }>;
} {
  const child = spawn(
    process.execPath,
    [
      '-r',
      'ts-node/register/transpile-only',
      '-e',
      childScript,
      path.resolve('src/core/risk/ExecutionJournal.ts'),
      filePath,
    ],
    {
      cwd: process.cwd(),
      // Do not inherit credentials, dotenv preload hooks or runtime configuration.
      env: {
        PATH: process.env.PATH,
        TS_NODE_COMPILER_OPTIONS: JSON.stringify({ module: 'CommonJS', moduleResolution: 'Node' }),
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    },
  );
  const exited = new Promise<void>((resolve) => {
    child.once('close', () => resolve());
  });
  children.push({ process: child, exited });
  child.stderr?.resume();
  const message = new Promise<{ type: string; message?: string }>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Journal child handshake timed out'));
    }, 10000);
    const onMessage = (value: { type: string; message?: string }): void => {
      cleanup();
      resolve(value);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onExit = (): void => {
      cleanup();
      reject(new Error('Journal child exited before handshake'));
    };
    function cleanup(): void {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('error', onError);
      child.off('exit', onExit);
    }
    child.once('message', onMessage);
    child.once('error', onError);
    child.once('exit', onExit);
  });
  return { process: child, exited, message };
}

describe('cooperative writers on the same local filesystem', () => {
  it('excludes a real second process and permits opening after graceful owner exit', async () => {
    const owner = childWriter();
    expect(await owner.message).toEqual({ type: 'ready' });
    const contender = childWriter();
    expect(await contender.message).toMatchObject({
      type: 'error',
      message: expect.stringMatching(/JOURNAL_WRITER_LOCKED/),
    });
    await contender.exited;
    expect(() => open()).toThrow(/JOURNAL_WRITER_LOCKED/);
    owner.process.send('close');
    await owner.exited;
    expect(owner.process.exitCode).toBe(0);
    expect(fs.existsSync(`${filePath}.lock`)).toBe(false);
    await open().append(input());
  }, 30000);

  it('does not take over an orphan lock after its own journal-only child crashes', async () => {
    const owner = childWriter();
    expect(await owner.message).toEqual({ type: 'ready' });
    const lock = fs.readFileSync(`${filePath}.lock`);
    expect(owner.process.kill('SIGKILL')).toBe(true);
    await owner.exited;
    expect(owner.process.signalCode).toBe('SIGKILL');
    const contender = childWriter();
    expect(await contender.message).toMatchObject({
      type: 'error',
      message: expect.stringMatching(/JOURNAL_WRITER_LOCKED/),
    });
    await contender.exited;
    expect(() => open()).toThrow(/JOURNAL_WRITER_LOCKED/);
    expect(fs.readFileSync(`${filePath}.lock`)).toEqual(lock);
  }, 30000);
});
