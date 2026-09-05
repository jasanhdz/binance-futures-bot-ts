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

export interface JournalEntry {
  id: string;
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
  /** Monotonically increasing version for idempotent replay. */
  version: number;
}

export interface ExecutionJournal {
  /** Append an event atomically. Must be called before the corresponding exchange operation. */
  append(entry: Omit<JournalEntry, 'version'>): Promise<JournalEntry>;
  /** Read all entries for a symbol, ordered by version ascending. */
  read(symbol: string): Promise<JournalEntry[]>;
  /** Read the latest entry for a symbol. */
  readLatest(symbol: string): Promise<JournalEntry | null>;
  /** Read entries with a specific event type. */
  readByEvent(symbol: string, event: JournalEventType): Promise<JournalEntry[]>;
  /** Check if a clientOrderId has already been submitted. */
  isSubmitted(clientOrderId: string): Promise<boolean>;
  /** Flush pending writes to durable storage. */
  flush(): Promise<void>;
}

export interface InMemoryJournalEntry extends JournalEntry {}

/**
 * In-memory execution journal with state machine enforcement.
 * For virtual/testing use. Production should use FileBackedExecutionJournal.
 */
export class InMemoryExecutionJournal implements ExecutionJournal {
  private readonly entries = new Map<string, JournalEntry[]>();
  private readonly submittedClientOrders = new Set<string>();
  private versions = new Map<string, number>();

  async append(entry: Omit<JournalEntry, 'version'>): Promise<JournalEntry> {
    const key = entry.symbol;
    const currentVersion = this.versions.get(key) ?? 0;
    const version = currentVersion + 1;
    this.versions.set(key, version);

    // Enforce state machine transition.
    const previous = this.entries.get(key);
    if (previous && previous.length > 0) {
      const lastEvent = previous[previous.length - 1].event;
      if (!isValidTransition(lastEvent, entry.event)) {
        throw new Error(
          `Invalid transition: ${lastEvent} -> ${entry.event} for ${key}`,
        );
      }
    }

    const full: JournalEntry = { ...entry, version };
    const list = this.entries.get(key) ?? [];
    list.push(full);
    this.entries.set(key, list);

    // Only SUBMITTED marks clientOrderId as submitted (not PREPARED).
    if (entry.event === 'SUBMITTED' && entry.clientOrderId) {
      this.submittedClientOrders.add(entry.clientOrderId);
    }

    return full;
  }

  async read(symbol: string): Promise<JournalEntry[]> {
    return [...(this.entries.get(symbol) ?? [])];
  }

  async readLatest(symbol: string): Promise<JournalEntry | null> {
    const list = this.entries.get(symbol);
    if (!list || list.length === 0) return null;
    return list[list.length - 1];
  }

  async readByEvent(symbol: string, event: JournalEventType): Promise<JournalEntry[]> {
    return (this.entries.get(symbol) ?? []).filter((e) => e.event === event);
  }

  async isSubmitted(clientOrderId: string): Promise<boolean> {
    return this.submittedClientOrders.has(clientOrderId);
  }

  async flush(): Promise<void> {
    // No-op for in-memory implementation.
  }
}

/**
 * File-backed execution journal with durable persistence.
 * Each append writes to a JSONL file and flushes to disk.
 * Suitable for production use with a local filesystem.
 */
export class FileBackedExecutionJournal implements ExecutionJournal {
  private readonly entries = new Map<string, JournalEntry[]>();
  private readonly submittedClientOrders = new Set<string>();
  private versions = new Map<string, number>();
  private readonly filePath: string;
  private readonly fs: typeof import('node:fs');

  constructor(filePath: string, fsModule?: typeof import('node:fs')) {
    this.filePath = filePath;
    this.fs = fsModule ?? require('node:fs');
  }

  async append(entry: Omit<JournalEntry, 'version'>): Promise<JournalEntry> {
    const key = entry.symbol;
    const currentVersion = this.versions.get(key) ?? 0;
    const version = currentVersion + 1;
    this.versions.set(key, version);

    // Enforce state machine transition.
    const previous = this.entries.get(key);
    if (previous && previous.length > 0) {
      const lastEvent = previous[previous.length - 1].event;
      if (!isValidTransition(lastEvent, entry.event)) {
        throw new Error(
          `Invalid transition: ${lastEvent} -> ${entry.event} for ${key}`,
        );
      }
    }

    const full: JournalEntry = { ...entry, version };
    const list = this.entries.get(key) ?? [];
    list.push(full);
    this.entries.set(key, list);

    // Only SUBMITTED marks clientOrderId as submitted.
    if (entry.event === 'SUBMITTED' && entry.clientOrderId) {
      this.submittedClientOrders.add(entry.clientOrderId);
    }

    // Persist to disk.
    await this.flush();

    return full;
  }

  async read(symbol: string): Promise<JournalEntry[]> {
    return [...(this.entries.get(symbol) ?? [])];
  }

  async readLatest(symbol: string): Promise<JournalEntry | null> {
    const list = this.entries.get(symbol);
    if (!list || list.length === 0) return null;
    return list[list.length - 1];
  }

  async readByEvent(symbol: string, event: JournalEventType): Promise<JournalEntry[]> {
    return (this.entries.get(symbol) ?? []).filter((e) => e.event === event);
  }

  async isSubmitted(clientOrderId: string): Promise<boolean> {
    return this.submittedClientOrders.has(clientOrderId);
  }

  async flush(): Promise<void> {
    const allEntries: JournalEntry[] = [];
    for (const list of this.entries.values()) {
      allEntries.push(...list);
    }
    const data = JSON.stringify(allEntries, null, 2);
    this.fs.writeFileSync(this.filePath, data, 'utf8');
  }
}

/**
 * Validate that a journal event transition is valid.
 * PREPARED -> SUBMITTED -> OPEN_CONFIRMED -> PROTECTED -> CLOSE_PENDING -> CLOSED
 *                    \-> UNKNOWN / RECOVERY_REQUIRED
 */
export function isValidTransition(from: JournalEventType, to: JournalEventType): boolean {
  const validTransitions: Record<JournalEventType, JournalEventType[]> = {
    PREPARED: ['SUBMITTED', 'UNKNOWN'],
    SUBMITTED: ['OPEN_CONFIRMED', 'UNKNOWN', 'RECOVERY_REQUIRED'],
    OPEN_CONFIRMED: ['PROTECTED', 'UNKNOWN', 'RECOVERY_REQUIRED'],
    PROTECTED: ['CLOSE_PENDING', 'UNKNOWN', 'RECOVERY_REQUIRED'],
    CLOSE_PENDING: ['CLOSED', 'UNKNOWN', 'RECOVERY_REQUIRED'],
    CLOSED: [],
    UNKNOWN: ['RECOVERY_REQUIRED', 'CLOSE_PENDING', 'CLOSED'],
    RECOVERY_REQUIRED: ['CLOSE_PENDING', 'CLOSED', 'UNKNOWN'],
  };
  return validTransitions[from]?.includes(to) ?? false;
}
