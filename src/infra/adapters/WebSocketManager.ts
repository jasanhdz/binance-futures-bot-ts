import { Binance, Candle } from 'binance-api-node';
import { Logger } from '../../app/ports/Logger';
import { BinanceDepthDiffEvent } from '../../domain/strategies/micro-burst/MicroBurstMarketDataTypes';
import { MarketDataHub } from './MarketDataHub';
import { MARKET, PUBLIC } from './MarketDataEndpoints';
import { parseAggTrade, parseDepth } from '../../app/micro-burst/MicroBurstMarketData';

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

  public connectCandles(
    symbol: string,
    interval: string,
    callback: (candle: Candle) => void,
  ): () => void {
    return this.marketDataHub.subscribe(
      `${symbol.toLowerCase()}@kline_${interval}`,
      MARKET,
      (event) => {
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
      },
    );
  }

  public connectAggTrades(
    symbol: string,
    callback: (trade: {
      isBuyerMaker: boolean;
      quantity: string;
      price: string;
      eventTime: number;
      receivedAtMs: number;
      tradeTime?: number;
      aggregateTradeId?: number;
      firstTradeId?: number;
      lastTradeId?: number;
    }) => void,
    onStatus?: (status: 'connecting' | 'open' | 'reconnecting') => void,
  ): () => void {
    return this.marketDataHub.subscribe(
      `${symbol.toLowerCase()}@aggTrade`,
      MARKET,
      (event) => {
        const parsed = parseAggTrade(symbol, event, event.receivedAtMs);
        if (!parsed) return;
        callback({
          isBuyerMaker: parsed.isBuyerMaker,
          quantity: String(parsed.quantity),
          price: String(parsed.price),
          eventTime: parsed.eventTimeMs,
          receivedAtMs: parsed.receivedAtMs,
          tradeTime: parsed.tradeTimeMs,
          aggregateTradeId: parsed.aggregateTradeId,
          firstTradeId: parsed.firstTradeId,
          lastTradeId: parsed.lastTradeId,
        });
      },
      onStatus,
    );
  }

  public connectPartialDepth(
    symbol: string,
    levels: number,
    speed: '100ms' | '250ms' | '500ms',
    callback: (depth: any) => void,
  ): () => void {
    if (![5, 10, 20].includes(levels)) {
      throw new Error(`Unsupported Binance partial-depth level: ${levels}`);
    }
    return this.marketDataHub.subscribe(
      `${symbol.toLowerCase()}@depth${levels}@${speed}`,
      PUBLIC,
      (event) => {
        callback({
          ...event,
          bids: event.b ?? event.bids ?? [],
          asks: event.a ?? event.asks ?? [],
        });
      },
    );
  }

  public connectDepthDiff(
    symbol: string,
    speed: '100ms' | '250ms' | '500ms',
    callback: (depth: BinanceDepthDiffEvent) => void,
  ): () => void {
    return this.marketDataHub.subscribe(
      `${symbol.toLowerCase()}@depth@${speed}`,
      PUBLIC,
      (event) => {
        const parsed = parseDepth(symbol, event, event.receivedAtMs);
        if (!parsed) return;
        callback({
          U: parsed.firstUpdateId,
          u: parsed.finalUpdateId,
          pu: parsed.previousFinalUpdateId ?? 0,
          bids: parsed.bids.map((level) => [level[0], level[1]] as [string, string]),
          asks: parsed.asks.map((level) => [level[0], level[1]] as [string, string]),
          E: parsed.eventTimeMs,
          T: parsed.transactionTimeMs ?? parsed.eventTimeMs,
          receivedAtMs: parsed.receivedAtMs,
        });
      },
    );
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

  public getMarketDataHealth() {
    return this.marketDataHub.getHealth();
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
