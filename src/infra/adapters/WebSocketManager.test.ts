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
  it('maps market agg-trades and public depth-diffs without using binance-api-node market methods', () => {
    const sockets: FakeWebSocket[] = [];
    const urls: string[] = [];
    const hub = new MarketDataHub(logger, {
      webSocketFactory: (url) => {
        urls.push(url);
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    });
    const client = { ws: { futuresUser: vi.fn() } } as any;
    const manager = new WebSocketManager(client, logger, { marketDataHub: hub });
    const trade = vi.fn();
    const depth = vi.fn();

    const unsubscribeTrade = manager.connectAggTrades('BTCUSDT', trade);
    const unsubscribeDepth = manager.connectDepthDiff('BTCUSDT', '100ms', depth);
    expect(urls).toEqual([
      'wss://fstream.binance.com/market/ws/btcusdt@aggTrade',
      'wss://fstream.binance.com/public/ws/btcusdt@depth@100ms',
    ]);
    sockets[0].message({ m: false, q: '2', p: '100', E: 10, T: 9, a: 8, f: 7, l: 6 });
    sockets[1].message({ U: 1, u: 2, pu: 0, b: [['99', '3']], a: [['101', '4']], E: 10, T: 9 });

    expect(trade).toHaveBeenCalledWith(
      expect.objectContaining({ isBuyerMaker: false, quantity: '2', price: '100', tradeTime: 9 }),
    );
    expect(depth).toHaveBeenCalledWith(
      expect.objectContaining({ U: 1, u: 2, bids: [['99', '3']], asks: [['101', '4']] }),
    );

    unsubscribeTrade();
    sockets[0].message({ m: true, q: '3', p: '101' });
    expect(trade).toHaveBeenCalledTimes(1);

    unsubscribeDepth();
    manager.disconnectAll();
  });

  it('uses Binance-supported public partial depth levels', () => {
    const sockets: FakeWebSocket[] = [];
    const urls: string[] = [];
    const hub = new MarketDataHub(logger, {
      webSocketFactory: (url) => {
        urls.push(url);
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    });
    const manager = new WebSocketManager({ ws: { futuresUser: vi.fn() } } as any, logger, { marketDataHub: hub });
    const depth = vi.fn();

    const unsubscribe = manager.connectPartialDepth('BTCUSDT', 20, '100ms', depth);
    expect(urls).toEqual(['wss://fstream.binance.com/public/ws/btcusdt@depth20@100ms']);
    sockets[0].message({ b: [['99', '3']], a: [['101', '4']] });
    expect(depth).toHaveBeenCalledWith(expect.objectContaining({ bids: [['99', '3']], asks: [['101', '4']] }));
    expect(() => manager.connectPartialDepth('BTCUSDT', 50, '100ms', vi.fn())).toThrow(
      'Unsupported Binance partial-depth level: 50',
    );

    unsubscribe();
    manager.disconnectAll();
  });
});
