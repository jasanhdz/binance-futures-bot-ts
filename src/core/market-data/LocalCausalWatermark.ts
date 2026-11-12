import { randomUUID } from 'node:crypto';

/**
 * Process-local stream identity and receive sequence. Sequence values are only
 * ordered within `processGenerationId`; no timestamp or sequence is comparable
 * across process generations.
 */
export interface LocalCausalEventStamp {
  readonly schemaVersion: 1;
  readonly processGenerationId: string;
  readonly connectionGeneration: number;
  readonly receiveSequence: number;
  readonly receivedMonotonicAtMs: number;
}

/** A state snapshot watermark distinguishes events seen from events applied. */
export interface LocalCausalStateWatermark {
  readonly schemaVersion: 1;
  readonly processGenerationId: string;
  /** Connection of the latest received event. */
  readonly connectionGeneration: number;
  readonly receivedSequence: number;
  /** Connection that supplied the last state mutation; may lag after reconnect. */
  readonly lastAppliedConnectionGeneration: number | null;
  readonly lastAppliedReceiveSequence: number | null;
  readonly appliedStateVersion: number;
  readonly receivedMonotonicAtMs: number | null;
  readonly appliedMonotonicAtMs: number | null;
}

/** Evidence attached to a decision context; its source versions are an input vector, not a global clock. */
export interface LocalCausalContextEvidence {
  readonly schemaVersion: 1;
  readonly processGenerationId: string | null;
  readonly captureLocalReceivedAtMs: number | null;
  readonly captureMonotonicAtMs: number | null;
  readonly sourceGenerationsConsistent: boolean;
  readonly sources: Readonly<Record<string, LocalCausalStateWatermark | null>>;
  readonly archivePersistence?: {
    readonly storageGenerationId: string;
    readonly appendedArchiveSequence: number;
    readonly checkpointSequence: number;
    readonly sampledAtMonotonicMs: number;
  } | null;
}

export class LocalCausalSequence {
  private sequence = 0;

  constructor(
    readonly processGenerationId: string = randomUUID(),
    private readonly monotonicNow: () => number = () => performance.now(),
  ) {
    if (!processGenerationId.trim()) throw new Error('LOCAL_CAUSAL_PROCESS_GENERATION_REQUIRED');
  }

  receive(connectionGeneration: number): LocalCausalEventStamp {
    if (!Number.isSafeInteger(connectionGeneration) || connectionGeneration < 1)
      throw new Error('LOCAL_CAUSAL_CONNECTION_GENERATION_INVALID');
    const receivedMonotonicAtMs = this.monotonicNow();
    if (!Number.isFinite(receivedMonotonicAtMs) || receivedMonotonicAtMs < 0)
      throw new Error('LOCAL_CAUSAL_MONOTONIC_CLOCK_INVALID');
    return Object.freeze({
      schemaVersion: 1,
      processGenerationId: this.processGenerationId,
      connectionGeneration,
      receiveSequence: ++this.sequence,
      receivedMonotonicAtMs,
    });
  }
}

let processCausalSequence: LocalCausalSequence | undefined;

/** Shared by every public stream hub in one Node process; a restart creates a new generation. */
export function processLocalCausalSequence(): LocalCausalSequence {
  processCausalSequence ??= new LocalCausalSequence();
  return processCausalSequence;
}
