import { describe, expect, it, vi } from 'vitest';
import { Logger } from '../../app/ports/Logger';
import { MarketDataHub, RawWebSocket } from './MarketDataHub';
import {
  combinedStreamWebSocketUrl,
  MARKET,
  PUBLIC,
  resolveMarketDataEndpoint,
  streamWebSocketUrl,
} from './MarketDataEndpoints';

class FakeWebSocket implements RawWebSocket {
  public onopen: ((event: unknown) => void) | null = null;
  public onmessage: ((event: { data: unknown }) => void) | null = null;
  public onerror: ((event: unknown) => void) | null = null;
  public onclose: ((event: unknown) => void) | null = null;
  public closed = false;

  public close(): void {
    this.closed = true;
    this.onclose?.({});
  }

  public open(): void {
    this.onopen?.({});
  }

  public message(data: unknown): void {
    this.onmessage?.({ data });
  }
}

const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe('MarketDataHub', () => {
  it('uses explicit public and market routes for production and testnet', () => {
    expect(streamWebSocketUrl(resolveMarketDataEndpoint(false), 'btcusdt@depth@100ms', PUBLIC)).toBe(
      'wss://fstream.binance.com/public/ws/btcusdt@depth@100ms',
    );
    expect(streamWebSocketUrl(resolveMarketDataEndpoint(false), 'btcusdt@aggTrade', MARKET)).toBe(
      'wss://fstream.binance.com/market/ws/btcusdt@aggTrade',
    );
    expect(combinedStreamWebSocketUrl(resolveMarketDataEndpoint(false), ['btcusdt@kline_5m'], MARKET)).toBe(
      'wss://fstream.binance.com/market/stream?streams=btcusdt@kline_5m',
    );
    expect(streamWebSocketUrl(resolveMarketDataEndpoint(true), 'btcusdt@markPrice@1s', MARKET)).toBe(
      'wss://stream.binancefuture.com/market/ws/btcusdt@markPrice@1s',
    );
  });

  it('fans out one physical stream socket and closes it after the final consumer leaves', () => {
    const sockets: FakeWebSocket[] = [];
    const factory = vi.fn(() => {
      const socket = new FakeWebSocket();
      sockets.push(socket);
      return socket;
    });
    const hub = new MarketDataHub(logger, { webSocketFactory: factory });
    const first = vi.fn();
    const second = vi.fn();

    const unsubscribeFirst = hub.subscribe('btcusdt@aggTrade', MARKET, first);
    const unsubscribeSecond = hub.subscribe('btcusdt@aggTrade', MARKET, second);
    sockets[0].open();
    sockets[0].message(JSON.stringify({ p: '100' }));

    expect(factory).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledWith({ p: '100' });
    expect(second).toHaveBeenCalledWith({ p: '100' });
    expect(hub.getHealth()).toEqual([
      expect.objectContaining({ stream: 'btcusdt@aggTrade', consumers: 2, status: 'open' }),
    ]);

    unsubscribeFirst();
    expect(sockets[0].closed).toBe(false);
    unsubscribeSecond();
    expect(sockets[0].closed).toBe(true);
    expect(hub.getHealth()).toEqual([]);
    hub.close();
  });

  it('reconnects a closed stream while it still has consumers', () => {
    vi.useFakeTimers();
    const sockets: FakeWebSocket[] = [];
    const hub = new MarketDataHub(logger, {
      reconnectDelayMs: 50,
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    });

    hub.subscribe('btcusdt@kline_5m', MARKET, vi.fn());
    sockets[0].open();
    sockets[0].close();
    expect(hub.getHealth()[0]).toEqual(expect.objectContaining({ status: 'reconnecting' }));

    vi.advanceTimersByTime(50);
    expect(sockets).toHaveLength(2);
    hub.close();
    vi.useRealTimers();
  });
});
