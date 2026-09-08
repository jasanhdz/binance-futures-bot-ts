import { describe, expect, it, vi } from 'vitest';
import { defaultMicroBurstConfig } from '../domain/MicroBurstTypes';
import { readMicroBurstNextObstacle } from './MicroBurstLiveExitEvidence';

function fixture() {
  const candles = [101, 102, 105, 102, 101, 103, 101].map((high, i) => ({
    openTime: 1_700_000_000_000 + i * 300_000,
    closeTime: 1_700_000_000_000 + (i + 1) * 300_000 - 1,
    timestamp: 1_700_000_000_000 + i * 300_000,
    buyVolume: 500,
    open: 100,
    close: 100,
    high,
    low: 200 - high,
    volume: 1000,
  }));
  const exchange = { getCandles: vi.fn(async () => candles) };
  const config = {
    ...defaultMicroBurstConfig(),
    srPivotLeftBars: 2,
    srPivotRightBars: 2,
    srMinStrength: 0,
    srClusterToleranceBps: 1,
  };
  return { candles, exchange, config, now: candles[6].closeTime + 1 };
}

describe('Micro live confirmed obstacle evidence', () => {
  it.each(['LONG', 'SHORT'] as const)(
    'supplies the next opposing %s obstacle from closed 5m candles',
    async (side) => {
      const f = fixture();
      expect(
        await readMicroBurstNextObstacle(
          f.exchange,
          'ETHUSDT',
          side,
          side === 'LONG' ? 102 : 98,
          f.config,
          f.now,
        ),
      ).toEqual({ price: side === 'LONG' ? 105 : 95, availableAtMs: f.candles[4].closeTime });
    },
  );
  it.each(['stale', 'gap', 'future-confirmation', 'unavailable'])(
    'does not invent an obstacle for %s data',
    async (fault) => {
      const f = fixture();
      if (fault === 'gap') f.candles.splice(1, 1);
      if (fault === 'unavailable') f.exchange.getCandles.mockRejectedValue(new Error('offline'));
      const now =
        fault === 'stale'
          ? f.now + 3_600_000
          : fault === 'future-confirmation'
            ? f.candles[4].closeTime
            : f.now;
      expect(
        await readMicroBurstNextObstacle(f.exchange, 'ETHUSDT', 'LONG', 102, f.config, now),
      ).toBeUndefined();
    },
  );
});
