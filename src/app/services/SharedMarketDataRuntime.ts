import type { Logger } from '../ports/Logger';
import type { MarketDataPort } from '../ports/MarketData';
import { AggTradeDataPlane } from '../../core/market-data/AggTradeDataPlane';
import { CandleDataPlane } from '../../core/market-data/CandleDataPlane';
import { OrderBookDataPlane } from '../../core/market-data/OrderBookDataPlane';
import {
  RollingAggTradeBuffer,
  type AggTradeGap,
} from '../../core/market-data/RollingAggTradeBuffer';
import {
  SynchronizedOrderBook,
  type SynchronizedOrderBookDeps,
} from '../../core/market-data/SynchronizedOrderBook';

export interface SharedMarketDataArchiveObserver {
  onDepth?(symbol: string, depth: any): void;
  onAggTradeGap?(symbol: string, gap: AggTradeGap): void;
  hasAggTradeGap?(symbol: string, fromMs: number, toMs: number): boolean;
}

export interface SharedMarketDataRuntimeDeps {
  exchange: MarketDataPort;
  logger: Logger;
  clock: { now(): number };
}

/**
 * Application-owned canonical market-data state.
 *
 * Strategies acquire leases from these planes; no strategy owns the underlying
 * Binance candle/depth/AggTrade subscriptions. A plane opens one stream per
 * symbol (and interval for candles) and reference-counts all consumers.
 */
export class SharedMarketDataRuntime {
  readonly candleDataPlane: CandleDataPlane;
  readonly orderBookDataPlane: OrderBookDataPlane<SynchronizedOrderBook>;
  readonly aggTradeDataPlane: AggTradeDataPlane<RollingAggTradeBuffer>;
  private archiveObserver: SharedMarketDataArchiveObserver = {};

  constructor(private readonly deps: SharedMarketDataRuntimeDeps) {
    const { exchange, logger, clock } = deps;

    this.candleDataPlane = new CandleDataPlane({
      clock,
      subscribe: (symbol, interval, onCandle) => {
        if (!exchange.subscribeToKlineCandles) {
          logger.warn('shared_market_data_exchange_no_kline_stream', { symbol, interval });
          return () => {};
        }
        return exchange.subscribeToKlineCandles(symbol, interval, (update) => {
          onCandle(update.candle, update.observedAtMs);
        });
      },
      fetch: (symbol, interval, limit) => exchange.getCandles(symbol, interval, limit),
    });

    this.orderBookDataPlane = new OrderBookDataPlane((symbol) => {
      const bookDeps: SynchronizedOrderBookDeps = {
        snapshotSource: {
          getSnapshot: async (sym: string, levels: number) => {
            if (!exchange.getDepthSnapshot) {
              throw new Error('Exchange does not support depth snapshot');
            }
            return exchange.getDepthSnapshot(sym, levels);
          },
        },
        diffSource: {
          onDiff: (sym: string, callback: (event: any) => void) => {
            if (!exchange.subscribeToDepthDiff) {
              logger.warn('shared_market_data_exchange_no_depth_diff', { symbol: sym });
              return () => {};
            }
            return exchange.subscribeToDepthDiff(sym, '100ms', (depth) => {
              this.archiveObserver.onDepth?.(sym, depth);
              callback(depth);
            });
          },
        },
        logger,
        clock,
        getServerTime: () => exchange.getServerTime(),
      };
      return new SynchronizedOrderBook(symbol, bookDeps);
    });

    this.aggTradeDataPlane = new AggTradeDataPlane(
      (symbol) =>
        new RollingAggTradeBuffer(
          clock,
          undefined,
          undefined,
          (gap) => this.archiveObserver.onAggTradeGap?.(symbol, gap),
          (fromMs, toMs) => this.archiveObserver.hasAggTradeGap?.(symbol, fromMs, toMs) ?? false,
        ),
      {
        subscribe: (symbol, onEvent, onStatus) => {
          if (!exchange.subscribeToAggTrades) return () => {};
          return exchange.subscribeToAggTrades(
            symbol,
            (trade) =>
              onEvent({
                eventTime: trade.eventTime,
                receivedAtMs: trade.receivedAtMs,
                price: Number(trade.price),
                quantity: Number(trade.quantity),
                isBuyerMaker: trade.isBuyerMaker,
                tradeTime: trade.tradeTime,
                aggregateTradeId: trade.aggregateTradeId,
                firstTradeId: trade.firstTradeId,
                lastTradeId: trade.lastTradeId,
              }),
            onStatus,
          );
        },
      },
    );
  }

  setArchiveObserver(observer?: SharedMarketDataArchiveObserver): void {
    this.archiveObserver = observer ?? {};
  }

  close(): void {
    this.candleDataPlane.close();
    this.orderBookDataPlane.close();
    this.aggTradeDataPlane.close();
    this.archiveObserver = {};
  }
}
