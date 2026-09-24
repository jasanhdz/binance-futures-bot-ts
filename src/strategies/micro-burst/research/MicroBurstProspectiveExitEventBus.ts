import type { MicroBurstProspectiveExitEventSource } from './MicroBurstProspectiveExitRuntime';
import type {
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
  private readonly entries = new Map<string, ProspectiveExitIdentity>();
  private readonly entryListeners = new Set<EntryListener>();
  private readonly fillListeners = new Set<FillListener>();
  private readonly closeListeners = new Set<CloseListener>();
  private readonly observationListeners = new Set<ObservationListener>();
  private synchronousPublishCount = 0;
  private synchronousPublishTotalMs = 0;
  private synchronousPublishMaxMs = 0;

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
    const started = performance.now();
    this.entries.set(identity.entryId, identity);
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
    const started = performance.now();
    if (!this.entries.has(entryId)) return;
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
    const started = performance.now();
    if (!this.entries.has(entryId)) return;
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
  }
}
import { performance } from 'node:perf_hooks';
