import { describe, expect, it, vi } from 'vitest';
import { createWsWebSocket, WsSocket } from './WsWebSocketFactory';

class FakeWsSocket implements WsSocket {
  private readonly listeners = new Map<string, (...args: any[]) => void>();
  public closed = false;

  public close(): void {
    this.closed = true;
  }

  public on(event: 'open' | 'message' | 'error' | 'close', listener: (...args: any[]) => void): void {
    this.listeners.set(event, listener);
  }

  public emit(event: 'open' | 'message' | 'error' | 'close', ...args: any[]): void {
    this.listeners.get(event)?.(...args);
  }
}

describe('createWsWebSocket', () => {
  it('maps ws open, message, error, and close events to raw socket handlers', () => {
    const socket = new FakeWsSocket();
    const rawSocket = createWsWebSocket('ws://example.test', () => socket);
    const onopen = vi.fn();
    const onmessage = vi.fn();
    const onerror = vi.fn();
    const onclose = vi.fn();
    rawSocket.onopen = onopen;
    rawSocket.onmessage = onmessage;
    rawSocket.onerror = onerror;
    rawSocket.onclose = onclose;

    const error = new Error('connection failed');
    const reason = Buffer.from('normal closure');
    socket.emit('open');
    socket.emit('message', Buffer.from('{"price":"100"}'));
    socket.emit('error', error);
    socket.emit('close', 1000, reason);

    expect(onopen).toHaveBeenCalledWith({});
    expect(onmessage).toHaveBeenCalledWith({ data: Buffer.from('{"price":"100"}') });
    expect(onerror).toHaveBeenCalledWith(error);
    expect(onclose).toHaveBeenCalledWith({ code: 1000, reason });

    rawSocket.close();
    expect(socket.closed).toBe(true);
  });

  it('is available when no global WebSocket is defined', () => {
    const originalWebSocket = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
    Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: undefined });

    try {
      const socket = createWsWebSocket('ws://127.0.0.1:0');
      expect(socket).toBeDefined();
      socket.close();
    } finally {
      if (originalWebSocket) Object.defineProperty(globalThis, 'WebSocket', originalWebSocket);
      else delete (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
    }
  });
});
