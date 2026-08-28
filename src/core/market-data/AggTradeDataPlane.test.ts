import { describe, expect, it, vi } from 'vitest';
import { AggTradeDataPlane } from './AggTradeDataPlane';
import { RollingAggTradeBuffer } from './RollingAggTradeBuffer';
import type { AggTradeEvent } from '../../app/ports/MarketData';

const TRADE: AggTradeEvent = {
  eventTime: 1_700_000_000_000,
  receivedAtMs: 1_700_000_000_001,
  price: 100,
  quantity: 1,
  isBuyerMaker: false,
  aggregateTradeId: 1,
};

function source() {
  const callbacks = new Map<string, (event: AggTradeEvent) => void>();
  const statuses = new Map<string, (status: 'connecting' | 'open' | 'reconnecting') => void>();
  const unsubscribe = vi.fn((symbol: string) => {
    callbacks.delete(symbol);
    statuses.delete(symbol);
  });
  return {
    callbacks,
    statuses,
    unsubscribe,
    subscribe: vi.fn(
      (
        symbol: string,
        onEvent: (event: AggTradeEvent) => void,
        onStatus?: (status: 'connecting' | 'open' | 'reconnecting') => void,
      ) => {
        callbacks.set(symbol, onEvent);
        if (onStatus) statuses.set(symbol, onStatus);
        return () => unsubscribe(symbol);
      },
    ),
  };
}

describe('AggTradeDataPlane', () => {
  it('shares canonical state and one subscription across same-symbol leases', () => {
    const stream = source();
    const plane = new AggTradeDataPlane(
      () => new RollingAggTradeBuffer({ now: () => TRADE.eventTime }),
      stream,
    );
    const firstEvent = vi.fn();
    const first = plane.acquire('ethusdt', firstEvent);
    const second = plane.acquire('ETHUSDT');

    stream.callbacks.get('ETHUSDT')?.(TRADE);
    expect(first.state).toBe(second.state);
    expect(stream.subscribe).toHaveBeenCalledTimes(1);
    expect(first.state.getTakerFlow().tradeCount).toBe(1);
    expect(firstEvent).toHaveBeenCalledWith(TRADE);

    first.release();
    expect(stream.unsubscribe).not.toHaveBeenCalled();
    second.release();
    expect(stream.unsubscribe).toHaveBeenCalledTimes(1);
    expect(plane.get('ETHUSDT')).toBeUndefined();
    expect(plane.getReferenceCount('ETHUSDT')).toBe(0);
  });

  it('isolates symbols, shares reconnect uncertainty, and tolerates duplicate release', () => {
    const stream = source();
    const plane = new AggTradeDataPlane(
      () => new RollingAggTradeBuffer({ now: () => TRADE.eventTime }, 10, 5_000),
      stream,
    );
    const ethA = plane.acquire('ETHUSDT');
    const ethB = plane.acquire('ETHUSDT');
    const btc = plane.acquire('BTCUSDT');

    expect(ethA.state).toBe(ethB.state);
    expect(ethA.state).not.toBe(btc.state);
    stream.statuses.get('ETHUSDT')?.('reconnecting');
    expect(ethB.state.getTakerFlow().gapFree).toBe(true);
    expect(ethB.state.getTakerFlow().windowComplete).toBe(false);

    ethA.release();
    ethA.release();
    expect(plane.getReferenceCount('ETHUSDT')).toBe(1);
    ethB.release();
    btc.release();
  });

  it('cleans up synchronous startup failures and retries cleanly', () => {
    const stream = source();
    stream.subscribe.mockImplementationOnce(() => {
      throw new Error('subscription failed');
    });
    const plane = new AggTradeDataPlane(
      () => new RollingAggTradeBuffer({ now: () => TRADE.eventTime }),
      stream,
    );

    expect(() => plane.acquire('ETHUSDT')).toThrow('subscription failed');
    expect(plane.get('ETHUSDT')).toBeUndefined();
    expect(plane.getReferenceCount('ETHUSDT')).toBe(0);
    const lease = plane.acquire('ETHUSDT');
    expect(plane.getReferenceCount('ETHUSDT')).toBe(1);
    lease.release();
  });

  it('removes active entries when unsubscribe or close cleanup throws', () => {
    const stream = source();
    stream.unsubscribe.mockImplementation(() => {
      throw new Error('unsubscribe failed');
    });
    const plane = new AggTradeDataPlane(
      () => new RollingAggTradeBuffer({ now: () => TRADE.eventTime }),
      stream,
    );
    const lease = plane.acquire('ETHUSDT');
    expect(() => lease.release()).not.toThrow();
    expect(plane.getReferenceCount('ETHUSDT')).toBe(0);

    const active = plane.acquire('BTCUSDT');
    plane.close();
    expect(plane.get('BTCUSDT')).toBeUndefined();
    expect(() => active.release()).not.toThrow();
  });
});
