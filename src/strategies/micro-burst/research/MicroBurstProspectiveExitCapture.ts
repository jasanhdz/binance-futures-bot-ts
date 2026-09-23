import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  MicroBurstProspectiveExitObserver,
  ProspectiveExitEntrySnapshot,
  ProspectiveExitIdentity,
  ProspectiveExitObservation,
  ProspectiveRealFill,
} from './MicroBurstProspectiveExitObserver';

export interface ProspectiveExitSnapshotStore {
  save(snapshot: ProspectiveExitEntrySnapshot): boolean;
  load(): readonly ProspectiveExitEntrySnapshot[];
  getHealth(): { healthy: boolean; malformedRecords: number; writeFailures: number };
}

/** Bounded JSONL store for research capture. It is never used by LIVE runtime. */
export class MicroBurstProspectiveExitJsonlStore implements ProspectiveExitSnapshotStore {
  private malformedRecords = 0;
  private writeFailures = 0;

  public constructor(
    private readonly filePath: string,
    private readonly maxBytes = 64 * 1024 * 1024,
  ) {}

  public save(snapshot: ProspectiveExitEntrySnapshot): boolean {
    try {
      const currentBytes = statSync(this.filePath, { throwIfNoEntry: false })?.size ?? 0;
      const line = `${JSON.stringify(snapshot)}\n`;
      if (currentBytes + Buffer.byteLength(line, 'utf8') > this.maxBytes) {
        this.writeFailures++;
        return false;
      }
      mkdirSync(dirname(this.filePath), { recursive: true });
      appendFileSync(this.filePath, line, 'utf8');
      return true;
    } catch {
      this.writeFailures++;
      return false;
    }
  }

  public load(): readonly ProspectiveExitEntrySnapshot[] {
    let content: string;
    try {
      content = readFileSync(this.filePath, 'utf8');
    } catch {
      return [];
    }
    const latest = new Map<string, ProspectiveExitEntrySnapshot>();
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const snapshot = JSON.parse(line) as ProspectiveExitEntrySnapshot;
        if (!snapshot.identity?.entryId) throw new Error('ENTRY_ID_MISSING');
        latest.set(snapshot.identity.entryId, snapshot);
      } catch {
        this.malformedRecords++;
      }
    }
    return [...latest.values()];
  }

  public getHealth(): { healthy: boolean; malformedRecords: number; writeFailures: number } {
    return {
      healthy: this.malformedRecords === 0 && this.writeFailures === 0,
      malformedRecords: this.malformedRecords,
      writeFailures: this.writeFailures,
    };
  }
}

export interface ProspectiveExitCaptureMetrics {
  persistenceFailures: number;
  rejectedEntries: number;
  rejectedObservations: number;
  rejectedFills: number;
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
  };

  public constructor(
    private readonly observer: MicroBurstProspectiveExitObserver,
    private readonly store?: ProspectiveExitSnapshotStore,
    private readonly options: MicroBurstProspectiveExitCaptureOptions = {},
  ) {}

  /** Called by an execution reconciler, not by an order-intent producer. */
  public onExecutedEntry(
    identity: ProspectiveExitIdentity,
    fills: readonly ProspectiveRealFill[] = [],
  ): boolean {
    if (this.options.enabled !== true) return false;
    try {
      if (!this.observer.registerEntry(identity)) {
        this.metrics = { ...this.metrics, rejectedEntries: this.metrics.rejectedEntries + 1 };
        return false;
      }
      for (const fill of fills)
        if (!this.observer.recordRealFill(identity.entryId, fill)) this.recordFillRejection();
      return this.persist(identity.entryId);
    } catch {
      this.metrics = { ...this.metrics, rejectedEntries: this.metrics.rejectedEntries + 1 };
      return false;
    }
  }

  public onRealFill(entryId: string, fill: ProspectiveRealFill): boolean {
    if (this.options.enabled !== true) return false;
    try {
      const accepted = this.observer.recordRealFill(entryId, fill);
      if (!accepted) this.recordFillRejection();
      return accepted && this.persist(entryId);
    } catch {
      this.recordFillRejection();
      return false;
    }
  }

  public onRealPositionClosed(entryId: string, closedAtMs: number): boolean {
    if (this.options.enabled !== true) return false;
    try {
      const accepted = this.observer.markRealPositionClosed(entryId, closedAtMs);
      if (!accepted) return false;
      return this.persist(entryId);
    } catch {
      return false;
    }
  }

  /** Feed the exact snapshot already consumed by the market-data path. */
  public onObservation(entryId: string, observation: ProspectiveExitObservation): boolean {
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
      return this.persist(entryId);
    } catch {
      this.metrics = {
        ...this.metrics,
        rejectedObservations: this.metrics.rejectedObservations + 1,
      };
      return false;
    }
  }

  /** Restore latest snapshots after restart; corrupt rows are isolated by the store. */
  public restore(): number {
    if (this.options.enabled !== true || !this.store) return 0;
    let restored = 0;
    for (const snapshot of this.store.load()) if (this.observer.restoreEntry(snapshot)) restored++;
    return restored;
  }

  public getMetrics(): ProspectiveExitCaptureMetrics {
    return { ...this.metrics };
  }

  private persist(entryId: string): boolean {
    if (!this.store) return true;
    const snapshot = this.observer.getEntry(entryId);
    if (!snapshot || this.store.save(snapshot)) return Boolean(snapshot);
    this.metrics = { ...this.metrics, persistenceFailures: this.metrics.persistenceFailures + 1 };
    return false;
  }

  private recordFillRejection(): void {
    this.metrics = { ...this.metrics, rejectedFills: this.metrics.rejectedFills + 1 };
  }
}
