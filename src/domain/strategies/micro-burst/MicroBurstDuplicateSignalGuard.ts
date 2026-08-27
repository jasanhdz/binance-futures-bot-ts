import { Side } from '../../types';

interface SignalRecord {
  shadowSignalId: string;
  firstObservedAt: number;
  lastObservedAt: number;
}

const BUCKET_SIZE_MS = 60_000;
const MAX_SIGNAL_HISTORY = 500;
const SIGNAL_TTL_MS = 3_600_000;

interface Clock {
  now(): number;
}

function computeSnapshotBucket(snapshotAtMs: number): number {
  return Math.floor(snapshotAtMs / BUCKET_SIZE_MS);
}

function buildSignalKey(
  strategy: string,
  symbol: string,
  side: Side,
  structuralLevel: number,
  snapshotAtMs: number,
): string {
  const bucket = computeSnapshotBucket(snapshotAtMs);
  return `${strategy}:${symbol}:${side}:${Math.round(structuralLevel * 100)}:${bucket}`;
}

function generateShadowSignalId(
  strategy: string,
  symbol: string,
  side: Side,
  structuralLevel: number,
  snapshotAtMs: number,
): string {
  const bucket = computeSnapshotBucket(snapshotAtMs);
  return `shadow-${strategy}-${symbol}-${side}-${Math.round(structuralLevel * 100)}-${bucket}`;
}

export class MicroBurstDuplicateSignalGuard {
  private readonly seen = new Map<string, SignalRecord>();

  constructor(private readonly clock: Clock) {}

  check(
    strategy: string,
    symbol: string,
    side: Side,
    structuralLevel: number,
    snapshotAtMs: number,
  ): {
    shadowSignalId: string;
    duplicateSuppressed: boolean;
    firstObservedAt: number;
    lastObservedAt: number;
  } {
    const key = buildSignalKey(strategy, symbol, side, structuralLevel, snapshotAtMs);
    const now = this.clock.now();

    this.evictExpired(now);

    const existing = this.seen.get(key);
    if (existing) {
      existing.lastObservedAt = now;
      return {
        shadowSignalId: existing.shadowSignalId,
        duplicateSuppressed: true,
        firstObservedAt: existing.firstObservedAt,
        lastObservedAt: existing.lastObservedAt,
      };
    }

    const shadowSignalId = generateShadowSignalId(
      strategy,
      symbol,
      side,
      structuralLevel,
      snapshotAtMs,
    );
    const record: SignalRecord = {
      shadowSignalId,
      firstObservedAt: now,
      lastObservedAt: now,
    };

    this.seen.set(key, record);

    while (this.seen.size > MAX_SIGNAL_HISTORY) {
      const oldest = this.seen.keys().next().value;
      if (oldest) this.seen.delete(oldest);
    }

    return {
      shadowSignalId,
      duplicateSuppressed: false,
      firstObservedAt: now,
      lastObservedAt: now,
    };
  }

  private evictExpired(now: number): void {
    for (const [key, record] of this.seen.entries()) {
      if (now - record.lastObservedAt > SIGNAL_TTL_MS) {
        this.seen.delete(key);
      }
    }
  }

  clear(): void {
    this.seen.clear();
  }

  size(): number {
    return this.seen.size;
  }
}
