/** Local wall-clock timings. SDK completion is not packet receipt or exchange finalization. */
export interface CandleReadProvenance {
  requestedAtMs: number;
  receivedAtMs: number;
  normalizedCache: 'HIT' | 'MISS' | 'UNKNOWN';
  originRequestedAtMs: number | null;
  originReceivedAtMs: number | null;
  transportCache: 'UNKNOWN';
  closureCriterion: 'closeTime <= exchangeSnapshotTimeMs';
  classificationExchangeTimeMs: number | null;
  exchangeFinalization: 'UNKNOWN';
}

// Metadata follows the exact returned array, avoiding mutable last-read/global attribution.
// Weak keys bound retention to the existing cache/read lifetime; no payload duplication.
const reads = new WeakMap<object, Readonly<CandleReadProvenance>>();

export function setCandleProvenance<T extends object>(
  candles: T,
  provenance: CandleReadProvenance,
): T {
  reads.set(candles, Object.freeze({ ...provenance }));
  return candles;
}

export function getCandleProvenance(candles: object): Readonly<CandleReadProvenance> | undefined {
  return reads.get(candles);
}
