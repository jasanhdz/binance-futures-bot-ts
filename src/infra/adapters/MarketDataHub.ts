import { Logger } from '../../app/ports/Logger';
import {
  MarketDataEndpointConfig,
  resolveMarketDataEndpoint,
  streamWebSocketUrl,
} from './MarketDataEndpoints';

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
}

type StreamConnection = {
  consumers: Set<(message: any) => void>;
  socket?: RawWebSocket;
  status: 'connecting' | 'open' | 'reconnecting';
  lastMessageAtMs?: number;
  reconnectTimer?: NodeJS.Timeout;
  intentionallyClosed: boolean;
};

const defaultWebSocketFactory = (url: string): RawWebSocket => {
  if (typeof WebSocket === 'undefined') {
    throw new Error('Global WebSocket is unavailable; provide a raw WebSocket implementation');
  }
  return new WebSocket(url) as unknown as RawWebSocket;
};

/** Shares one raw public stream socket among all consumers of that stream. */
export class MarketDataHub {
  private readonly endpoint: MarketDataEndpointConfig;
  private readonly watchdogTimeoutMs: number;
  private readonly reconnectDelayMs: number;
  private readonly webSocketFactory: (url: string) => RawWebSocket;
  private readonly connections = new Map<string, StreamConnection>();
  private readonly watchdogTimer: NodeJS.Timeout;
  private closed = false;

  constructor(private readonly logger: Logger, config: MarketDataHubConfig = {}) {
    this.endpoint = config.endpoint ?? resolveMarketDataEndpoint(config.isTestnet ?? false);
    this.watchdogTimeoutMs = config.watchdogTimeoutMs ?? 60_000;
    this.reconnectDelayMs = config.reconnectDelayMs ?? 5_000;
    this.webSocketFactory = config.webSocketFactory ?? defaultWebSocketFactory;
    this.watchdogTimer = setInterval(() => this.checkHealth(), 5_000);
  }

  public subscribe(stream: string, consumer: (message: any) => void): () => void {
    let connection = this.connections.get(stream);
    if (!connection) {
      connection = { consumers: new Set(), status: 'connecting', intentionallyClosed: false };
      this.connections.set(stream, connection);
    }
    connection.consumers.add(consumer);
    if (!connection.socket && !connection.reconnectTimer) this.open(stream, connection);

    return () => {
      const current = this.connections.get(stream);
      if (!current) return;
      current.consumers.delete(consumer);
      if (current.consumers.size === 0) this.closeConnection(stream, current);
    };
  }

  public getHealth(): MarketDataStreamHealth[] {
    return [...this.connections.entries()].map(([stream, connection]) => ({
      stream,
      consumers: connection.consumers.size,
      status: connection.status,
      lastMessageAtMs: connection.lastMessageAtMs,
    }));
  }

  public reconnectAll(): void {
    for (const [stream, connection] of this.connections) {
      this.reconnect(stream, connection);
    }
  }

  public close(): void {
    this.closed = true;
    clearInterval(this.watchdogTimer);
    for (const [stream, connection] of this.connections) this.closeConnection(stream, connection);
  }

  private open(stream: string, connection: StreamConnection): void {
    if (this.closed || connection.consumers.size === 0) return;
    connection.intentionallyClosed = false;
    connection.status = 'connecting';
    try {
      const socket = this.webSocketFactory(streamWebSocketUrl(this.endpoint, stream));
      connection.socket = socket;
      socket.onopen = () => {
        if (this.connections.get(stream) !== connection) return;
        connection.status = 'open';
        connection.lastMessageAtMs = Date.now();
        this.logger.info('market_data_ws_open', { stream });
      };
      socket.onmessage = (event) => this.handleMessage(stream, connection, event.data);
      socket.onerror = (event) => {
        this.logger.warn('market_data_ws_error', { stream, error: String(event) });
      };
      socket.onclose = () => {
        if (this.connections.get(stream) !== connection || connection.intentionallyClosed) return;
        this.scheduleReconnect(stream, connection);
      };
    } catch (error) {
      this.logger.error('market_data_ws_connect_failed', { stream, error: String(error) });
      this.scheduleReconnect(stream, connection);
    }
  }

  private handleMessage(stream: string, connection: StreamConnection, raw: unknown): void {
    if (this.connections.get(stream) !== connection) return;
    try {
      const message = typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(String(raw));
      connection.lastMessageAtMs = Date.now();
      for (const consumer of connection.consumers) {
        try {
          consumer(message.data ?? message);
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
    for (const [stream, connection] of this.connections) {
      if (
        connection.status === 'open' &&
        connection.lastMessageAtMs !== undefined &&
        now - connection.lastMessageAtMs > this.watchdogTimeoutMs
      ) {
        this.logger.warn('market_data_ws_stale', { stream, elapsed: now - connection.lastMessageAtMs });
        this.reconnect(stream, connection);
      }
    }
  }

  private reconnect(stream: string, connection: StreamConnection): void {
    connection.intentionallyClosed = true;
    try {
      connection.socket?.close();
    } catch {
      // A failed close must not prevent the replacement connection.
    }
    connection.socket = undefined;
    connection.intentionallyClosed = false;
    this.scheduleReconnect(stream, connection);
  }

  private scheduleReconnect(stream: string, connection: StreamConnection): void {
    if (this.closed || connection.consumers.size === 0 || connection.reconnectTimer) return;
    connection.status = 'reconnecting';
    connection.reconnectTimer = setTimeout(() => {
      connection.reconnectTimer = undefined;
      this.open(stream, connection);
    }, this.reconnectDelayMs);
  }

  private closeConnection(stream: string, connection: StreamConnection): void {
    connection.intentionallyClosed = true;
    if (connection.reconnectTimer) clearTimeout(connection.reconnectTimer);
    try {
      connection.socket?.close();
    } catch {
      // Cleanup is best-effort.
    }
    this.connections.delete(stream);
  }
}
