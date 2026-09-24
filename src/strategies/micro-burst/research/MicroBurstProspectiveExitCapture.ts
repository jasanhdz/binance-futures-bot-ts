import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  MicroBurstProspectiveExitObserver,
  ProspectiveExitEntrySnapshot,
  ProspectiveExitIdentity,
  ProspectiveExitObservation,
  ProspectiveRealFill,
} from './MicroBurstProspectiveExitObserver';

export const PROSPECTIVE_EXIT_JOURNAL_FORMAT_VERSION = 1 as const;

export interface ProspectiveExitSnapshotStore {
  save(snapshot: ProspectiveExitEntrySnapshot): Promise<boolean>;
  load(): Promise<readonly ProspectiveExitEntrySnapshot[]>;
  drain(timeoutMs?: number): Promise<boolean>;
  getHealth(): {
    healthy: boolean;
    malformedRecords: number;
    truncatedRecords: number;
    writeFailures: number;
    pendingWrites: number;
    readFailures: number;
    incompatibleRecords: number;
    fileMissing: boolean;
    appendBlocked: boolean;
  };
}

/** Bounded JSONL store for research capture. It is never used by LIVE runtime. */
export class MicroBurstProspectiveExitJsonlStore implements ProspectiveExitSnapshotStore {
  private malformedRecords = 0;
  private truncatedRecords = 0;
  private writeFailures = 0;
  private readFailures = 0;
  private incompatibleRecords = 0;
  private fileMissing = false;
  private appendBlocked = false;
  private pendingWrites = 0;
  private writeTail = Promise.resolve();
  private readonly persistedObservationCounts = new Map<string, number>();

  public constructor(
    private readonly filePath: string,
    private readonly maxBytes = 64 * 1024 * 1024,
    private readonly maxPendingWrites = 1024,
  ) {}

  public save(snapshot: ProspectiveExitEntrySnapshot): Promise<boolean> {
    if (!validSnapshotShape(snapshot)) {
      this.writeFailures++;
      return Promise.resolve(false);
    }
    if (this.pendingWrites >= this.maxPendingWrites) {
      this.writeFailures++;
      return Promise.resolve(false);
    }
    this.pendingWrites++;
    const operation = this.writeTail.then(async () => {
      try {
        const existing = await this.readExistingForAppend();
        if (existing === null) {
          this.writeFailures++;
          return false;
        }
        const previousObservationCount =
          this.persistedObservationCounts.get(snapshot.identity.entryId) ?? 0;
        const record = {
          formatVersion: PROSPECTIVE_EXIT_JOURNAL_FORMAT_VERSION,
          recordType: 'EPISODE_SNAPSHOT' as const,
          snapshot: { ...snapshot, observations: [] },
          observations: snapshot.observations.slice(previousObservationCount),
        };
        const line = `${JSON.stringify(record)}\n`;
        if (Buffer.byteLength(existing, 'utf8') + Buffer.byteLength(line, 'utf8') > this.maxBytes) {
          this.writeFailures++;
          return false;
        }
        await mkdir(dirname(this.filePath), { recursive: true });
        const handle = await open(this.filePath, 'a');
        try {
          await handle.write(line, undefined, 'utf8');
          await handle.datasync();
        } finally {
          await handle.close();
        }
        this.fileMissing = false;
        this.persistedObservationCounts.set(
          snapshot.identity.entryId,
          snapshot.observations.length,
        );
        return true;
      } catch {
        this.writeFailures++;
        return false;
      }
    });
    this.writeTail = operation.then(
      () => undefined,
      () => undefined,
    );
    void operation.finally(() => this.pendingWrites--);
    return operation;
  }

  public async load(): Promise<readonly ProspectiveExitEntrySnapshot[]> {
    this.malformedRecords = 0;
    this.truncatedRecords = 0;
    this.incompatibleRecords = 0;
    let content: string;
    try {
      content = await readFile(this.filePath, 'utf8');
      this.fileMissing = false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.fileMissing = true;
        return [];
      }
      this.readFailures++;
      this.appendBlocked = true;
      return [];
    }
    const latest = new Map<string, ProspectiveExitEntrySnapshot>();
    const lines = content.split('\n');
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
        const snapshot = this.snapshotFromJournalRecord(parsed, latest);
        if (!snapshot) throw new Error('SNAPSHOT_SCHEMA_INVALID');
        latest.set(snapshot.identity.entryId, snapshot);
      } catch {
        if (this.isIncompatibleJournalRecord(parsed)) this.incompatibleRecords++;
        else this.malformedRecords++;
        this.appendBlocked = true;
        if (index === lines.length - 1 && !content.endsWith('\n')) this.truncatedRecords++;
      }
    }
    for (const snapshot of latest.values())
      this.persistedObservationCounts.set(snapshot.identity.entryId, snapshot.observations.length);
    return [...latest.values()];
  }

  public async drain(timeoutMs = 5_000): Promise<boolean> {
    return Promise.race([
      this.writeTail.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
    ]);
  }

  public getHealth(): {
    healthy: boolean;
    malformedRecords: number;
    truncatedRecords: number;
    writeFailures: number;
    pendingWrites: number;
    readFailures: number;
    incompatibleRecords: number;
    fileMissing: boolean;
    appendBlocked: boolean;
  } {
    return {
      healthy:
        !this.fileMissing &&
        this.malformedRecords === 0 &&
        this.truncatedRecords === 0 &&
        this.writeFailures === 0 &&
        this.readFailures === 0 &&
        this.incompatibleRecords === 0 &&
        !this.appendBlocked,
      malformedRecords: this.malformedRecords,
      truncatedRecords: this.truncatedRecords,
      writeFailures: this.writeFailures,
      pendingWrites: this.pendingWrites,
      readFailures: this.readFailures,
      incompatibleRecords: this.incompatibleRecords,
      fileMissing: this.fileMissing,
      appendBlocked: this.appendBlocked,
    };
  }

  private async readExistingForAppend(): Promise<string | null> {
    if (this.appendBlocked) return null;
    try {
      const content = await readFile(this.filePath, 'utf8');
      this.fileMissing = false;
      if (content.length > 0 && !content.endsWith('\n')) {
        this.truncatedRecords++;
        this.appendBlocked = true;
        return null;
      }
      const latest = new Map<string, ProspectiveExitEntrySnapshot>();
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line) as unknown;
          const snapshot = this.snapshotFromJournalRecord(parsed, latest);
          if (!snapshot) throw new Error('SNAPSHOT_SCHEMA_INVALID');
          latest.set(snapshot.identity.entryId, snapshot);
        } catch {
          if (this.isIncompatibleJournalRecord(parsed)) this.incompatibleRecords++;
          else this.malformedRecords++;
          this.appendBlocked = true;
          return null;
        }
      }
      for (const snapshot of latest.values())
        this.persistedObservationCounts.set(
          snapshot.identity.entryId,
          snapshot.observations.length,
        );
      return content;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.fileMissing = true;
        return '';
      }
      this.readFailures++;
      this.appendBlocked = true;
      return null;
    }
  }

  private snapshotFromJournalRecord(
    value: unknown,
    latest: Map<string, ProspectiveExitEntrySnapshot>,
  ): ProspectiveExitEntrySnapshot | null {
    if (!value || typeof value !== 'object') return null;
    const record = value as {
      formatVersion?: unknown;
      recordType?: unknown;
      snapshot?: unknown;
      observations?: unknown;
    };
    if (
      record.formatVersion !== PROSPECTIVE_EXIT_JOURNAL_FORMAT_VERSION ||
      record.recordType !== 'EPISODE_SNAPSHOT' ||
      !validSnapshotShape(record.snapshot)
    )
      return null;
    if (
      !Array.isArray(record.observations) ||
      !record.observations.every((observation) => {
        return (
          typeof observation === 'object' &&
          observation !== null &&
          Number.isFinite((observation as ProspectiveExitObservation).eventAtMs)
        );
      })
    )
      return null;
    const snapshot = record.snapshot;
    const previous = latest.get(snapshot.identity.entryId);
    const observations = [...(previous?.observations ?? []), ...record.observations];
    if (observations.length > 512) return null;
    return { ...snapshot, observations };
  }

  private isIncompatibleJournalRecord(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    const record = value as { formatVersion?: unknown; recordType?: unknown };
    return (
      record.formatVersion !== undefined ||
      record.recordType !== undefined ||
      validSnapshotShape(value)
    );
  }
}

function validSnapshotShape(value: unknown): value is ProspectiveExitEntrySnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<ProspectiveExitEntrySnapshot>;
  const identity = snapshot.identity as Partial<ProspectiveExitIdentity> | undefined;
  const simulations = snapshot.simulations as
    | ProspectiveExitEntrySnapshot['simulations']
    | undefined;
  return Boolean(
    identity &&
      typeof identity.entryId === 'string' &&
      identity.entryId.length > 0 &&
      typeof identity.symbol === 'string' &&
      typeof identity.side === 'string' &&
      typeof identity.quantity === 'number' &&
      Number.isFinite(identity.quantity) &&
      identity.quantity > 0 &&
      typeof identity.entryPrice === 'number' &&
      Number.isFinite(identity.entryPrice) &&
      identity.entryPrice > 0 &&
      simulations?.CURRENT &&
      simulations.CANDIDATE &&
      Array.isArray(simulations.CURRENT.decisions) &&
      Array.isArray(simulations.CANDIDATE.decisions) &&
      typeof simulations.CURRENT.resultEvaluable === 'boolean' &&
      typeof simulations.CANDIDATE.resultEvaluable === 'boolean' &&
      Array.isArray(snapshot.realFills) &&
      Array.isArray(snapshot.observations) &&
      typeof snapshot.completed === 'boolean',
  );
}

export interface ProspectiveExitCaptureMetrics {
  persistenceFailures: number;
  rejectedEntries: number;
  rejectedObservations: number;
  rejectedFills: number;
  rejectedClosures: number;
}

export interface MicroBurstProspectiveExitCaptureOptions {
  enabled?: boolean;
}

/**
 * Integration boundary for reconciled execution and already-consumed market data.
 * It deliberately has no order, exchange, logger, or REST dependency.
 */
export class MicroBurstProspectiveExitCapture {
  private metrics: ProspectiveExitCaptureMetrics = {
    persistenceFailures: 0,
    rejectedEntries: 0,
    rejectedObservations: 0,
    rejectedFills: 0,
    rejectedClosures: 0,
  };

  public constructor(
    private readonly observer: MicroBurstProspectiveExitObserver,
    private readonly store?: ProspectiveExitSnapshotStore,
    private readonly options: MicroBurstProspectiveExitCaptureOptions = {},
  ) {}

  /** Called by an execution reconciler, not by an order-intent producer. */
  public async onExecutedEntry(
    identity: ProspectiveExitIdentity,
    fills: readonly ProspectiveRealFill[] = [],
  ): Promise<boolean> {
    if (this.options.enabled !== true) return false;
    try {
      if (!this.observer.registerEntry(identity)) {
        this.metrics = { ...this.metrics, rejectedEntries: this.metrics.rejectedEntries + 1 };
        return false;
      }
      let fillsAccepted = true;
      for (const fill of fills) {
        if (!this.observer.recordRealFill(identity.entryId, fill)) {
          fillsAccepted = false;
          this.recordFillRejection();
        }
      }
      const persisted = await this.persist(identity.entryId);
      return fillsAccepted && persisted;
    } catch {
      this.metrics = { ...this.metrics, rejectedEntries: this.metrics.rejectedEntries + 1 };
      return false;
    }
  }

  public async onRealFill(entryId: string, fill: ProspectiveRealFill): Promise<boolean> {
    if (this.options.enabled !== true) return false;
    try {
      const accepted = this.observer.recordRealFill(entryId, fill);
      if (!accepted) this.recordFillRejection();
      return accepted && (await this.persist(entryId));
    } catch {
      this.recordFillRejection();
      return false;
    }
  }

  public async onRealPositionClosed(entryId: string, closedAtMs: number): Promise<boolean> {
    if (this.options.enabled !== true) return false;
    try {
      const accepted = this.observer.markRealPositionClosed(entryId, closedAtMs);
      if (!accepted) {
        this.metrics = { ...this.metrics, rejectedClosures: this.metrics.rejectedClosures + 1 };
        return false;
      }
      return await this.persist(entryId);
    } catch {
      this.metrics = { ...this.metrics, rejectedClosures: this.metrics.rejectedClosures + 1 };
      return false;
    }
  }

  /** Feed the exact snapshot already consumed by the market-data path. */
  public async onObservation(
    entryId: string,
    observation: ProspectiveExitObservation,
  ): Promise<boolean> {
    if (this.options.enabled !== true) return false;
    try {
      const accepted = this.observer.observe(entryId, observation);
      if (!accepted) {
        this.metrics = {
          ...this.metrics,
          rejectedObservations: this.metrics.rejectedObservations + 1,
        };
        return false;
      }
      return await this.persist(entryId);
    } catch {
      this.metrics = {
        ...this.metrics,
        rejectedObservations: this.metrics.rejectedObservations + 1,
      };
      return false;
    }
  }

  /** Restore latest snapshots after restart; corrupt rows are isolated by the store. */
  public async restore(): Promise<number> {
    if (this.options.enabled !== true || !this.store) return 0;
    let restored = 0;
    for (const snapshot of await this.store.load()) {
      try {
        if (this.observer.restoreEntry(snapshot)) restored++;
        else if (this.observer.getEntry(snapshot.identity?.entryId ?? '') === null) {
          this.metrics = { ...this.metrics, rejectedEntries: this.metrics.rejectedEntries + 1 };
        }
      } catch {
        this.metrics = { ...this.metrics, rejectedEntries: this.metrics.rejectedEntries + 1 };
      }
    }
    return restored;
  }

  public async drain(timeoutMs = 5_000): Promise<boolean> {
    return this.store?.drain(timeoutMs) ?? true;
  }

  public getMetrics(): ProspectiveExitCaptureMetrics {
    return { ...this.metrics };
  }

  public getHealth(): {
    metrics: ProspectiveExitCaptureMetrics;
    store: ReturnType<ProspectiveExitSnapshotStore['getHealth']> | null;
  } {
    return { metrics: this.getMetrics(), store: this.store?.getHealth() ?? null };
  }

  public getEntry(entryId: string): ProspectiveExitEntrySnapshot | null {
    return this.observer.getEntry(entryId);
  }

  private async persist(entryId: string): Promise<boolean> {
    if (!this.store) return true;
    const snapshot = this.observer.getEntry(entryId);
    if (!snapshot || (await this.store.save(snapshot))) return Boolean(snapshot);
    this.metrics = { ...this.metrics, persistenceFailures: this.metrics.persistenceFailures + 1 };
    return false;
  }

  private recordFillRejection(): void {
    this.metrics = { ...this.metrics, rejectedFills: this.metrics.rejectedFills + 1 };
  }
}
