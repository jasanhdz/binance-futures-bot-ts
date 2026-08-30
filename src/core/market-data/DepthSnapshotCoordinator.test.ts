import { describe, expect, it } from 'vitest';
import { DepthSnapshotCoordinator } from './DepthSnapshotCoordinator';

function testClock(offset = 1_000_000_000_000) {
  let current = Date.now() + offset;
  return {
    clock: { now: () => current },
    sleep: async (ms: number) => { current += ms; },
  };
}

describe('DepthSnapshotCoordinator', () => {
  it('coalesces same-symbol requests and staggers weighted startup snapshots', async () => {
    const time = testClock();
    const calls: string[] = [];
    const coordinator = new DepthSnapshotCoordinator(
      async (symbol) => { calls.push(symbol); return { symbol }; },
      {},
      { ...time, jitterMs: 0 },
    );

    const sameA = coordinator.request('ETHUSDT');
    const sameB = coordinator.request('ETHUSDT');
    const all = await Promise.all([
      sameA,
      sameB,
      ...['BTCUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'SUIUSDT', 'LTCUSDT']
        .map((symbol) => coordinator.request(symbol)),
    ]);

    expect(all).toHaveLength(12);
    expect(calls).toHaveLength(11);
    expect(coordinator.getWeightUsed()).toBe(220);
    expect(coordinator.getMetrics()).toMatchObject({
      requests: 12,
      coalesced: 1,
      successes: 11,
      totalWeight: 220,
      maxWeightPerMinute: 220,
    });
    coordinator.close();
  });

  it('opens a global circuit on 429 and performs no REST calls while open', async () => {
    const time = testClock();
    let calls = 0;
    const coordinator = new DepthSnapshotCoordinator(
      async () => { calls++; throw { status: 429, response: { headers: { 'retry-after': '10' } } }; },
      {},
      { ...time, jitterMs: 0 },
    );
    await expect(coordinator.request('BTCUSDT')).rejects.toMatchObject({ status: 429 });
    await expect(coordinator.request('ETHUSDT')).rejects.toThrow('DEPTH_SNAPSHOT_CIRCUIT_OPEN');
    expect(calls).toBe(1);
    expect(coordinator.getMetrics()).toMatchObject({
      blocked: 1,
      failures: 1,
      circuitBreakerActivations: 1,
      requestsExecutedDuringBan: 0,
    });
    coordinator.close();
  });

  it('honors an HTTP 418 banUntil without probing during the ban', async () => {
    const time = testClock(3_000_000_000_000);
    let calls = 0;
    const coordinator = new DepthSnapshotCoordinator(
      async () => { calls++; throw new Error('Way too many requests; IP banned until ' + (time.clock.now() + 20_000)); },
      {},
      { ...time, jitterMs: 0 },
    );
    await expect(coordinator.request('BTCUSDT')).rejects.toThrow('Way too many requests');
    await expect(coordinator.request('ETHUSDT')).rejects.toThrow('DEPTH_SNAPSHOT_CIRCUIT_OPEN');
    expect(calls).toBe(1);
    expect(coordinator.getMetrics()).toMatchObject({
      blocked: 1,
      circuitBreakerActivations: 1,
      requestsExecutedDuringBan: 0,
    });
    coordinator.close();
  });

  it('backs off repeated failures and cleans pending work on close', async () => {
    const time = testClock(4_000_000_000_000);
    let calls = 0;
    const coordinator = new DepthSnapshotCoordinator(
      async () => { calls++; throw new Error('snapshot failed'); },
      {},
      { ...time, jitterMs: 0 },
    );
    const first = coordinator.request('BTCUSDT');
    await expect(first).rejects.toThrow('snapshot failed');
    const second = coordinator.request('BTCUSDT');
    coordinator.close();
    await expect(second).rejects.toThrow('COORDINATOR_CLOSED');
    expect(calls).toBe(1);
  });

  it('recovers pending symbols gradually after a circuit breaker', async () => {
    let current = Date.now() + 5_000_000_000_000;
    const calls: string[] = [];
    let first = true;
    const coordinator = new DepthSnapshotCoordinator(
      async (symbol) => {
        calls.push(symbol);
        if (first) {
          first = false;
          throw { status: 429, response: { headers: { 'retry-after': '0' } } };
        }
        return { symbol };
      },
      {},
      { clock: { now: () => current }, sleep: async (ms) => { current += ms; }, jitterMs: 0 },
    );

    const requests = ['ETHUSDT', 'BTCUSDT', 'SOLUSDT'].map((symbol) => coordinator.request(symbol));
    await expect(requests[0]).rejects.toMatchObject({ status: 429 });
    current += 2_000;
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(Promise.all(requests.slice(1))).resolves.toHaveLength(2);

    expect(calls).toEqual(['ETHUSDT', 'BTCUSDT', 'SOLUSDT']);
    expect(coordinator.getMetrics()).toMatchObject({
      successes: 2,
      failures: 1,
      circuitBreakerActivations: 1,
      maxWeightPerMinute: 60,
      requestsExecutedDuringBan: 0,
    });
    coordinator.close();
  });

  it('isolates a repeatedly failing symbol from healthy symbols and closes its pending work', async () => {
    const time = testClock(6_000_000_000_000);
    const calls: string[] = [];
    const coordinator = new DepthSnapshotCoordinator(
      async (symbol) => {
        calls.push(symbol);
        if (symbol === 'BADUSDT') throw new Error('bad snapshot');
        return { symbol };
      },
      {},
      { ...time, jitterMs: 0 },
    );

    const bad = coordinator.request('BADUSDT');
    const good = coordinator.request('GOODUSDT');
    await expect(bad).rejects.toThrow('bad snapshot');
    await expect(good).resolves.toMatchObject({ symbol: 'GOODUSDT' });

    const retry = coordinator.request('BADUSDT');
    coordinator.close();
    await expect(retry).rejects.toThrow('COORDINATOR_CLOSED');
    expect(calls).toEqual(['BADUSDT', 'GOODUSDT']);
    expect(coordinator.getMetrics().symbols.BADUSDT).toMatchObject({ failures: 1 });
  });

  it('keeps a sliding-window boundary within the hard weighted budget', async () => {
    const time = testClock(7_000_000_000_000);
    const coordinator = new DepthSnapshotCoordinator(
      async (symbol) => ({ symbol }),
      {},
      { ...time, jitterMs: 0 },
    );
    const requests = Array.from({ length: 61 }, (_, index) => coordinator.request(`S${index}USDT`));

    await expect(Promise.all(requests)).resolves.toHaveLength(61);
    expect(coordinator.getMetrics().maxWeightPerMinute).toBeLessThanOrEqual(1_200);
    expect(coordinator.getMetrics().totalWeight).toBe(1_220);
    coordinator.close();
  });
});
