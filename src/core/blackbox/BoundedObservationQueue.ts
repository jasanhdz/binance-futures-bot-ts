/** Observational only. Never use this queue for admission, orders or journals. */
export interface ObservationQueueLimits {
  maxRecords: number;
  maxBytes: number;
  maxNodes: number;
  maxDepth: number;
  maxRecordBytes?: number;
}

export interface ObservationQueueHealth {
  pendingRecords: number;
  pendingBytes: number;
  peakRecords: number;
  peakBytes: number;
  accepted: number;
  written: number;
  dropped: number;
  failed: number;
  closed: boolean;
  lastWriteDurationMs: number | null;
  lastQueueWaitMs: number | null;
  drainTimedOut: boolean;
}

// Only trees created and recursively frozen here can be reused. Object.freeze supplied
// by a caller is not evidence of deep immutability. Weak keys do not retain old records.
const ownedCopies = new WeakMap<object, { bytes: number; nodes: number; height: number }>();

/** Conservative allocation accounting, not a measurement of V8 retained heap. */
export function copyObservation<T>(
  input: T,
  limits: Pick<ObservationQueueLimits, 'maxBytes' | 'maxNodes' | 'maxDepth'>,
): { value: T; bytes: number } {
  let bytes = 0;
  let nodes = 0;
  const ancestors = new WeakSet<object>();
  const charge = (amount: number): void => {
    bytes += amount;
    if (bytes > limits.maxBytes) throw new Error('OBSERVATION_BYTES_EXCEEDED');
  };
  const visit = (value: unknown, depth: number): unknown => {
    const beforeBytes = bytes;
    const beforeNodes = nodes;
    if (++nodes > limits.maxNodes || depth > limits.maxDepth)
      throw new Error('OBSERVATION_COMPLEXITY_EXCEEDED');
    charge(32);
    if (
      value === null ||
      value === undefined ||
      typeof value === 'boolean' ||
      typeof value === 'number'
    )
      return value;
    if (typeof value === 'string') {
      charge(value.length * 6);
      return value;
    }
    if (typeof value !== 'object') throw new Error('OBSERVATION_UNSUPPORTED_VALUE');
    if (Array.isArray(value)) {
      if (value.length > limits.maxNodes - nodes)
        throw new Error('OBSERVATION_COMPLEXITY_EXCEEDED');
      for (let index = 0; index < value.length; index++)
        if (!Object.prototype.hasOwnProperty.call(value, index))
          throw new Error('OBSERVATION_SPARSE_ARRAY');
    }
    const owned = ownedCopies.get(value);
    if (owned) {
      charge(owned.bytes - 32);
      nodes += owned.nodes - 1;
      if (nodes > limits.maxNodes || depth + owned.height > limits.maxDepth)
        throw new Error('OBSERVATION_COMPLEXITY_EXCEEDED');
      return value;
    }
    if (ancestors.has(value)) throw new Error('OBSERVATION_CYCLE');
    if (
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    )
      throw new Error('OBSERVATION_UNSUPPORTED_OBJECT');
    ancestors.add(value);
    const result: unknown[] | Record<string, unknown> = Array.isArray(value) ? [] : {};
    let height = 0;
    // Iterate own keys without allocating Object.entries for an oversized input.
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      charge(32 + key.length * 6);
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!('value' in descriptor)) throw new Error('OBSERVATION_ACCESSOR');
      const child = visit(descriptor.value, depth + 1);
      height = Math.max(
        height,
        1 + (child && typeof child === 'object' ? (ownedCopies.get(child)?.height ?? 0) : 0),
      );
      Object.defineProperty(result, key, {
        value: child,
        enumerable: true,
        configurable: false,
      });
    }
    ancestors.delete(value);
    ownedCopies.set(result, { bytes: bytes - beforeBytes, nodes: nodes - beforeNodes, height });
    return Object.freeze(result);
  };
  return { value: visit(input, 0) as T, bytes };
}

/** One writer promise; caps include the in-flight record until its sink settles. */
export class BoundedObservationQueue<T> {
  private readonly records: { value: T; bytes: number; queuedAt: number }[] = [];
  private running?: Promise<void>;
  private readonly metrics: ObservationQueueHealth = {
    pendingRecords: 0,
    pendingBytes: 0,
    peakRecords: 0,
    peakBytes: 0,
    accepted: 0,
    written: 0,
    dropped: 0,
    failed: 0,
    closed: false,
    lastWriteDurationMs: null,
    lastQueueWaitMs: null,
    drainTimedOut: false,
  };

  constructor(
    private readonly limits: ObservationQueueLimits,
    private readonly write: (record: T) => Promise<void>,
    private readonly monotonicNow: () => number = () => performance.now(),
  ) {
    if (Object.values(limits).some((v) => !Number.isSafeInteger(v) || v <= 0))
      throw new Error('OBSERVATION_QUEUE_INVALID_LIMITS');
  }

  enqueue(record: T): 'QUEUED' | 'OBSERVATIONAL_DROP' {
    if (this.metrics.closed || this.metrics.pendingRecords >= this.limits.maxRecords)
      return this.drop();
    let copied: { value: T; bytes: number };
    try {
      copied = copyObservation(record, {
        ...this.limits,
        maxBytes: Math.min(
          this.limits.maxRecordBytes ?? this.limits.maxBytes,
          this.limits.maxBytes - this.metrics.pendingBytes,
        ),
      });
    } catch {
      return this.drop();
    }
    this.records.push({ ...copied, queuedAt: this.monotonicNow() });
    this.metrics.pendingRecords++;
    this.metrics.pendingBytes += copied.bytes;
    this.metrics.accepted++;
    this.metrics.peakRecords = Math.max(this.metrics.peakRecords, this.metrics.pendingRecords);
    this.metrics.peakBytes = Math.max(this.metrics.peakBytes, this.metrics.pendingBytes);
    // Schedule the writer after the caller's synchronous decision work.
    this.running ??= Promise.resolve().then(() => this.run());
    return 'QUEUED';
  }

  health(): Readonly<ObservationQueueHealth> {
    return { ...this.metrics };
  }

  /** Seals admission. A stalled observational sink cannot indefinitely delay durable shutdown. */
  async close(timeoutMs = 5000): Promise<void> {
    this.metrics.closed = true;
    if (!this.running) return;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0)
      throw new Error('OBSERVATION_DRAIN_TIMEOUT_INVALID');
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.running,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          this.metrics.drainTimedOut = true;
          // Keep the one in-flight record accounted for; never report its write as cancelled.
          for (const record of this.records.splice(1)) {
            this.metrics.pendingRecords--;
            this.metrics.pendingBytes -= record.bytes;
            this.metrics.dropped++;
          }
          resolve();
        }, timeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  private drop(): 'OBSERVATIONAL_DROP' {
    this.metrics.dropped++;
    return 'OBSERVATIONAL_DROP';
  }

  private async run(): Promise<void> {
    while (this.records.length) {
      const record = this.records[0];
      const start = this.monotonicNow();
      this.metrics.lastQueueWaitMs = start - record.queuedAt;
      try {
        await this.write(record.value);
        this.metrics.written++;
      } catch {
        this.metrics.failed++;
      } finally {
        this.metrics.lastWriteDurationMs = this.monotonicNow() - start;
        this.records.shift();
        this.metrics.pendingRecords--;
        this.metrics.pendingBytes -= record.bytes;
      }
    }
    this.running = undefined;
  }
}
