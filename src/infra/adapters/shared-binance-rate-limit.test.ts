import { afterEach, describe, expect, it } from 'vitest';
import { unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
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

  it('coordinates concurrent writers from separate node processes', async () => {
    const modulePath = join(process.cwd(), 'src/infra/adapters/shared-binance-rate-limit.js');
    const script = `
      const { SharedBinanceRateLimiter } = require(process.argv[1]);
      const limiter = new SharedBinanceRateLimiter(process.argv[3], process.argv[2]);
      (async () => {
        for (let i = 0; i < 40; i += 1) await limiter.acquire(1, 'concurrent_test');
      })().catch((error) => { console.error(error); process.exitCode = 1; });
    `;
    const run = (name: string) =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', script, modulePath, dbPath, name], {
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (chunk) => { stderr += String(chunk); });
        child.once('error', reject);
        child.once('exit', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`child exited ${code}: ${stderr}`));
        });
      });

    await Promise.all([run('child-a'), run('child-b')]);
    expect(new SharedBinanceRateLimiter('assertion', dbPath).getMetrics().rateLimitEvents).toBe(0);
    const db = new Database(dbPath, { readonly: true });
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM binance_rate_limit_events WHERE endpoint = 'concurrent_test'").get(),
    ).toEqual({ count: 80 });
    db.close();
  });

  it.each(['SQLITE_BUSY', 'SQLITE_LOCKED'])('bounds retries for %s', (code) => {
    const limiter = new SharedBinanceRateLimiter('retry-test', dbPath) as SharedBinanceRateLimiter & {
      runWithBusyRetry<T>(transaction: () => T): T;
    };
    let attempts = 0;

    expect(() =>
      limiter.runWithBusyRetry(() => {
        attempts += 1;
        throw Object.assign(new Error(code), { code });
      }),
    ).toThrow(code);
    expect(attempts).toBe(6);
  });
});
