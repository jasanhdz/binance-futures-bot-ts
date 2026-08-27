export interface ClockDomains {
  /** Exchange/server event time, used for causal windows and ordering. */
  eventTimeMs: number;
  /** Local monotonic receive time, used for freshness and transport latency. */
  receivedAtMs: number;
}

export interface ServerOffsetEstimate {
  offsetMs: number;
  uncertaintyMs: number;
  samples: number;
}

export class ServerOffsetEstimator {
  private readonly samples: number[] = [];
  constructor(private readonly maxSamples = 9) {}
  observe(serverTimeMs: number, sentAtMs: number, receivedAtMs: number): void {
    if (
      !Number.isFinite(serverTimeMs) ||
      !Number.isFinite(sentAtMs) ||
      !Number.isFinite(receivedAtMs) ||
      receivedAtMs < sentAtMs
    )
      return;
    this.samples.push(serverTimeMs - (sentAtMs + receivedAtMs) / 2);
    if (this.samples.length > this.maxSamples) this.samples.shift();
  }
  estimate(): ServerOffsetEstimate {
    const values = [...this.samples].sort((a, b) => a - b);
    const offsetMs = values.length ? values[Math.floor(values.length / 2)] : 0;
    const uncertaintyMs = values.length
      ? Math.max(...values.map((v) => Math.abs(v - offsetMs)))
      : Number.POSITIVE_INFINITY;
    return { offsetMs, uncertaintyMs, samples: values.length };
  }
}

/** Returns no negative/impossible age when an event is ahead of the corrected server clock. */
export function eventAgeMs(
  nowReceivedAtMs: number,
  eventTimeMs: number,
  estimate: ServerOffsetEstimate,
): number | null {
  if (
    !Number.isFinite(nowReceivedAtMs) ||
    !Number.isFinite(eventTimeMs) ||
    !Number.isFinite(estimate.offsetMs)
  )
    return null;
  // offsetMs is server time minus local time, so convert server event time
  // back into the local clock before measuring receive age.
  return Math.max(0, nowReceivedAtMs - (eventTimeMs - estimate.offsetMs));
}
