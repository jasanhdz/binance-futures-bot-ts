import { performance } from 'node:perf_hooks';
import type { MicroBurstProspectiveExitEventSource } from './MicroBurstProspectiveExitRuntime';
import type {
  ProspectiveExitEntrySnapshot,
  ProspectiveExitIdentity,
  ProspectiveExitObservation,
  ProspectiveRealFill,
} from './MicroBurstProspectiveExitObserver';

type EntryListener = (
  identity: ProspectiveExitIdentity,
  fills: readonly ProspectiveRealFill[],
) => void;
type FillListener = (entryId: string, fill: ProspectiveRealFill) => void;
type CloseListener = (entryId: string, closedAtMs: number) => void;
type ObservationListener = (entryId: string, observation: ProspectiveExitObservation) => void;

/** Application-owned fan-out for reconciled execution and consumed market data. */
export class MicroBurstProspectiveExitEventBus implements MicroBurstProspectiveExitEventSource {
  private enabled: boolean;
  private readonly maxEntries: number;
  private readonly entries = new Map<string, ProspectiveExitIdentity>();
  private readonly closedEntries = new Set<string>();
  private readonly latestObservations = new Map<string, ProspectiveExitObservation>();
  private readonly entryListeners = new Set<EntryListener>();
  private readonly fillListeners = new Set<FillListener>();
  private readonly closeListeners = new Set<CloseListener>();
  private readonly observationListeners = new Set<ObservationListener>();
  private synchronousPublishCount = 0;
  private synchronousPublishTotalMs = 0;
  private synchronousPublishMaxMs = 0;

  public constructor(enabled = false, maxEntries = 256) {
    this.enabled = enabled;
    this.maxEntries = Math.max(1, Math.floor(maxEntries));
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.clear();
  }

  onExecutedEntry(listener: EntryListener): () => void {
    this.entryListeners.add(listener);
    return () => this.entryListeners.delete(listener);
  }

  onRealFill(listener: FillListener): () => void {
    this.fillListeners.add(listener);
    return () => this.fillListeners.delete(listener);
  }

  onRealPositionClosed(listener: CloseListener): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  onObservation(listener: ObservationListener): () => void {
    this.observationListeners.add(listener);
    return () => this.observationListeners.delete(listener);
  }

  publishExecutedEntry(
    identity: ProspectiveExitIdentity,
    fills: readonly ProspectiveRealFill[],
  ): void {
    if (!this.enabled) return;
    if (!this.entries.has(identity.entryId) && this.entries.size >= this.maxEntries) return;
    const started = performance.now();
    this.entries.set(identity.entryId, identity);
    this.closedEntries.delete(identity.entryId);
    for (const listener of this.entryListeners) {
      try {
        listener(identity, fills);
      } catch {
        // Observational listeners must never affect execution callers.
      }
    }
    this.recordSynchronousCost(started);
  }

  publishRealFill(entryId: string, fill: ProspectiveRealFill): void {
    if (!this.enabled) return;
    const started = performance.now();
    if (!this.entries.has(entryId)) return;
    for (const listener of this.fillListeners) {
      try {
        listener(entryId, fill);
      } catch {
        // Observational listeners must never affect execution callers.
      }
    }
    this.recordSynchronousCost(started);
  }

  publishRealPositionClosed(entryId: string, closedAtMs: number): void {
    if (!this.enabled) return;
    const started = performance.now();
    if (!this.entries.has(entryId)) return;
    if (this.closedEntries.has(entryId)) return;
    this.closedEntries.add(entryId);
    for (const listener of this.closeListeners) {
      try {
        listener(entryId, closedAtMs);
      } catch {
        // Observational listeners must never affect execution callers.
      }
    }
    this.recordSynchronousCost(started);
  }

  publishObservation(entryId: string, observation: ProspectiveExitObservation): void {
    if (!this.enabled) return;
    const started = performance.now();
    if (!this.entries.has(entryId)) return;
    this.latestObservations.set(entryId, observation);
    for (const listener of this.observationListeners) {
      try {
        listener(entryId, observation);
      } catch {
        // Observational listeners must never affect execution callers.
      }
    }
    this.recordSynchronousCost(started);
  }

  entriesSnapshot(): readonly ProspectiveExitIdentity[] {
    return [...this.entries.values()];
  }

  restoreEntries(entries: readonly ProspectiveExitEntrySnapshot[]): void {
    if (!this.enabled) return;
    for (const entry of entries) {
      if (
        this.entries.size >= this.maxEntries &&
        !this.entries.has(entry.identity.entryId)
      )
        break;
      this.entries.set(entry.identity.entryId, entry.identity);
      if (entry.realPositionClosedAtMs !== null) this.closedEntries.add(entry.identity.entryId);
      const latest = entry.observations[entry.observations.length - 1];
      if (latest) this.latestObservations.set(entry.identity.entryId, latest);
    }
  }

  closedEntriesSnapshot(): readonly string[] {
    return [...this.closedEntries];
  }

  latestObservation(entryId: string): ProspectiveExitObservation | null {
    return this.latestObservations.get(entryId) ?? null;
  }

  removeEntry(entryId: string): void {
    this.entries.delete(entryId);
    this.closedEntries.delete(entryId);
    this.latestObservations.delete(entryId);
  }

  getSynchronousCost(): {
    publishCount: number;
    totalMs: number;
    maxMs: number;
  } {
    return {
      publishCount: this.synchronousPublishCount,
      totalMs: this.synchronousPublishTotalMs,
      maxMs: this.synchronousPublishMaxMs,
    };
  }

  private recordSynchronousCost(started: number): void {
    const elapsed = performance.now() - started;
    this.synchronousPublishCount++;
    this.synchronousPublishTotalMs += elapsed;
    this.synchronousPublishMaxMs = Math.max(this.synchronousPublishMaxMs, elapsed);
  }

  clear(): void {
    this.entries.clear();
    this.closedEntries.clear();
    this.latestObservations.clear();
  }
}
