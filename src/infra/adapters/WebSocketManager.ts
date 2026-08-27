import { Binance, Candle } from 'binance-api-node';
import { Logger } from '../../app/ports/Logger';
import { BinanceDepthDiffEvent } from '../../domain/strategies/micro-burst/MicroBurstMarketDataTypes';
import { MarketDataHub } from './MarketDataHub';

export interface WebSocketConfig {
  reconnectIntervalMs?: number;
  watchdogTimeoutMs?: number;
  maxRetries?: number;
  isTestnet?: boolean;
  marketDataHub?: MarketDataHub;
}

export class WebSocketManager {
  private readonly marketDataHub: MarketDataHub;
  private userCleanup?: () => void;
  private userCallback?: (data: any) => void;

  constructor(
    private readonly client: Binance,
    private readonly logger: Logger,
    config: WebSocketConfig = {},
  ) {
    this.marketDataHub =
      config.marketDataHub ??
      new MarketDataHub(logger, {
        isTestnet: config.isTestnet,
        watchdogTimeoutMs: config.watchdogTimeoutMs,
      });
  }

  public connectCandles(symbol: string, interval: string, callback: (candle: Candle) => void): void {
    this.marketDataHub.subscribe(`${symbol.toLowerCase()}@kline_${interval}`, (event) => {
      const candle = event.k;
      if (!candle) return;
      callback({
        startTime: candle.t,
        closeTime: candle.T,
        open: candle.o,
        high: candle.h,
        low: candle.l,
        close: candle.c,
        volume: candle.v,
        baseAssetVolume: candle.V,
        buyVolume: candle.V,
      } as unknown as Candle);
    });
  }

  public connectAggTrades(
    symbol: string,
    callback: (trade: { isBuyerMaker: boolean; quantity: string; price: string }) => void,
  ): void {
    this.marketDataHub.subscribe(`${symbol.toLowerCase()}@aggTrade`, (event) => {
      callback({
        isBuyerMaker: Boolean(event.m),
        quantity: String(event.q),
        price: String(event.p),
        eventTime: event.E,
        tradeTime: event.T,
        aggregateTradeId: event.a,
        firstTradeId: event.f,
        lastTradeId: event.l,
      } as any);
    });
  }

  public connectPartialDepth(
    symbol: string,
    levels: number,
    speed: '100ms' | '250ms' | '500ms',
    callback: (depth: any) => void,
  ): void {
    this.marketDataHub.subscribe(`${symbol.toLowerCase()}@depth${levels}@${speed}`, (event) => {
      callback({ ...event, bids: event.b ?? event.bids ?? [], asks: event.a ?? event.asks ?? [] });
    });
  }

  public connectDepthDiff(
    symbol: string,
    speed: '100ms' | '250ms' | '500ms',
    callback: (depth: BinanceDepthDiffEvent) => void,
  ): () => void {
    return this.marketDataHub.subscribe(`${symbol.toLowerCase()}@depth@${speed}`, (event) => {
      callback({
        U: event.U,
        u: event.u,
        pu: event.pu,
        bids: (event.b ?? []).map((level: any) => [String(level[0]), String(level[1])]),
        asks: (event.a ?? []).map((level: any) => [String(level[0]), String(level[1])]),
        E: event.E,
        T: event.T,
        receivedAtMs: Date.now(),
      });
    });
  }

  /** Private user data remains on binance-api-node and is intentionally not part of M3.2. */
  public connectUserData(callback: (data: any) => void): void {
    this.userCallback = callback;
    void this.subscribeUserData();
  }

  public disconnectAll(): void {
    this.marketDataHub.close();
    try {
      this.userCleanup?.();
    } catch {
      // Cleanup is best-effort.
    }
    this.userCleanup = undefined;
  }

  public simulateChaos(durationMs: number): void {
    this.logger.warn('market_data_ws_chaos', { durationMs });
    this.marketDataHub.reconnectAll();
  }

  private async subscribeUserData(): Promise<void> {
    try {
      this.userCleanup = await this.client.ws.futuresUser((data) => this.userCallback?.(data));
    } catch (error) {
      this.logger.error('WS User Connection Failed', { error: String(error) });
    }
  }
}
