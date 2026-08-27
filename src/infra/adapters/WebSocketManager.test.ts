import { describe, expect, it, vi } from 'vitest';
import { Logger } from '../../app/ports/Logger';
import { MarketDataHub, RawWebSocket } from './MarketDataHub';
import { WebSocketManager } from './WebSocketManager';

class FakeWebSocket implements RawWebSocket {
  public onopen: ((event: unknown) => void) | null = null;
  public onmessage: ((event: { data: unknown }) => void) | null = null;
  public onerror: ((event: unknown) => void) | null = null;
  public onclose: ((event: unknown) => void) | null = null;
  public close(): void {}
  public message(value: unknown): void {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
}

const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe('WebSocketManager market subscriptions', () => {
  it('maps raw agg-trade and depth-diff payloads without using binance-api-node market methods', () => {
    const sockets: FakeWebSocket[] = [];
    const hub = new MarketDataHub(logger, {
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    });
    const client = { ws: { futuresUser: vi.fn() } } as any;
    const manager = new WebSocketManager(client, logger, { marketDataHub: hub });
    const trade = vi.fn();
    const depth = vi.fn();

    manager.connectAggTrades('BTCUSDT', trade);
    const unsubscribeDepth = manager.connectDepthDiff('BTCUSDT', '100ms', depth);
    sockets[0].message({ m: false, q: '2', p: '100', E: 10, T: 9, a: 8, f: 7, l: 6 });
    sockets[1].message({ U: 1, u: 2, pu: 0, b: [['99', '3']], a: [['101', '4']], E: 10, T: 9 });

    expect(trade).toHaveBeenCalledWith(
      expect.objectContaining({ isBuyerMaker: false, quantity: '2', price: '100', tradeTime: 9 }),
    );
    expect(depth).toHaveBeenCalledWith(
      expect.objectContaining({ U: 1, u: 2, bids: [['99', '3']], asks: [['101', '4']] }),
    );

    unsubscribeDepth();
    manager.disconnectAll();
  });
});
