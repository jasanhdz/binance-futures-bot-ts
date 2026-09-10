import { describe, expect, it, vi } from 'vitest';
import { MicroUtcClock } from './MicroUtcClock';

describe('Micro Binance UTC authority', () => {
  it('requires exchange authority and advances across midnight using monotonic time', async () => {
    let monotonic = 0;
    const read = vi.fn(async () => 86_399_999);
    const clock = new MicroUtcClock(read, () => monotonic);
    expect(() => clock.now()).toThrow('CLOCK_UNAVAILABLE');
    await vi.waitFor(() => expect(clock.now()).toBe(86_399_999));
    monotonic = 1;
    expect(clock.now()).toBe(86_400_000);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('expires failed reads without manufacturing a new day and retries authority', async () => {
    let monotonic = 0;
    const read = vi.fn(async () => 100_000);
    const clock = new MicroUtcClock(read, () => monotonic);
    expect(() => clock.now()).toThrow('CLOCK_UNAVAILABLE');
    await vi.waitFor(() => expect(clock.now()).toBe(100_000));
    read.mockRejectedValue(new Error('offline'));
    monotonic = 60_001;
    expect(() => clock.now()).toThrow('CLOCK_UNAVAILABLE');
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    read.mockResolvedValue(170_000);
    monotonic = 70_000;
    expect(() => clock.now()).toThrow('CLOCK_UNAVAILABLE');
    await vi.waitFor(() => expect(clock.now()).toBe(170_000));
  });

  it.each([1, 200_000])('fails closed on a refreshed exchange clock jump to %s', async (server) => {
    let monotonic = 0;
    const read = vi.fn(async () => 100_000);
    const clock = new MicroUtcClock(read, () => monotonic);
    expect(() => clock.now()).toThrow('CLOCK_UNAVAILABLE');
    await vi.waitFor(() => expect(clock.now()).toBe(100_000));
    monotonic = 30_000;
    read.mockResolvedValue(server);
    clock.now();
    await vi.waitFor(() => expect(() => clock.now()).toThrow('CLOCK_INVALID'));
  });

  it('rejects slow initial authority rather than using a stale sample', async () => {
    let monotonic = 0;
    const clock = new MicroUtcClock(
      async () => {
        monotonic = 2_001;
        return 100_000;
      },
      () => monotonic,
    );
    expect(() => clock.now()).toThrow('CLOCK_UNAVAILABLE');
    await vi.waitFor(() => expect(() => clock.now()).toThrow('CLOCK_INVALID'));
  });
});
