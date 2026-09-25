import {
  MicroBurstProspectiveExitCapture,
  MicroBurstProspectiveExitJsonlStore,
} from './MicroBurstProspectiveExitCapture';
import {
  MicroBurstProspectiveExitObserver,
  ProspectiveExitEntrySnapshot,
  ProspectiveExitIdentity,
  ProspectiveExitObservation,
  ProspectiveRealFill,
} from './MicroBurstProspectiveExitObserver';
import type { MicroBurstProspectiveExitObserverOptions } from './MicroBurstProspectiveExitObserver';

export interface MicroBurstProspectiveExitEventSource {
  onExecutedEntry(
    listener: (identity: ProspectiveExitIdentity, fills: readonly ProspectiveRealFill[]) => void,
  ): () => void;
  onRealFill(listener: (entryId: string, fill: ProspectiveRealFill) => void): () => void;
  onRealPositionClosed(listener: (entryId: string, closedAtMs: number) => void): () => void;
  onObservation(
    listener: (entryId: string, observation: ProspectiveExitObservation) => void,
  ): () => void;
  removeEntry?(entryId: string): void;
}

export interface MicroBurstProspectiveExitRuntimeConfig {
  enabled: boolean;
  journalPath: string;
  maxJournalBytes?: number;
  maxPendingWrites?: number;
  maxEntries?: number;
  maxObservationsPerEntry?: number;
}

export const DEFAULT_MICRO_BURST_PROSPECTIVE_EXIT_RUNTIME_CONFIG = {
  enabled: false,
  journalPath: 'logs/micro-burst/prospective-exits.jsonl',
  maxJournalBytes: 64 * 1024 * 1024,
  maxPendingWrites: 1024,
  maxEntries: 256,
  maxObservationsPerEntry: 512,
} as const;

/**
 * Observer-only runtime composition. It accepts reconciled fills and consumed
 * market snapshots, but has no order, exchange, or position-authority port.
 */
export class MicroBurstProspectiveExitRuntime {
  private readonly unsubs: Array<() => void> = [];
  private started = false;
  private restored = 0;
  private startPromise: Promise<boolean> | null = null;
  private lifecycleGeneration = 0;

  public constructor(
    private readonly capture: MicroBurstProspectiveExitCapture,
    private readonly source: MicroBurstProspectiveExitEventSource,
    private readonly enabled: boolean,
  ) {}

  public async start(): Promise<boolean> {
    if (!this.enabled || this.started) return false;
    if (this.startPromise) return this.startPromise;
    const generation = ++this.lifecycleGeneration;
    this.startPromise = this.startAfterRestore(generation);
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async startAfterRestore(generation: number): Promise<boolean> {
    this.restored = await this.capture.restore();
    if (generation !== this.lifecycleGeneration) return false;
    this.unsubs.push(
      this.source.onExecutedEntry((identity, fills) => {
        void this.capture.onExecutedEntry(identity, fills);
      }),
      this.source.onRealFill((entryId, fill) => {
        void this.capture.onRealFill(entryId, fill);
      }),
      this.source.onRealPositionClosed((entryId, closedAtMs) => {
        void this.capture.onRealPositionClosed(entryId, closedAtMs);
      }),
      this.source.onObservation((entryId, observation) => {
        void this.capture.onObservation(entryId, observation).then(() => {
          if (this.capture.getEntry(entryId)?.completed) this.source.removeEntry?.(entryId);
        });
      }),
    );
    this.started = true;
    return true;
  }

  public async stop(timeoutMs = 5_000): Promise<boolean> {
    this.lifecycleGeneration++;
    for (const unsubscribe of this.unsubs.splice(0)) unsubscribe();
    this.started = false;
    return this.capture.drain(timeoutMs);
  }

  public getHealth(): {
    enabled: boolean;
    started: boolean;
    restored: number;
    capture: ReturnType<MicroBurstProspectiveExitCapture['getHealth']>;
  } {
    return {
      enabled: this.enabled,
      started: this.started,
      restored: this.restored,
      capture: this.capture.getHealth(),
    };
  }

  public getEntry(entryId: string): ProspectiveExitEntrySnapshot | null {
    return this.capture.getEntry(entryId);
  }

  public entriesSnapshot(): readonly ProspectiveExitEntrySnapshot[] {
    return this.capture.entriesSnapshot();
  }
}

export function createMicroBurstProspectiveExitRuntime(
  config: MicroBurstProspectiveExitRuntimeConfig,
  source: MicroBurstProspectiveExitEventSource,
  observer: MicroBurstProspectiveExitObserverOptions = {},
): MicroBurstProspectiveExitRuntime {
  const prospectiveObserver = new MicroBurstProspectiveExitObserver({
    ...observer,
    maxEntries: config.maxEntries,
    maxObservationsPerEntry: config.maxObservationsPerEntry,
  });
  const store = new MicroBurstProspectiveExitJsonlStore(
    config.journalPath,
    config.maxJournalBytes,
    config.maxPendingWrites,
  );
  const capture = new MicroBurstProspectiveExitCapture(prospectiveObserver, store, {
    enabled: config.enabled,
  });
  return new MicroBurstProspectiveExitRuntime(capture, source, config.enabled);
}
