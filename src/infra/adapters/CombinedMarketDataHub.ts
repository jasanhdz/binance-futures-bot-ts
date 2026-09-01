import { Logger } from '../../app/ports/Logger';
import {
  MarketDataEndpointConfig,
  MarketDataEndpointDescriptor,
  combinedStreamWebSocketUrl,
  resolveMarketDataEndpoint,
} from './MarketDataEndpoints';
import type { RawWebSocket } from './MarketDataHub';

type Stream = {
  consumers: Set<(message: any) => void>;
  statuses: Set<(status: 'connecting' | 'open' | 'reconnecting') => void>;
  status: 'connecting' | 'open' | 'reconnecting';
  lastMessageAtMs?: number;
  reconnectCount: number;
};

type Route = {
  descriptor: MarketDataEndpointDescriptor;
  streams: Map<string, Stream>;
  socket?: RawWebSocket;
  socketGeneration: number;
  openedAtMs?: number;
  lastMessageAtMs?: number;
  openTimer?: NodeJS.Timeout;
  reconnectTimer?: NodeJS.Timeout;
  intentionallyClosed: boolean;
};

/** Multiplexes public and market feeds into one socket per Binance route. */
export class CombinedMarketDataHub {
  private readonly endpoint: MarketDataEndpointConfig;
  private readonly reconnectDelayMs: number;
  private readonly watchdogTimeoutMs: number;
  private readonly webSocketFactory: (url: string) => RawWebSocket;
  private readonly routes = new Map<string, Route>();
  private readonly watchdogTimer: NodeJS.Timeout;
  private closed = false;

  constructor(
    private readonly logger: Logger,
    config: {
      endpoint?: MarketDataEndpointConfig;
      isTestnet?: boolean;
      reconnectDelayMs?: number;
      watchdogTimeoutMs?: number;
      webSocketFactory: (url: string) => RawWebSocket;
    },
  ) {
    this.endpoint = config.endpoint ?? resolveMarketDataEndpoint(config.isTestnet ?? false);
    this.reconnectDelayMs = config.reconnectDelayMs ?? 5_000;
    this.watchdogTimeoutMs = config.watchdogTimeoutMs ?? 60_000;
    this.webSocketFactory = config.webSocketFactory;
    this.watchdogTimer = setInterval(() => this.checkHealth(), 5_000);
  }

  subscribe(
    stream: string,
    descriptor: MarketDataEndpointDescriptor,
    consumer: (message: any) => void,
    onStatus?: (status: Stream['status']) => void,
  ): () => void {
    let route = this.routes.get(descriptor.accessMode);
    if (!route) {
      route = {
        descriptor,
        streams: new Map(),
        socketGeneration: 0,
        intentionallyClosed: false,
      };
      this.routes.set(descriptor.accessMode, route);
    }
    let entry = route.streams.get(stream);
    if (!entry) {
      entry = {
        consumers: new Set(),
        statuses: new Set(),
        status: 'connecting',
        reconnectCount: 0,
      };
      route.streams.set(stream, entry);
      if (route.socket) {
        // Combined URLs are immutable. Rebuild the route socket so the new
        // stream is actually subscribed, while invalidating callbacks from
        // the previous socket.
        this.closeSocket(route, false);
      }
      if (!route.reconnectTimer) this.scheduleOpen(route);
    }
    entry.consumers.add(consumer);
    if (onStatus) entry.statuses.add(onStatus);
    return () => {
      const current = route!.streams.get(stream);
      if (!current) return;
      current.consumers.delete(consumer);
      if (onStatus) current.statuses.delete(onStatus);
      if (!current.consumers.size) route!.streams.delete(stream);
      if (!route!.streams.size) {
        if (route!.openTimer) clearTimeout(route!.openTimer);
        if (route!.reconnectTimer) clearTimeout(route!.reconnectTimer);
        route!.intentionallyClosed = true;
        this.closeSocket(route!, true);
        this.routes.delete(descriptor.accessMode);
      }
    };
  }

  getHealth() {
    return [...this.routes.values()].flatMap((route) =>
      [...route.streams.entries()].map(([stream, entry]) => ({
        stream,
        consumers: entry.consumers.size,
        status: entry.status,
        lastMessageAtMs: entry.lastMessageAtMs,
        reconnectCount: entry.reconnectCount,
      })),
    );
  }

  reconnectAll(): void {
    for (const route of this.routes.values()) this.reconnect(route);
  }

  close(): void {
    this.closed = true;
    clearInterval(this.watchdogTimer);
    for (const route of this.routes.values()) {
      if (route.openTimer) clearTimeout(route.openTimer);
      if (route.reconnectTimer) clearTimeout(route.reconnectTimer);
      route.intentionallyClosed = true;
      this.closeSocket(route, true);
    }
    this.routes.clear();
  }

  private scheduleOpen(route: Route): void {
    if (route.openTimer || this.closed) return;
    route.openTimer = setTimeout(() => {
      route.openTimer = undefined;
      this.open(route);
    }, 0);
  }

  private open(route: Route): void {
    if (this.closed || !route.streams.size || route.socket) return;
    for (const stream of route.streams.values()) {
      stream.status = 'connecting';
      for (const listener of stream.statuses) listener(stream.status);
    }
    const generation = ++route.socketGeneration;
    try {
      const socket = this.webSocketFactory(
        combinedStreamWebSocketUrl(this.endpoint, [...route.streams.keys()], route.descriptor),
      );
      route.socket = socket;
      socket.onopen = () => {
        if (!this.isCurrentSocket(route, socket, generation)) return;
        route.openedAtMs = Date.now();
        route.lastMessageAtMs = undefined;
        for (const stream of route!.streams.values()) {
          stream.status = 'open';
          stream.lastMessageAtMs = undefined;
          for (const listener of stream.statuses) listener(stream.status);
        }
        this.logger.info('market_data_combined_ws_open', { streams: [...route!.streams.keys()] });
      };
      socket.onmessage = (event) => this.handleMessage(route!, socket, generation, event.data);
      socket.onerror = (event) => {
        if (this.isCurrentSocket(route!, socket, generation)) {
          this.logger.warn('market_data_ws_error', { error: String(event) });
        }
      };
      socket.onclose = () => {
        if (!this.isCurrentSocket(route!, socket, generation)) return;
        route!.socket = undefined;
        if (!route!.intentionallyClosed) this.scheduleReconnect(route!);
      };
    } catch (error) {
      this.logger.error('market_data_ws_connect_failed', { error: String(error) });
      route.socket = undefined;
      this.scheduleReconnect(route);
    }
  }

  private handleMessage(
    route: Route,
    socket: RawWebSocket,
    generation: number,
    raw: unknown,
  ): void {
    if (!this.isCurrentSocket(route, socket, generation)) return;
    try {
      const message = typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(String(raw));
      const receivedAtMs = Date.now();
      route.lastMessageAtMs = receivedAtMs;
      const streamName =
        typeof message.stream === 'string' ? message.stream : [...route.streams.keys()][0];
      const stream = route.streams.get(streamName);
      if (!stream) return;
      stream.lastMessageAtMs = receivedAtMs;
      const payload = message.data ?? message;
      for (const consumer of stream.consumers) {
        try {
          consumer(
            payload !== null && typeof payload === 'object'
              ? { ...payload, receivedAtMs }
              : payload,
          );
        } catch (error) {
          this.logger.error('market_data_consumer_failed', {
            stream: streamName,
            error: String(error),
          });
        }
      }
    } catch (error) {
      this.logger.warn('market_data_ws_invalid_message', { error: String(error) });
    }
  }

  private reconnect(route: Route): void {
    this.closeSocket(route, false);
    this.scheduleReconnect(route);
  }

  private scheduleReconnect(route: Route): void {
    if (this.closed || !route.streams.size || route.reconnectTimer) return;
    for (const stream of route.streams.values()) {
      stream.status = 'reconnecting';
      stream.reconnectCount++;
      for (const listener of stream.statuses) listener(stream.status);
    }
    route.reconnectTimer = setTimeout(() => {
      route.reconnectTimer = undefined;
      this.open(route);
    }, this.reconnectDelayMs);
  }

  private checkHealth(): void {
    if (this.closed) return;
    const now = Date.now();
    for (const route of this.routes.values()) {
      if (!route.socket) continue;
      const lastRouteActivityAtMs = route.lastMessageAtMs ?? route.openedAtMs;
      if (
        lastRouteActivityAtMs !== undefined &&
        now - lastRouteActivityAtMs > this.watchdogTimeoutMs
      ) {
        this.logger.warn('market_data_combined_ws_stale', {
          route: route.descriptor.accessMode,
          elapsed: now - lastRouteActivityAtMs,
        });
        this.reconnect(route);
      }
    }
  }

  private isCurrentSocket(route: Route, socket: RawWebSocket, generation: number): boolean {
    return route.socket === socket && route.socketGeneration === generation;
  }

  private closeSocket(route: Route, intentionallyClosed: boolean): void {
    const socket = route.socket;
    route.socket = undefined;
    route.socketGeneration++;
    if (intentionallyClosed) route.intentionallyClosed = true;
    try {
      socket?.close();
    } catch {
      /* best-effort cleanup */
    }
  }
}
