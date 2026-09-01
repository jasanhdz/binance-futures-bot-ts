import { createHash } from 'node:crypto';
import type { MarketSnapshotV1 } from '../../core/market-data/MarketSnapshotProvider';
import type {
  MarketSnapshotEvidenceReference,
  MarketSnapshotEvidenceSink,
} from '../../core/blackbox/StrategyDecisionBlackBox';
import { createMarketSnapshotEvidenceV2 } from '../../core/blackbox/StrategyDecisionBlackBox';
import {
  RotatingJsonlWriter,
  type RotatingJsonlWriterMetrics,
  type RotatingJsonlWriterOptions,
} from './RotatingJsonlWriter';

export interface JsonlMarketSnapshotSinkOptions extends RotatingJsonlWriterOptions {
  dedupeWindowMs?: number;
  maxDedupeEntries?: number;
  now?: () => number;
}

export interface JsonlMarketSnapshotSinkMetrics extends RotatingJsonlWriterMetrics {
  storedSnapshots: number;
  deduplicatedSnapshots: number;
}

interface CanonicalSnapshot {
  snapshotId: string;
  storedAtMs: number;
}

/** Append-only shared market snapshot sink with no exchange or execution authority. */
export class JsonlMarketSnapshotSink implements MarketSnapshotEvidenceSink {
  private readonly writer: RotatingJsonlWriter;
  private readonly inFlightByContent = new Map<string, Promise<MarketSnapshotEvidenceReference>>();
  private readonly canonicalByContent = new Map<string, CanonicalSnapshot>();
  private storedSnapshots = 0;
  private deduplicatedSnapshots = 0;

  constructor(
    filePath: string,
    private readonly options: JsonlMarketSnapshotSinkOptions = {},
  ) {
    this.writer = new RotatingJsonlWriter(filePath, options);
  }

  append(snapshot: MarketSnapshotV1): Promise<MarketSnapshotEvidenceReference> {
    const now = (this.options.now ?? Date.now)();
    const contentHash = snapshotContentHash(snapshot);
    const dedupeWindowMs = Math.max(0, this.options.dedupeWindowMs ?? 300_000);
    const existing = this.canonicalByContent.get(contentHash);
    if (existing && now - existing.storedAtMs <= dedupeWindowMs) {
      this.deduplicatedSnapshots += 1;
      return Promise.resolve({ snapshotId: existing.snapshotId, stored: false, contentHash });
    }

    const inFlight = this.inFlightByContent.get(contentHash);
    if (inFlight) {
      return inFlight.then((reference) => {
        this.deduplicatedSnapshots += 1;
        return { ...reference, stored: false };
      });
    }

    const operation = this.storeSnapshot(snapshot, contentHash, now, dedupeWindowMs);
    this.inFlightByContent.set(contentHash, operation);
    void operation.then(
      () => this.clearInFlight(contentHash, operation),
      () => this.clearInFlight(contentHash, operation),
    );
    return operation;
  }

  private async storeSnapshot(
    snapshot: MarketSnapshotV1,
    contentHash: string,
    now: number,
    dedupeWindowMs: number,
  ): Promise<MarketSnapshotEvidenceReference> {
    await this.writer.append(createMarketSnapshotEvidenceV2(snapshot, contentHash, now));
    this.storedSnapshots += 1;
    this.canonicalByContent.delete(contentHash);
    this.canonicalByContent.set(contentHash, { snapshotId: snapshot.snapshotId, storedAtMs: now });
    this.pruneDedupeIndex(now, dedupeWindowMs);
    return { snapshotId: snapshot.snapshotId, stored: true, contentHash };
  }

  health(): Readonly<JsonlMarketSnapshotSinkMetrics> {
    return {
      ...this.writer.health(),
      storedSnapshots: this.storedSnapshots,
      deduplicatedSnapshots: this.deduplicatedSnapshots,
    };
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.inFlightByContent.values()]);
    await this.writer.drain();
  }

  private pruneDedupeIndex(now: number, dedupeWindowMs: number): void {
    const maxEntries = Math.max(1, this.options.maxDedupeEntries ?? 4_096);
    for (const [hash, entry] of this.canonicalByContent) {
      if (now - entry.storedAtMs > dedupeWindowMs || this.canonicalByContent.size > maxEntries) {
        this.canonicalByContent.delete(hash);
      } else {
        break;
      }
    }
  }

  private clearInFlight(
    contentHash: string,
    operation: Promise<MarketSnapshotEvidenceReference>,
  ): void {
    if (this.inFlightByContent.get(contentHash) === operation) {
      this.inFlightByContent.delete(contentHash);
    }
  }
}

function snapshotContentHash(snapshot: MarketSnapshotV1): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        schemaVersion: snapshot.schemaVersion,
        symbol: snapshot.symbol,
        primary: snapshot.primary,
        benchmark: snapshot.benchmark,
        health: snapshot.health,
        provenance: snapshot.provenance,
      }),
    )
    .digest('hex');
}
