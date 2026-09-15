import { performance } from 'node:perf_hooks';

/** UTC authority comes from Binance; elapsed time comes from a monotonic clock. */
export class MicroUtcClock {
  private static readonly SYNC_TIMEOUT_MS = 2_000;
  private anchor?: { server: number; monotonic: number };
  private pending = false;
  private nextRead = 0;
  private invalid = false;
  private synchronization?: Promise<void>;
  private synchronizationId = 0;
  private transport?: Promise<number>;

  constructor(
    private readonly readServerTime: (signal: AbortSignal) => Promise<number>,
    private readonly monotonic: () => number = () => performance.now(),
  ) {}

  async ready(): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        this.now();
        return;
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'MICRO_NET_LOSS_CLOCK_UNAVAILABLE')
          throw error;
      }
      await this.synchronization;
      if (!this.pending) continue;
      await this.transport?.catch(() => undefined);
    }
    throw new Error('MICRO_NET_LOSS_CLOCK_UNAVAILABLE');
  }

  now(): number {
    const at = this.monotonic();
    if (this.invalid || !Number.isFinite(at) || (this.anchor && at < this.anchor.monotonic)) {
      this.invalid = true;
      throw new Error('MICRO_NET_LOSS_CLOCK_INVALID');
    }
    if (!this.pending && at >= this.nextRead) {
      const synchronizationId = ++this.synchronizationId;
      this.pending = true;
      this.nextRead = at + 5_000;
      const controller = new AbortController();
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          controller.abort();
          reject(new Error('MICRO_NET_LOSS_CLOCK_SYNC_TIMEOUT'));
        }, MicroUtcClock.SYNC_TIMEOUT_MS);
      });
      this.transport = Promise.resolve().then(() => this.readServerTime(controller.signal));
      this.synchronization = Promise.race([this.transport, timeout])
        .then((server) => {
          const received = this.monotonic();
          if (!Number.isSafeInteger(server) || server < 0 || received < at) {
            this.invalid = true;
            return;
          }
          if (this.anchor) {
            const projected = this.anchor.server + received - this.anchor.monotonic;
            if (Math.abs(server - projected) > 5_000) {
              this.invalid = true;
              return;
            }
            if (received - at > MicroUtcClock.SYNC_TIMEOUT_MS) return;
            // Do not roll time back after network jitter; retain the conservative lower bound.
            this.anchor = { server: Math.max(server, Math.floor(projected)), monotonic: received };
          } else if (received - at <= MicroUtcClock.SYNC_TIMEOUT_MS) {
            this.anchor = { server, monotonic: received };
          }
          this.nextRead = received + 30_000;
        })
        .catch(() => {
          // Expired authority blocks new entries, not position management; retry after backoff.
        })
        .finally(() => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
        });
      void this.transport.then(
        () => {
          if (this.synchronizationId === synchronizationId) {
            this.pending = false;
            if (!this.anchor) this.nextRead = 0;
          }
        },
        () => {
          if (this.synchronizationId === synchronizationId) {
            this.pending = false;
            if (!this.anchor) this.nextRead = 0;
          }
        },
      );
    }
    if (!this.anchor || at - this.anchor.monotonic > 60_000)
      throw new Error('MICRO_NET_LOSS_CLOCK_UNAVAILABLE');
    return Math.floor(this.anchor.server + at - this.anchor.monotonic);
  }
}
