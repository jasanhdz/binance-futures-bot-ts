import { describe, expect, it, vi } from 'vitest';
import { Logger } from '../../app/ports/Logger';
import { MARKET } from './MarketDataEndpoints';
import { CombinedMarketDataHub } from './CombinedMarketDataHub';
import { RawWebSocket } from './MarketDataHub';

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

  public message(value: unknown): void {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
}

const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe('CombinedMarketDataHub', () => {
  it('records a current socket close and ignores obsolete close callbacks', () => {
    vi.useFakeTimers();
    const socket = new FakeWebSocket();
    const warn = vi.fn();
    const hub = new CombinedMarketDataHub(
      { ...logger, warn },
      {
        webSocketFactory: () => socket,
      },
    );
    try {
      hub.subscribe('btcusdt@aggTrade', MARKET, vi.fn());
      vi.advanceTimersByTime(0);
      socket.open();
      socket.onclose?.({ code: 1006 });
      expect(warn).toHaveBeenCalledWith(
        'market_data_combined_ws_closed',
        expect.objectContaining({ code: 1006, generation: 1, streams: ['btcusdt@aggTrade'] }),
      );
      socket.onclose?.({ code: 1000 });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      hub.close();
      vi.useRealTimers();
    }
  });
  it('opens one combined socket for streams subscribed in the same turn', () => {
    vi.useFakeTimers();
    const sockets: FakeWebSocket[] = [];
    const urls: string[] = [];
    const hub = new CombinedMarketDataHub(logger, {
      reconnectDelayMs: 50,
      webSocketFactory: (url) => {
        urls.push(url);
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    });
    const first = vi.fn();
    const second = vi.fn();

    hub.subscribe('btcusdt@aggTrade', MARKET, first);
    hub.subscribe('ethusdt@aggTrade', MARKET, second);
    vi.advanceTimersByTime(0);

    expect(sockets).toHaveLength(1);
    expect(urls[0]).toContain('btcusdt@aggTrade/ethusdt@aggTrade');
    sockets[0].open();
    expect(hub.getHealth()).toEqual([
      expect.objectContaining({
        stream: 'btcusdt@aggTrade',
        status: 'open',
        lastMessageAtMs: undefined,
      }),
      expect.objectContaining({
        stream: 'ethusdt@aggTrade',
        status: 'open',
        lastMessageAtMs: undefined,
      }),
    ]);

    sockets[0].message({ stream: 'btcusdt@aggTrade', data: { p: '100' } });
    expect(first).toHaveBeenCalledWith(
      expect.objectContaining({ p: '100', receivedAtMs: expect.any(Number) }),
    );
    expect(second).not.toHaveBeenCalled();
    hub.close();
    vi.useRealTimers();
  });

  it('replaces an open socket when a new stream is added and ignores stale callbacks', () => {
    vi.useFakeTimers();
    const sockets: FakeWebSocket[] = [];
    const hub = new CombinedMarketDataHub(logger, {
      reconnectDelayMs: 50,
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    });
    const btc = vi.fn();
    const eth = vi.fn();

    hub.subscribe('btcusdt@aggTrade', MARKET, btc);
    vi.advanceTimersByTime(0);
    sockets[0].open();
    hub.subscribe('ethusdt@aggTrade', MARKET, eth);
    vi.advanceTimersByTime(0);

    expect(sockets).toHaveLength(2);
    expect(sockets[0].closed).toBe(true);
    sockets[0].message({ stream: 'btcusdt@aggTrade', data: { p: 'stale' } });
    sockets[0].onclose?.({});
    expect(btc).not.toHaveBeenCalled();

    sockets[1].open();
    sockets[1].message({ stream: 'btcusdt@aggTrade', data: { p: '100' } });
    sockets[1].message({ stream: 'ethusdt@aggTrade', data: { p: '200' } });
    expect(btc).toHaveBeenCalledWith(expect.objectContaining({ p: '100' }));
    expect(eth).toHaveBeenCalledWith(expect.objectContaining({ p: '200' }));
    vi.advanceTimersByTime(50);
    expect(sockets).toHaveLength(2);
    hub.close();
    vi.useRealTimers();
  });

  it('reconnects the route once and does not let the old socket schedule another reconnect', () => {
    vi.useFakeTimers();
    const sockets: FakeWebSocket[] = [];
    const statuses: string[] = [];
    const hub = new CombinedMarketDataHub(logger, {
      reconnectDelayMs: 50,
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    });

    hub.subscribe('btcusdt@aggTrade', MARKET, vi.fn(), (status) => statuses.push(status));
    vi.advanceTimersByTime(0);
    sockets[0].open();
    hub.reconnectAll();
    expect(sockets[0].closed).toBe(true);
    expect(statuses).toContain('reconnecting');
    vi.advanceTimersByTime(50);
    expect(sockets).toHaveLength(2);
    sockets[0].onclose?.({});
    vi.advanceTimersByTime(50);
    expect(sockets).toHaveLength(2);
    hub.close();
    vi.useRealTimers();
  });

  it('reconnects streams that never receive their first message', () => {
    vi.useFakeTimers();
    const sockets: FakeWebSocket[] = [];
    const hub = new CombinedMarketDataHub(logger, {
      watchdogTimeoutMs: 10,
      reconnectDelayMs: 5,
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    });

    hub.subscribe('btcusdt@aggTrade', MARKET, vi.fn());
    vi.advanceTimersByTime(0);
    sockets[0].open();
    vi.advanceTimersByTime(5_000);
    expect(hub.getHealth()[0]?.reconnectCount).toBeGreaterThan(0);
    hub.close();
    vi.useRealTimers();
  });

  it('reconnects when a socket reports an error without closing', () => {
    vi.useFakeTimers();
    const sockets: FakeWebSocket[] = [];
    const statuses: string[] = [];
    const hub = new CombinedMarketDataHub(logger, {
      reconnectDelayMs: 5,
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    });

    hub.subscribe('btcusdt@aggTrade', MARKET, vi.fn(), (status) => statuses.push(status));
    vi.advanceTimersByTime(0);
    sockets[0].open();
    sockets[0].onerror?.(new Error('socket failed'));

    expect(statuses).toContain('reconnecting');
    vi.advanceTimersByTime(5);
    expect(sockets).toHaveLength(2);
    hub.close();
    vi.useRealTimers();
  });

  it('reconnects a socket that never completes the open handshake', () => {
    vi.useFakeTimers();
    const sockets: FakeWebSocket[] = [];
    const hub = new CombinedMarketDataHub(logger, {
      watchdogTimeoutMs: 10,
      reconnectDelayMs: 5,
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    });

    hub.subscribe('btcusdt@aggTrade', MARKET, vi.fn());
    vi.advanceTimersByTime(0);
    vi.advanceTimersByTime(10);
    expect(hub.getHealth()[0]).toEqual(
      expect.objectContaining({ status: 'reconnecting', reconnectCount: 1 }),
    );
    vi.advanceTimersByTime(5);
    expect(sockets).toHaveLength(2);
    hub.close();
    vi.useRealTimers();
  });

  it('keeps a combined route open when another subscribed stream is legitimately quiet', () => {
    vi.useFakeTimers();
    const sockets: FakeWebSocket[] = [];
    const hub = new CombinedMarketDataHub(logger, {
      watchdogTimeoutMs: 1_500,
      reconnectDelayMs: 5,
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
    });

    hub.subscribe('btcusdt@aggTrade', MARKET, vi.fn());
    hub.subscribe('ltcusdt@aggTrade', MARKET, vi.fn());
    vi.advanceTimersByTime(0);
    sockets[0].open();

    vi.advanceTimersByTime(4_000);
    sockets[0].message({ stream: 'btcusdt@aggTrade', data: { p: '100' } });
    vi.advanceTimersByTime(1_000);

    expect(sockets).toHaveLength(1);
    expect(sockets[0].closed).toBe(false);
    expect(hub.getHealth()).toEqual([
      expect.objectContaining({ stream: 'btcusdt@aggTrade', status: 'open' }),
      expect.objectContaining({
        stream: 'ltcusdt@aggTrade',
        status: 'open',
        lastMessageAtMs: undefined,
      }),
    ]);
    hub.close();
    vi.useRealTimers();
  });
});
