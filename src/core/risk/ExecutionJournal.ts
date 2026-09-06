import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { Side } from '../../core/types';

export type JournalEventType =
  | 'PREPARED'
  | 'SUBMITTED'
  | 'OPEN_CONFIRMED'
  | 'PROTECTED'
  | 'CLOSE_PENDING'
  | 'CLOSED'
  | 'UNKNOWN'
  | 'RECOVERY_REQUIRED';

export interface OperationScope {
  account: string;
  environment: string;
}

export interface JournalEntry {
  schemaVersion: 1;
  /** Globally unique event identity within this journal. */
  id: string;
  /** Never reused, even after CLOSED; scope/symbol/side/strategy remain immutable. */
  operationId: string;
  scope: OperationScope;
  symbol: string;
  side: Side;
  strategyId: string;
  event: JournalEventType;
  timestampMs: number;
  clientOrderId?: string;
  orderId?: string;
  stopPrice?: number;
  entryPrice?: number;
  quantity?: number;
  leverage?: number;
  reason?: string;
  metadata?: Record<string, unknown>;
  version: number;
  sequence: number;
}

export type JournalInput = Omit<JournalEntry, 'schemaVersion' | 'version' | 'sequence'>;
export interface InMemoryJournalEntry extends JournalEntry {}

export interface ExecutionJournal {
  append(entry: JournalInput): Promise<JournalEntry>;
  read(operationId: string): Promise<JournalEntry[]>;
  readLatest(operationId: string): Promise<JournalEntry | null>;
  readByEvent(operationId: string, event: JournalEventType): Promise<JournalEntry[]>;
  listNonTerminal(): Promise<string[]>;
  /** Read-only inventory, including terminal mutations, for protocol/scope validation. */
  listOperations(): Promise<string[]>;
  /** Historical ACK index only. False NEVER authorizes sending a PREPARED request. */
  isSubmitted(clientOrderId: string): Promise<boolean>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

// Transitions describe caller-supplied evidence, not permission to invoke an exchange.
// In particular, an emergency close need not manufacture a PROTECTED event first.
const VALID_TRANSITIONS: Record<JournalEventType, readonly JournalEventType[]> = {
  PREPARED: ['SUBMITTED', 'UNKNOWN', 'RECOVERY_REQUIRED', 'CLOSE_PENDING'],
  SUBMITTED: ['OPEN_CONFIRMED', 'UNKNOWN', 'RECOVERY_REQUIRED', 'CLOSE_PENDING'],
  OPEN_CONFIRMED: ['PROTECTED', 'UNKNOWN', 'RECOVERY_REQUIRED', 'CLOSE_PENDING'],
  PROTECTED: ['CLOSE_PENDING', 'UNKNOWN', 'RECOVERY_REQUIRED'],
  CLOSE_PENDING: ['CLOSED', 'UNKNOWN', 'RECOVERY_REQUIRED'],
  CLOSED: [],
  UNKNOWN: ['RECOVERY_REQUIRED', 'CLOSE_PENDING', 'CLOSED', 'OPEN_CONFIRMED', 'PROTECTED'],
  RECOVERY_REQUIRED: ['CLOSE_PENDING', 'CLOSED', 'UNKNOWN', 'OPEN_CONFIRMED', 'PROTECTED'],
};

export function isValidTransition(from: JournalEventType, to: JournalEventType): boolean {
  return (
    Object.prototype.hasOwnProperty.call(VALID_TRANSITIONS, from) &&
    VALID_TRANSITIONS[from].includes(to)
  );
}

const INPUT_KEYS = new Set([
  'id',
  'operationId',
  'scope',
  'symbol',
  'side',
  'strategyId',
  'event',
  'timestampMs',
  'clientOrderId',
  'orderId',
  'stopPrice',
  'entryPrice',
  'quantity',
  'leverage',
  'reason',
  'metadata',
]);
const REQUEST_FIELDS = ['quantity', 'stopPrice', 'entryPrice', 'leverage', 'orderId'] as const;

function invalid(reason: string): never {
  throw new Error(`ENTRY_INVALID:${reason}`);
}

function identifier(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.trim() !== value ||
    /[\x00-\x1f\x7f]/.test(value)
  ) {
    invalid('IDENTIFIER');
  }
}

function record(value: unknown): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    invalid('OBJECT');
}

/** Canonical JSON without lossy coercions, getters, prototypes or shared references. */
function jsonCopy(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value === 0 ? 0 : value;
  if (!value || typeof value !== 'object') invalid('NON_JSON_VALUE');
  if (ancestors.has(value)) invalid('CYCLIC_VALUE');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Reflect.ownKeys(value).length !== value.length + 1) invalid('ARRAY_PROPERTIES');
      return Array.from({ length: value.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !('value' in descriptor)) invalid('ARRAY_VALUE');
        return jsonCopy(descriptor.value, ancestors);
      });
    }
    record(value);
    if (Object.getOwnPropertySymbols(value).length) invalid('SYMBOL_KEY');
    return Object.fromEntries(
      Object.getOwnPropertyNames(value)
        .sort()
        .map((key) => {
          const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
          if (!descriptor.enumerable || !('value' in descriptor)) invalid('PROPERTY_DESCRIPTOR');
          return [key, jsonCopy(descriptor.value, ancestors)];
        }),
    );
  } finally {
    ancestors.delete(value);
  }
}

function normalize(input: JournalInput): JournalInput {
  record(input);
  if (Object.getOwnPropertySymbols(input).length) invalid('SYMBOL_KEY');
  const pairs: [string, unknown][] = [];
  for (const key of Object.getOwnPropertyNames(input)) {
    if (!INPUT_KEYS.has(key)) invalid(`UNKNOWN_FIELD:${key}`);
    const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
    if (!descriptor.enumerable || !('value' in descriptor)) invalid('PROPERTY_DESCRIPTOR');
    if (descriptor.value !== undefined) pairs.push([key, descriptor.value]);
  }
  const value = jsonCopy(Object.fromEntries(pairs)) as JournalInput;
  for (const id of [value.id, value.operationId, value.symbol, value.strategyId]) identifier(id);
  record(value.scope);
  if (Object.keys(value.scope).some((key) => key !== 'account' && key !== 'environment'))
    invalid('SCOPE');
  identifier(value.scope.account);
  identifier(value.scope.environment);
  if (value.side !== 'LONG' && value.side !== 'SHORT') invalid('SIDE');
  if (!Object.prototype.hasOwnProperty.call(VALID_TRANSITIONS, value.event)) invalid('EVENT');
  if (
    !Number.isSafeInteger(value.timestampMs) ||
    value.timestampMs < 0 ||
    value.timestampMs > 253402300799999
  ) {
    invalid('TIMESTAMP');
  }
  for (const key of ['clientOrderId', 'orderId'] as const) {
    if (value[key] !== undefined) identifier(value[key]);
  }
  for (const key of ['quantity', 'stopPrice', 'entryPrice', 'leverage'] as const) {
    if (value[key] !== undefined && (!Number.isFinite(value[key]) || value[key]! <= 0))
      invalid(key);
  }
  if (value.reason !== undefined && typeof value.reason !== 'string') invalid('REASON');
  if (value.metadata !== undefined) record(value.metadata);
  return value;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function operationIdentity(entry: JournalInput): string {
  return JSON.stringify([
    entry.scope.account,
    entry.scope.environment,
    entry.symbol,
    entry.side,
    entry.strategyId,
  ]);
}

/** One validation/index implementation for RAM, durable appends and replay. */
class JournalIndex {
  private readonly operations = new Map<string, JournalEntry[]>();
  private readonly events = new Map<string, JournalEntry>();
  private readonly requests = new Map<string, JournalInput>();
  private readonly submitted = new Set<string>();
  private sequence = 0;

  prepare(input: JournalInput): { entry: JournalEntry; duplicate: boolean } {
    const value = normalize(input);
    const existing = this.events.get(value.id);
    if (existing) {
      const {
        schemaVersion: _schema,
        version: _version,
        sequence: _sequence,
        ...payload
      } = existing;
      if (JSON.stringify(jsonCopy(payload)) !== JSON.stringify(value))
        throw new Error(`ID_CONFLICT:${value.id}`);
      return { entry: existing, duplicate: true };
    }
    const history = this.operations.get(value.operationId);
    if (history) {
      if (operationIdentity(history[0]) !== operationIdentity(value))
        throw new Error('OPERATION_IDENTITY_CONFLICT');
      if (!isValidTransition(history[history.length - 1].event, value.event))
        throw new Error('JOURNAL_TRANSITION_INVALID');
    } else if (value.event !== 'PREPARED') {
      throw new Error('JOURNAL_INITIAL_EVENT_INVALID');
    }
    if (value.clientOrderId) {
      const request = this.requests.get(
        JSON.stringify([value.scope.account, value.scope.environment, value.clientOrderId]),
      );
      if (
        request &&
        (request.operationId !== value.operationId ||
          REQUEST_FIELDS.some(
            (key) =>
              request[key] !== undefined && value[key] !== undefined && request[key] !== value[key],
          ))
      ) {
        throw new Error('CLIENT_ORDER_CONFLICT');
      }
    }
    const version = (history?.length ?? 0) + 1;
    const sequence = this.sequence + 1;
    if (!Number.isSafeInteger(version) || !Number.isSafeInteger(sequence))
      invalid('COUNTER_OVERFLOW');
    return { entry: { ...value, schemaVersion: 1, version, sequence }, duplicate: false };
  }

  publish(entry: JournalEntry): void {
    const history = this.operations.get(entry.operationId) ?? [];
    history.push(entry);
    this.operations.set(entry.operationId, history);
    this.events.set(entry.id, entry);
    this.sequence = entry.sequence;
    if (entry.clientOrderId) {
      const key = JSON.stringify([
        entry.scope.account,
        entry.scope.environment,
        entry.clientOrderId,
      ]);
      this.requests.set(key, { ...this.requests.get(key), ...entry });
      if (entry.event === 'SUBMITTED') this.submitted.add(entry.clientOrderId);
    }
  }

  replay(raw: unknown): void {
    record(raw);
    if (raw.schemaVersion !== 1) throw new Error('JOURNAL_SCHEMA_UNSUPPORTED');
    const { schemaVersion: _schema, version, sequence, ...payload } = raw;
    const candidate = this.prepare(payload as unknown as JournalInput);
    if (candidate.duplicate) throw new Error('JOURNAL_DUPLICATE_RECORD');
    if (sequence !== candidate.entry.sequence) throw new Error('JOURNAL_SEQUENCE_GAP');
    if (version !== candidate.entry.version) throw new Error('JOURNAL_VERSION_GAP');
    this.publish(candidate.entry);
  }

  read(operationId: string): JournalEntry[] {
    return clone(this.operations.get(operationId) ?? []);
  }
  nonTerminal(): string[] {
    return [...this.operations]
      .filter(([, entries]) => entries[entries.length - 1].event !== 'CLOSED')
      .map(([id]) => id);
  }
  operationIds(): string[] {
    return [...this.operations.keys()];
  }
  isSubmitted(clientOrderId: string): boolean {
    return this.submitted.has(clientOrderId);
  }
}

/** Synchronous linearization behind an async API; shares all data rules with disk. */
export class InMemoryExecutionJournal implements ExecutionJournal {
  protected readonly index = new JournalIndex();
  protected closed = false;

  protected assertUsable(): void {
    if (this.closed) throw new Error('JOURNAL_CLOSED');
  }
  protected persist(_entry: JournalEntry): void {}

  async append(input: JournalInput): Promise<JournalEntry> {
    this.assertUsable();
    const candidate = this.index.prepare(input);
    if (!candidate.duplicate) {
      this.persist(candidate.entry);
      this.index.publish(candidate.entry);
    }
    return clone(candidate.entry);
  }

  async read(operationId: string): Promise<JournalEntry[]> {
    this.assertUsable();
    return this.index.read(operationId);
  }
  async readLatest(operationId: string): Promise<JournalEntry | null> {
    this.assertUsable();
    const entries = this.index.read(operationId);
    return entries[entries.length - 1] ?? null;
  }
  async readByEvent(operationId: string, event: JournalEventType): Promise<JournalEntry[]> {
    this.assertUsable();
    return this.index.read(operationId).filter((entry) => entry.event === event);
  }
  async listNonTerminal(): Promise<string[]> {
    this.assertUsable();
    return this.index.nonTerminal();
  }
  async listOperations(): Promise<string[]> {
    this.assertUsable();
    return this.index.operationIds();
  }
  async isSubmitted(clientOrderId: string): Promise<boolean> {
    this.assertUsable();
    return this.index.isSubmitted(clientOrderId);
  }
  async flush(): Promise<void> {
    this.assertUsable();
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

/**
 * Local-filesystem JSONL, schema 1. Requires an existing parent directory.
 * Cooperative processes use an exclusive lock held BEFORE load, with no takeover.
 * A complete write + file fsync precedes publication; new directory entries are
 * synced too. Partial tails and old formats are rejected without changing bytes.
 * Any I/O uncertainty poisons the instance, including reads, until close/reopen.
 * Not multihost fencing, an exchange transaction, or automatic orphan-lock repair.
 */
export class FileBackedExecutionJournal extends InMemoryExecutionJournal {
  private readonly io: typeof fs;
  private readonly filePath: string;
  private readonly lockPath: string;
  private readonly dirPath: string;
  private readonly token = `${process.pid}:${randomUUID()}\n`;
  private lockFd: number | undefined;
  private lockIdentity: fs.Stats | undefined;
  private dataFd: number | undefined;
  private dataIdentity: fs.Stats | undefined;
  private failure: Error | undefined;

  constructor(filePath: string, fsModule: typeof fs = fs) {
    super();
    this.io = fsModule;
    if (typeof filePath !== 'string' || !filePath.trim()) throw new Error('JOURNAL_PATH_INVALID');
    this.dirPath = this.io.realpathSync(path.dirname(path.resolve(filePath)));
    this.filePath = path.join(this.dirPath, path.basename(filePath));
    this.lockPath = `${this.filePath}.lock`;
    try {
      this.lockFd = this.io.openSync(this.lockPath, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new Error('JOURNAL_WRITER_LOCKED');
      throw new Error(`JOURNAL_LOCK_FAILED:${String(error)}`);
    }
    try {
      this.lockIdentity = this.io.fstatSync(this.lockFd);
      this.writeAll(this.lockFd, Buffer.from(this.token));
      this.io.fsyncSync(this.lockFd);
      this.syncDirectory();
      this.assertLock();

      let existing: fs.Stats | undefined;
      try {
        existing = this.io.lstatSync(this.filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (existing && (!existing.isFile() || existing.nlink !== 1))
        throw new Error('JOURNAL_FILE_INVALID');
      const flags =
        this.io.constants.O_RDWR |
        this.io.constants.O_APPEND |
        this.io.constants.O_NOFOLLOW |
        (existing ? 0 : this.io.constants.O_CREAT | this.io.constants.O_EXCL);
      this.dataFd = this.io.openSync(this.filePath, flags, 0o600);
      this.dataIdentity = this.io.fstatSync(this.dataFd);
      this.assertFile();
      // Also stabilizes complete bytes recovered after an earlier uncertain fsync.
      this.io.fsyncSync(this.dataFd);
      if (!existing) this.syncDirectory();
      const bytes = this.io.readFileSync(this.dataFd);
      let raw: string;
      try {
        raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        throw new Error('JOURNAL_CORRUPT_UTF8');
      }
      if (raw.length) {
        if (!raw.endsWith('\n')) throw new Error('JOURNAL_TRUNCATED');
        for (const line of raw.slice(0, -1).split('\n')) {
          let value: unknown;
          try {
            value = JSON.parse(line);
          } catch {
            throw new Error('JOURNAL_CORRUPT_LINE');
          }
          this.index.replay(value);
        }
      }
      this.assertLock();
    } catch (error) {
      this.closed = true;
      this.cleanup();
      throw error;
    }
  }

  private poison(error: unknown): Error {
    this.failure ??= new Error(`JOURNAL_STORAGE_UNCERTAIN:${String(error)}`);
    return this.failure;
  }

  protected override assertUsable(): void {
    if (this.failure) throw this.failure;
    super.assertUsable();
    try {
      this.assertLock();
      this.assertFile();
    } catch (error) {
      throw this.poison(error);
    }
  }

  protected override persist(entry: JournalEntry): void {
    try {
      this.writeAll(this.dataFd!, Buffer.from(JSON.stringify(entry) + '\n', 'utf8'));
      this.io.fsyncSync(this.dataFd!);
      this.assertLock();
      this.assertFile();
    } catch (error) {
      throw this.poison(error);
    }
  }

  override async flush(): Promise<void> {
    this.assertUsable();
    try {
      this.io.fsyncSync(this.dataFd!);
    } catch (error) {
      throw this.poison(error);
    }
  }

  override async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.cleanup();
    }
    if (this.failure) throw this.failure;
  }

  private writeAll(fd: number, bytes: Buffer): void {
    let offset = 0;
    while (offset < bytes.length) {
      const written = this.io.writeSync(fd, bytes, offset, bytes.length - offset, null);
      if (!Number.isSafeInteger(written) || written <= 0 || written > bytes.length - offset) {
        throw new Error('JOURNAL_WRITE_PROGRESS_INVALID');
      }
      offset += written;
    }
  }

  private syncDirectory(): void {
    const fd = this.io.openSync(
      this.dirPath,
      this.io.constants.O_RDONLY | this.io.constants.O_DIRECTORY,
    );
    try {
      this.io.fsyncSync(fd);
    } finally {
      this.io.closeSync(fd);
    }
  }

  private sameFile(expected: fs.Stats | undefined, actual: fs.Stats): boolean {
    return (
      !!expected &&
      actual.isFile() &&
      actual.nlink === 1 &&
      expected.dev === actual.dev &&
      expected.ino === actual.ino
    );
  }

  private assertLock(): void {
    if (
      !this.sameFile(this.lockIdentity, this.io.lstatSync(this.lockPath)) ||
      this.io.readFileSync(this.lockPath, 'utf8') !== this.token
    )
      throw new Error('JOURNAL_LOCK_LOST');
  }

  private assertFile(): void {
    if (
      !this.sameFile(this.dataIdentity, this.io.lstatSync(this.filePath)) ||
      !this.sameFile(this.dataIdentity, this.io.fstatSync(this.dataFd!))
    )
      throw new Error('JOURNAL_FILE_CHANGED');
  }

  /** Never unlink someone else's lock; failed data close leaves an orphan lock. */
  private cleanup(): void {
    let dataClosed = true;
    if (this.dataFd !== undefined) {
      try {
        this.io.closeSync(this.dataFd);
      } catch (error) {
        dataClosed = false;
        this.poison(error);
      }
      this.dataFd = undefined;
    }
    if (this.lockFd !== undefined) {
      try {
        // In constructor failure, the token may still be incomplete: inode ownership remains valid.
        if (!this.sameFile(this.lockIdentity, this.io.lstatSync(this.lockPath)))
          throw new Error('JOURNAL_LOCK_LOST');
        if (dataClosed) {
          if (!this.closed || this.dataIdentity) this.assertLock();
          this.io.unlinkSync(this.lockPath);
          this.syncDirectory();
        }
      } catch (error) {
        this.poison(error);
      }
      try {
        this.io.closeSync(this.lockFd);
      } catch (error) {
        this.poison(error);
      }
      this.lockFd = undefined;
    }
  }
}
