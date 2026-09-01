import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SharedBinanceRateLimiter } from '../infra/adapters/shared-binance-rate-limit';
import { PublicKlineClient, SYMBOLS } from './shadow-service';

function candleResponse(): Response {
  return new Response(
    JSON.stringify([[1784634900000, '1', '2', '0.5', '1.5', '10', 1784635199999]]),
    { status: 200 },
  );
}

describe('prospective shadow public client', () => {
  it('uses the shared budget for all 11 symbols', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aegis-shadow-rate-limit-'));
    const limiter = new SharedBinanceRateLimiter('shadow-test', join(root, 'budget.sqlite3'));
    const client = new PublicKlineClient(async () => candleResponse(), 100, 1, limiter);

    await Promise.all(SYMBOLS.map((symbol) => client.candles(symbol, 1)));

    expect(limiter.getMetrics()).toMatchObject({ grants: 11, rateLimitEvents: 0 });
  });

  it('honors Retry-After and shares a 429 cooldown', async () => {
    const root = mkdtempSync(join(tmpdir(), 'aegis-shadow-rate-limit-'));
    const limiter = new SharedBinanceRateLimiter('shadow-test', join(root, 'budget.sqlite3'));
    let calls = 0;
    const client = new PublicKlineClient(async () => {
      calls += 1;
      return calls === 1
        ? new Response('limited', { status: 429, headers: { 'retry-after': '0.05' } })
        : candleResponse();
    }, 100, 2, limiter);

    await expect(client.candles('BTCUSDT', 1)).resolves.toHaveLength(1);
    expect(calls).toBe(2);
    expect(limiter.getMetrics()).toMatchObject({ grants: 2, rateLimitEvents: 1 });
  });
});
