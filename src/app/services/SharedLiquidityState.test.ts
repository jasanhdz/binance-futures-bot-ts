import { describe, expect, it, vi } from 'vitest';
import { SharedLiquidityState } from './SharedLiquidityState';

describe('SharedLiquidityState', () => {
  it('produces shared depth20 safety evidence, fails closed on gaps and releases leases', () => {
    let now = 100_000;
    let health = 'HEALTHY';
    const snapshot = {
      observedAtMs: now,
      bidDepth: Array.from({ length: 25 }, (_, i) => ({ price: 100 - i, qty: 1 })),
      askDepth: Array.from({ length: 25 }, (_, i) => ({ price: 101 + i, qty: 1 })),
    };
    const release = vi.fn();
    const plane = {
      acquire: vi.fn(() => ({ release })),
      get: vi.fn(() => ({ getHealth: () => health, getSnapshot: () => snapshot })),
    };
    const state = new SharedLiquidityState({
      sharedMarketData: { orderBookDataPlane: plane } as never,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      clock: { now: () => now },
    });
    try {
      expect(state.read('ETHUSDT', now, 3_000).status).toBe('NO_DATA');
      state.start(['ethusdt', 'ETHUSDT']);
      expect(plane.acquire).toHaveBeenCalledTimes(1);
      expect(state.read('ETHUSDT', now, 3_000)).toMatchObject({
        status: 'FRESH',
        stress: 0,
        lastReceivedAtMs: now,
      });
      now += 3_001;
      expect(state.read('ETHUSDT', now, 3_000).status).toBe('STALE');
      snapshot.observedAtMs = now;
      expect(state.read('ETHUSDT', now, 3_000).status).toBe('FRESH');
      health = 'RESYNCING';
      expect(state.read('ETHUSDT', now, 3_000).status).toBe('NO_DATA');
      health = 'HEALTHY';
      snapshot.observedAtMs = now + 1;
      expect(state.read('ETHUSDT', now, 3_000).status).toBe('STALE');
    } finally {
      state.close();
    }
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('does not resample an unchanged book and erase liquidity disappearance stress', () => {
    let now = 100_000;
    const levels = (qty: number) => Array.from({ length: 20 }, (_, i) => ({ price: 100 + i, qty }));
    let snapshot = { observedAtMs: now, bidDepth: levels(10), askDepth: levels(10) };
    const state = new SharedLiquidityState({
      sharedMarketData: {
        orderBookDataPlane: {
          acquire: () => ({ release: vi.fn() }),
          get: () => ({ getHealth: () => 'HEALTHY', getSnapshot: () => snapshot }),
        },
      } as never,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      clock: { now: () => now },
    });
    try {
      state.start(['ETHUSDT']);
      state.read('ETHUSDT', now, 3_000);
      now += 100;
      snapshot = { observedAtMs: now, bidDepth: levels(1), askDepth: levels(1) };
      expect(state.read('ETHUSDT', now, 3_000).stress).toBe(0.6);
      expect(state.read('ETHUSDT', now + 100, 3_000).stress).toBe(0.6);
    } finally {
      state.close();
    }
  });
});
