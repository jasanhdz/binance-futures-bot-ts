import { mkdir, open, readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  MicroBurstProspectiveExitObserver,
  ProspectiveExitEntrySnapshot,
  ProspectiveExitIdentity,
  ProspectiveExitObservation,
  ProspectiveRealFill,
  isValidProspectiveExitEntrySnapshot,
} from './MicroBurstProspectiveExitObserver';

export const PROSPECTIVE_EXIT_JOURNAL_FORMAT_VERSION = 1 as const;

export async function writeAllBytes(
  handle: {
    write(
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
    ): Promise<{ bytesWritten: number }>;
  },
  bytes: Buffer,
): Promise<void> {
  let written = 0;
  while (written < bytes.length) {
    const result = await handle.write(bytes, written, bytes.length - written, written);
    if (!Number.isInteger(result.bytesWritten) || result.bytesWritten <= 0)
      throw new Error('JOURNAL_WRITE_NO_PROGRESS');
    written += result.bytesWritten;
  }
}

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
  private readonly persistedDecisionCounts = new Map<string, number>();
  private readonly latestSnapshots = new Map<string, ProspectiveExitEntrySnapshot>();
  private initialized = false;
  private journalBytes = 0;
  private journalMtimeMs = 0;
  private journalExists = false;

  public constructor(
    private readonly filePath: string,
    private readonly maxBytes = 64 * 1024 * 1024,
    private readonly maxPendingWrites = 1024,
  ) {}

  public save(snapshot: ProspectiveExitEntrySnapshot): Promise<boolean> {
    let snapshotCopy: ProspectiveExitEntrySnapshot;
    try {
      snapshotCopy = structuredClone(snapshot);
    } catch {
      this.writeFailures++;
      return Promise.resolve(false);
    }
    if (!isValidProspectiveExitEntrySnapshot(snapshotCopy)) {
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
        const snapshot = snapshotCopy;
        if (!(await this.ensureReadyForAppend())) {
          this.writeFailures++;
          return false;
        }
        const previousObservationCount =
          this.persistedObservationCounts.get(snapshot.identity.entryId) ?? 0;
        const previousCurrentDecisionCount =
          this.persistedDecisionCounts.get(`${snapshot.identity.entryId}:CURRENT`) ?? 0;
        const previousCandidateDecisionCount =
          this.persistedDecisionCounts.get(`${snapshot.identity.entryId}:CANDIDATE`) ?? 0;
        const record = {
          formatVersion: PROSPECTIVE_EXIT_JOURNAL_FORMAT_VERSION,
          recordType: 'EPISODE_SNAPSHOT' as const,
          snapshot: {
            ...snapshot,
            observations: [],
            simulations: {
              CURRENT: { ...snapshot.simulations.CURRENT, decisions: [] },
              CANDIDATE: { ...snapshot.simulations.CANDIDATE, decisions: [] },
            },
          },
          observations: snapshot.observations.slice(previousObservationCount),
          decisions: {
            CURRENT: snapshot.simulations.CURRENT.decisions.slice(previousCurrentDecisionCount),
            CANDIDATE: snapshot.simulations.CANDIDATE.decisions.slice(
              previousCandidateDecisionCount,
            ),
          },
        };
        const line = `${JSON.stringify(record)}\n`;
        if (this.journalBytes + Buffer.byteLength(line, 'utf8') > this.maxBytes) {
          this.writeFailures++;
          return false;
        }
        await mkdir(dirname(this.filePath), { recursive: true });
        const handle = await open(this.filePath, 'a');
        try {
          await writeAllBytes(handle, Buffer.from(line, 'utf8'));
          await handle.datasync();
        } finally {
          await handle.close();
        }
        this.fileMissing = false;
        this.journalBytes += Buffer.byteLength(line, 'utf8');
        this.journalExists = true;
        const fileStats = await stat(this.filePath);
        this.journalMtimeMs = fileStats.mtimeMs;
        this.persistedObservationCounts.set(
          snapshot.identity.entryId,
          snapshot.observations.length,
        );
        this.persistedDecisionCounts.set(
          `${snapshot.identity.entryId}:CURRENT`,
          snapshot.simulations.CURRENT.decisions.length,
        );
        this.persistedDecisionCounts.set(
          `${snapshot.identity.entryId}:CANDIDATE`,
          snapshot.simulations.CANDIDATE.decisions.length,
        );
        this.latestSnapshots.set(snapshot.identity.entryId, structuredClone(snapshot));
        return true;
      } catch {
        this.writeFailures++;
        this.appendBlocked = true;
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
    if (this.initialized) {
      try {
        const fileStats = await stat(this.filePath);
        if (
          this.journalExists &&
          fileStats.size === this.journalBytes &&
          fileStats.mtimeMs === this.journalMtimeMs
        )
          return [...this.latestSnapshots.values()].map((snapshot) => structuredClone(snapshot));
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code === 'ENOENT' &&
          !this.journalExists &&
          this.journalBytes === 0
        )
          return [...this.latestSnapshots.values()].map((snapshot) => structuredClone(snapshot));
      }
      this.initialized = false;
    }
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
        this.initialized = true;
        return [];
      }
      this.readFailures++;
      this.appendBlocked = true;
      this.initialized = true;
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
    for (const snapshot of latest.values()) {
      this.persistedDecisionCounts.set(
        `${snapshot.identity.entryId}:CURRENT`,
        snapshot.simulations.CURRENT.decisions.length,
      );
      this.persistedDecisionCounts.set(
        `${snapshot.identity.entryId}:CANDIDATE`,
        snapshot.simulations.CANDIDATE.decisions.length,
      );
    }
    this.latestSnapshots.clear();
    for (const [entryId, snapshot] of latest) this.latestSnapshots.set(entryId, snapshot);
    this.journalBytes = Buffer.byteLength(content, 'utf8');
    this.journalExists = true;
    try {
      this.journalMtimeMs = (await stat(this.filePath)).mtimeMs;
    } catch {
      this.readFailures++;
      this.appendBlocked = true;
    }
    this.initialized = true;
    return [...latest.values()].map((snapshot) => structuredClone(snapshot));
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

  private async ensureReadyForAppend(): Promise<boolean> {
    if (!this.initialized) await this.load();
    if (this.appendBlocked) return false;
    try {
      const fileStats = await stat(this.filePath);
      if (
        !this.journalExists ||
        fileStats.size !== this.journalBytes ||
        fileStats.mtimeMs !== this.journalMtimeMs
      ) {
        this.appendBlocked = true;
        return false;
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        if (!this.journalExists && this.journalBytes === 0) return true;
        this.appendBlocked = true;
        return false;
      }
      this.readFailures++;
      this.appendBlocked = true;
      return false;
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
      decisions?: unknown;
    };
    if (
      record.formatVersion !== PROSPECTIVE_EXIT_JOURNAL_FORMAT_VERSION ||
      record.recordType !== 'EPISODE_SNAPSHOT' ||
      !isValidProspectiveExitEntrySnapshot(record.snapshot)
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
    if (
      !record.decisions ||
      typeof record.decisions !== 'object' ||
      !Array.isArray((record.decisions as { CURRENT?: unknown }).CURRENT) ||
      !Array.isArray((record.decisions as { CANDIDATE?: unknown }).CANDIDATE)
    )
      return null;
    const snapshot = record.snapshot;
    const previous = latest.get(snapshot.identity.entryId);
    const observations = [...(previous?.observations ?? []), ...record.observations];
    const decisions = record.decisions as {
      CURRENT: ProspectiveExitEntrySnapshot['simulations']['CURRENT']['decisions'];
      CANDIDATE: ProspectiveExitEntrySnapshot['simulations']['CANDIDATE']['decisions'];
    };
    const currentDecisions = [
      ...(previous?.simulations.CURRENT.decisions ?? []),
      ...decisions.CURRENT,
    ];
    const candidateDecisions = [
      ...(previous?.simulations.CANDIDATE.decisions ?? []),
      ...decisions.CANDIDATE,
    ];
    if (
      observations.length > 512 ||
      currentDecisions.length > 512 ||
      candidateDecisions.length > 512
    )
      return null;
    const reconstructed = {
      ...snapshot,
      observations,
      simulations: {
        CURRENT: { ...snapshot.simulations.CURRENT, decisions: currentDecisions },
        CANDIDATE: { ...snapshot.simulations.CANDIDATE, decisions: candidateDecisions },
      },
    };
    return isValidProspectiveExitEntrySnapshot(reconstructed) ? reconstructed : null;
  }

  private isIncompatibleJournalRecord(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    const record = value as { formatVersion?: unknown; recordType?: unknown };
    return (
      record.formatVersion !== undefined ||
      record.recordType !== undefined ||
      isValidProspectiveExitEntrySnapshot(value)
    );
  }
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

  public async finalizeAtHorizon(
    entryId: string,
    atMs: number,
    reason: string,
  ): Promise<boolean> {
    if (this.options.enabled !== true) return false;
    try {
      const accepted =
        this.observer.getEntry(entryId)?.completed === true ||
        this.observer.finalizeAtHorizon(entryId, atMs, reason);
      return accepted && (await this.persist(entryId));
    } catch {
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

  public entriesSnapshot(): readonly ProspectiveExitEntrySnapshot[] {
    return this.observer.entriesSnapshot();
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
