import type { DepthEvent, MarketDataGap } from './NormalizedMarketEvents';

export type DepthDecision = 'ACCEPT' | 'WAIT_FOR_SNAPSHOT' | 'REJECT_STALE' | 'GAP';

/** Generic continuity detector retained for consumers that operate on normalized depth events. */
export class DepthStreamGapDetector {
  private lastFinalUpdateId: number | null = null;
  private synchronized = false;

  constructor(private readonly onGap?: (gap: MarketDataGap) => void) {}

  seedSnapshot(lastUpdateId: number): void {
    if (Number.isSafeInteger(lastUpdateId) && lastUpdateId > 0) {
      this.lastFinalUpdateId = lastUpdateId;
      this.synchronized = false;
    }
  }

  accept(event: DepthEvent): DepthDecision {
    if (this.lastFinalUpdateId === null) return 'WAIT_FOR_SNAPSHOT';
    if (event.finalUpdateId <= this.lastFinalUpdateId) return 'REJECT_STALE';
    if (!this.synchronized) {
      if (
        event.firstUpdateId > this.lastFinalUpdateId + 1 ||
        event.finalUpdateId < this.lastFinalUpdateId + 1
      ) {
        const snapshotLastUpdateId = this.lastFinalUpdateId;
        this.lastFinalUpdateId = null;
        this.synchronized = false;
        this.onGap?.({
          symbol: event.symbol,
          kind: 'DEPTH_SEQUENCE',
          feed: 'DEPTH',
          startedAtMs: event.eventTimeMs,
          endedAtMs: event.eventTimeMs,
          details: {
            snapshotLastUpdateId,
            firstUpdateId: event.firstUpdateId,
            finalUpdateId: event.finalUpdateId,
          },
        });
        return 'GAP';
      }
      this.synchronized = true;
      this.lastFinalUpdateId = event.finalUpdateId;
      return 'ACCEPT';
    }
    const contiguous =
      event.previousFinalUpdateId !== undefined
        ? event.previousFinalUpdateId === this.lastFinalUpdateId &&
          event.firstUpdateId <= this.lastFinalUpdateId + 1 &&
          event.finalUpdateId >= this.lastFinalUpdateId + 1
        : event.firstUpdateId <= this.lastFinalUpdateId + 1 &&
          event.finalUpdateId >= this.lastFinalUpdateId + 1;
    if (!contiguous) {
      const previousFinalUpdateId = this.lastFinalUpdateId;
      this.lastFinalUpdateId = null;
      this.synchronized = false;
      this.onGap?.({
        symbol: event.symbol,
        kind: 'DEPTH_SEQUENCE',
        feed: 'DEPTH',
        startedAtMs: event.eventTimeMs,
        endedAtMs: event.eventTimeMs,
        details: {
          previousFinalUpdateId,
          firstUpdateId: event.firstUpdateId,
          finalUpdateId: event.finalUpdateId,
        },
      });
      return 'GAP';
    }
    this.lastFinalUpdateId = event.finalUpdateId;
    return 'ACCEPT';
  }

  get watermark(): number | null {
    return this.lastFinalUpdateId;
  }
}
