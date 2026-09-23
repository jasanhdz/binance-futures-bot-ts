import { appendFile, mkdir, readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  MicroBurstProspectiveExitObserver,
  ProspectiveExitEntrySnapshot,
  ProspectiveExitIdentity,
  ProspectiveExitObservation,
  ProspectiveRealFill,
} from './MicroBurstProspectiveExitObserver';

export interface ProspectiveExitSnapshotStore {
  save(snapshot: ProspectiveExitEntrySnapshot): Promise<boolean>;
  load(): Promise<readonly ProspectiveExitEntrySnapshot[]>;
  getHealth(): {
    healthy: boolean;
    malformedRecords: number;
    truncatedRecords: number;
    writeFailures: number;
    pendingWrites: number;
  };
}

/** Bounded JSONL store for research capture. It is never used by LIVE runtime. */
export class MicroBurstProspectiveExitJsonlStore implements ProspectiveExitSnapshotStore {
  private malformedRecords = 0;
  private truncatedRecords = 0;
  private writeFailures = 0;
  private pendingWrites = 0;
  private writeTail = Promise.resolve();

  public constructor(
    private readonly filePath: string,
    private readonly maxBytes = 64 * 1024 * 1024,
    private readonly maxPendingWrites = 1024,
  ) {}

  public save(snapshot: ProspectiveExitEntrySnapshot): Promise<boolean> {
    if (this.pendingWrites >= this.maxPendingWrites) {
      this.writeFailures++;
      return Promise.resolve(false);
    }
    this.pendingWrites++;
    const operation = this.writeTail.then(async () => {
      try {
        const currentBytes = await stat(this.filePath)
          .then((value) => value.size)
          .catch(() => 0);
        const line = `${JSON.stringify(snapshot)}\n`;
        if (currentBytes + Buffer.byteLength(line, 'utf8') > this.maxBytes) {
          this.writeFailures++;
          return false;
        }
        await mkdir(dirname(this.filePath), { recursive: true });
        await appendFile(this.filePath, line, 'utf8');
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
    let content: string;
    try {
      content = await readFile(this.filePath, 'utf8');
    } catch {
      return [];
    }
    const latest = new Map<string, ProspectiveExitEntrySnapshot>();
    const lines = content.split('\n');
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue;
      try {
        const snapshot = JSON.parse(line) as ProspectiveExitEntrySnapshot;
        if (!snapshot.identity?.entryId) throw new Error('ENTRY_ID_MISSING');
        latest.set(snapshot.identity.entryId, snapshot);
      } catch {
        this.malformedRecords++;
        if (index === lines.length - 1 && !content.endsWith('\n')) this.truncatedRecords++;
      }
    }
    return [...latest.values()];
  }

  public getHealth(): {
    healthy: boolean;
    malformedRecords: number;
    truncatedRecords: number;
    writeFailures: number;
    pendingWrites: number;
  } {
    return {
      healthy:
        this.malformedRecords === 0 && this.truncatedRecords === 0 && this.writeFailures === 0,
      malformedRecords: this.malformedRecords,
      truncatedRecords: this.truncatedRecords,
      writeFailures: this.writeFailures,
      pendingWrites: this.pendingWrites,
    };
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
      for (const fill of fills)
        if (!this.observer.recordRealFill(identity.entryId, fill)) this.recordFillRejection();
      return await this.persist(identity.entryId);
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
