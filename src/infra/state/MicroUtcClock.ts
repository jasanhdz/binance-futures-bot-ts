import { performance } from 'node:perf_hooks';

/** UTC authority comes from Binance; elapsed time comes from a monotonic clock. */
export class MicroUtcClock {
  private anchor?: { server: number; monotonic: number };
  private pending = false;
  private nextRead = 0;
  private invalid = false;
  private synchronization?: Promise<void>;

  constructor(
    private readonly readServerTime: () => Promise<number>,
    private readonly monotonic: () => number = () => performance.now(),
  ) {}

  async ready(): Promise<void> {
    try {
      this.now();
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'MICRO_NET_LOSS_CLOCK_UNAVAILABLE')
        throw error;
    }
    await this.synchronization;
    this.now();
  }

  now(): number {
    const at = this.monotonic();
    if (this.invalid || !Number.isFinite(at) || (this.anchor && at < this.anchor.monotonic)) {
      this.invalid = true;
      throw new Error('MICRO_NET_LOSS_CLOCK_INVALID');
    }
    if (!this.pending && at >= this.nextRead) {
      this.pending = true;
      this.nextRead = at + 5_000;
      this.synchronization = Promise.resolve()
        .then(this.readServerTime)
        .then((server) => {
          const received = this.monotonic();
          if (
            !Number.isSafeInteger(server) ||
            server < 0 ||
            received < at ||
            received - at > 2_000
          ) {
            this.invalid = true;
            return;
          }
          if (this.anchor) {
            const projected = this.anchor.server + received - this.anchor.monotonic;
            if (Math.abs(server - projected) > 5_000) {
              this.invalid = true;
              return;
            }
            // Do not roll time back after network jitter; retain the conservative lower bound.
            this.anchor = { server: Math.max(server, Math.floor(projected)), monotonic: received };
          } else this.anchor = { server, monotonic: received };
          this.nextRead = received + 30_000;
        })
        .catch(() => {
          // Expired authority blocks new entries, not position management; retry after backoff.
        })
        .finally(() => {
          this.pending = false;
        });
    }
    if (!this.anchor || at - this.anchor.monotonic > 60_000)
      throw new Error('MICRO_NET_LOSS_CLOCK_UNAVAILABLE');
    return Math.floor(this.anchor.server + at - this.anchor.monotonic);
  }
}
