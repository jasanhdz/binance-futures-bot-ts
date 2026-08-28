import { Logger } from '../../app/ports/Logger';
import {
  MarketDataEndpointConfig,
  MarketDataEndpointDescriptor,
  resolveMarketDataEndpoint,
  streamWebSocketUrl,
} from './MarketDataEndpoints';
import { createWsWebSocket } from './WsWebSocketFactory';

export interface RawWebSocket {
  close(): void;
  onopen: ((event: any) => any) | null;
  onmessage: ((event: { data: unknown }) => any) | null;
  onerror: ((event: any) => any) | null;
  onclose: ((event: any) => any) | null;
}

export interface MarketDataHubConfig {
  endpoint?: MarketDataEndpointConfig;
  isTestnet?: boolean;
  watchdogTimeoutMs?: number;
  reconnectDelayMs?: number;
  webSocketFactory?: (url: string) => RawWebSocket;
}

export interface MarketDataStreamHealth {
  stream: string;
  consumers: number;
  status: 'connecting' | 'open' | 'reconnecting';
  lastMessageAtMs?: number;
  reconnectCount: number;
}

type StreamConnection = {
  consumers: Set<(message: any) => void>;
  socket?: RawWebSocket;
  status: 'connecting' | 'open' | 'reconnecting';
  lastMessageAtMs?: number;
  reconnectCount: number;
  reconnectTimer?: NodeJS.Timeout;
  intentionallyClosed: boolean;
  descriptor: MarketDataEndpointDescriptor;
};

const defaultWebSocketFactory = (url: string): RawWebSocket => createWsWebSocket(url);

/** Shares one raw stream socket per route and stream among its consumers. */
export class MarketDataHub {
  private readonly endpoint: MarketDataEndpointConfig;
  private readonly watchdogTimeoutMs: number;
  private readonly reconnectDelayMs: number;
  private readonly webSocketFactory: (url: string) => RawWebSocket;
  private readonly connections = new Map<string, StreamConnection>();
  private readonly watchdogTimer: NodeJS.Timeout;
  private closed = false;

  constructor(
    private readonly logger: Logger,
    config: MarketDataHubConfig = {},
  ) {
    this.endpoint = config.endpoint ?? resolveMarketDataEndpoint(config.isTestnet ?? false);
    this.watchdogTimeoutMs = config.watchdogTimeoutMs ?? 60_000;
    this.reconnectDelayMs = config.reconnectDelayMs ?? 5_000;
    this.webSocketFactory = config.webSocketFactory ?? defaultWebSocketFactory;
    this.watchdogTimer = setInterval(() => this.checkHealth(), 5_000);
  }

  public subscribe(
    stream: string,
    descriptor: MarketDataEndpointDescriptor,
    consumer: (message: any) => void,
  ): () => void {
    const key = `${descriptor.accessMode}:${stream}`;
    let connection = this.connections.get(key);
    if (!connection) {
      connection = {
        consumers: new Set(),
        status: 'connecting',
        intentionallyClosed: false,
        reconnectCount: 0,
        descriptor,
      };
      this.connections.set(key, connection);
    }
    connection.consumers.add(consumer);
    if (!connection.socket && !connection.reconnectTimer) this.open(key, stream, connection);

    return () => {
      const current = this.connections.get(key);
      if (!current) return;
      current.consumers.delete(consumer);
      if (current.consumers.size === 0) this.closeConnection(key, stream, current);
    };
  }

  public getHealth(): MarketDataStreamHealth[] {
    return [...this.connections.entries()].map(([key, connection]) => ({
      stream: key.slice(key.indexOf(':') + 1),
      consumers: connection.consumers.size,
      status: connection.status,
      lastMessageAtMs: connection.lastMessageAtMs,
      reconnectCount: connection.reconnectCount,
    }));
  }

  public reconnectAll(): void {
    for (const [key, connection] of this.connections) {
      this.reconnect(key, key.slice(key.indexOf(':') + 1), connection);
    }
  }

  public close(): void {
    this.closed = true;
    clearInterval(this.watchdogTimer);
    for (const [key, connection] of this.connections) {
      this.closeConnection(key, key.slice(key.indexOf(':') + 1), connection);
    }
  }

  private open(key: string, stream: string, connection: StreamConnection): void {
    if (this.closed || connection.consumers.size === 0) return;
    connection.intentionallyClosed = false;
    connection.status = 'connecting';
    try {
      const socket = this.webSocketFactory(
        streamWebSocketUrl(this.endpoint, stream, connection.descriptor),
      );
      connection.socket = socket;
      socket.onopen = () => {
        if (this.connections.get(key) !== connection) return;
        connection.status = 'open';
        connection.lastMessageAtMs = Date.now();
        this.logger.info('market_data_ws_open', { stream });
      };
      socket.onmessage = (event) => this.handleMessage(key, stream, connection, event.data);
      socket.onerror = (event) => {
        this.logger.warn('market_data_ws_error', { stream, error: String(event) });
      };
      socket.onclose = () => {
        if (this.connections.get(key) !== connection || connection.intentionallyClosed) return;
        this.scheduleReconnect(key, stream, connection);
      };
    } catch (error) {
      this.logger.error('market_data_ws_connect_failed', { stream, error: String(error) });
      this.scheduleReconnect(key, stream, connection);
    }
  }

  private handleMessage(
    key: string,
    stream: string,
    connection: StreamConnection,
    raw: unknown,
  ): void {
    if (this.connections.get(key) !== connection) return;
    try {
      const message = typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(String(raw));
      const receivedAtMs = Date.now();
      connection.lastMessageAtMs = receivedAtMs;
      for (const consumer of connection.consumers) {
        try {
          const payload = message.data ?? message;
          consumer(
            payload !== null && typeof payload === 'object'
              ? { ...payload, receivedAtMs }
              : payload,
          );
        } catch (error) {
          this.logger.error('market_data_consumer_failed', { stream, error: String(error) });
        }
      }
    } catch (error) {
      this.logger.warn('market_data_ws_invalid_message', { stream, error: String(error) });
    }
  }

  private checkHealth(): void {
    if (this.closed) return;
    const now = Date.now();
    for (const [key, connection] of this.connections) {
      const stream = key.slice(key.indexOf(':') + 1);
      if (
        connection.status === 'open' &&
        connection.lastMessageAtMs !== undefined &&
        now - connection.lastMessageAtMs > this.watchdogTimeoutMs
      ) {
        this.logger.warn('market_data_ws_stale', {
          stream,
          elapsed: now - connection.lastMessageAtMs,
        });
        this.reconnect(key, stream, connection);
      }
    }
  }

  private reconnect(key: string, stream: string, connection: StreamConnection): void {
    connection.intentionallyClosed = true;
    try {
      connection.socket?.close();
    } catch {
      // A failed close must not prevent the replacement connection.
    }
    connection.socket = undefined;
    connection.intentionallyClosed = false;
    this.scheduleReconnect(key, stream, connection);
  }

  private scheduleReconnect(key: string, stream: string, connection: StreamConnection): void {
    if (this.closed || connection.consumers.size === 0 || connection.reconnectTimer) return;
    connection.status = 'reconnecting';
    connection.reconnectCount++;
    connection.reconnectTimer = setTimeout(() => {
      connection.reconnectTimer = undefined;
      this.open(key, stream, connection);
    }, this.reconnectDelayMs);
  }

  private closeConnection(key: string, stream: string, connection: StreamConnection): void {
    connection.intentionallyClosed = true;
    if (connection.reconnectTimer) clearTimeout(connection.reconnectTimer);
    try {
      connection.socket?.close();
    } catch {
      // Cleanup is best-effort.
    }
    this.connections.delete(key);
  }
}
