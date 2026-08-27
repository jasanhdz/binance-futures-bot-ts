import WebSocket from 'ws';
import type { RawWebSocket } from './MarketDataHub';

export interface WsSocket {
  close(): void;
  on(event: 'open', listener: () => void): void;
  on(event: 'message', listener: (data: unknown) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  on(event: 'close', listener: (code: number, reason: Buffer) => void): void;
}

export function createWsWebSocket(
  url: string,
  createSocket: (url: string) => WsSocket = (address) => new WebSocket(address),
): RawWebSocket {
  const socket = createSocket(url);
  const rawSocket: RawWebSocket = {
    close: () => socket.close(),
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
  };

  socket.on('open', () => rawSocket.onopen?.({}));
  socket.on('message', (data) => rawSocket.onmessage?.({ data }));
  socket.on('error', (error) => rawSocket.onerror?.(error));
  socket.on('close', (code, reason) => rawSocket.onclose?.({ code, reason }));

  return rawSocket;
}
