import { afterEach, describe, expect, it } from 'vitest';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SharedBinanceRateLimiter } from './shared-binance-rate-limit';

const dbPath = join(tmpdir(), `shared-binance-rate-limit-test-${process.pid}.sqlite3`);

afterEach(() => {
  for (const suffix of ['', '-shm', '-wal']) {
    try { unlinkSync(`${dbPath}${suffix}`); } catch { /* test cleanup */ }
  }
});

describe('shared Binance rate limiter', () => {
  it('coordinates weighted grants across independent instances', async () => {
    const first = new SharedBinanceRateLimiter('first', dbPath);
    const second = new SharedBinanceRateLimiter('second', dbPath);

    await first.acquire(1_200, 'candles');
    await second.acquire(250, 'depth_snapshot');
    expect(first.getMetrics().availableWeight).toBeLessThan(500);
  });

  it('applies a shared cooldown and lets critical traffic use the reserve', async () => {
    const limiter = new SharedBinanceRateLimiter('test', dbPath);
    limiter.noteRateLimit(Date.now() + 100);
    const started = Date.now();
    await limiter.acquire(10, 'account', 'critical');
    expect(Date.now() - started).toBeGreaterThanOrEqual(75);
  });
});
