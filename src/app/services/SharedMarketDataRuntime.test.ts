import { describe, expect, it, vi } from 'vitest';
import { SharedMarketDataRuntime } from './SharedMarketDataRuntime';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe('SharedMarketDataRuntime', () => {
  it('owns one canonical AggTrade stream per symbol across multiple leases', () => {
    let subscriptions = 0;
    let unsubscriptions = 0;
    const exchange: any = {
      subscribeToAggTrades: (_symbol: string, _onEvent: unknown) => {
        subscriptions += 1;
        return () => {
          unsubscriptions += 1;
        };
      },
      getServerTime: async () => Date.now(),
    };
    const runtime = new SharedMarketDataRuntime({
      exchange,
      logger: logger as any,
      clock: { now: () => Date.now() },
    });

    const first = runtime.aggTradeDataPlane.acquire('btcusdt');
    const second = runtime.aggTradeDataPlane.acquire('BTCUSDT');

    expect(first.state).toBe(second.state);
    expect(runtime.aggTradeDataPlane.getReferenceCount('BTCUSDT')).toBe(2);
    expect(subscriptions).toBe(1);

    first.release();
    expect(runtime.aggTradeDataPlane.getReferenceCount('BTCUSDT')).toBe(1);
    expect(unsubscriptions).toBe(0);
    second.release();
    expect(runtime.aggTradeDataPlane.getReferenceCount('BTCUSDT')).toBe(0);
    expect(unsubscriptions).toBe(1);
  });
});
