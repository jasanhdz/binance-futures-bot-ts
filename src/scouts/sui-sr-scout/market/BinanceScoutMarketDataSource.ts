import type { MarketDataPort } from '../../../app/ports/MarketData';
import type { Candle } from '../../../core/types';
import type {
  MarketDataCallbacks,
  RawAggTradeEvent,
  RawCandleEvent,
  RawDepthEvent,
} from './ScoutMarketDataRuntime';

type Unsubscribe = () => void;

export interface ScoutMarketDataSource {
  getCandles(symbol: string, interval: '1m' | '3m', limit: number): Promise<Candle[]>;
  getMarkPrice(symbol: string): Promise<number>;
  getFundingRate(symbol: string): Promise<{ rate: number; nextFundingTime?: number }>;
  subscribe(symbol: string, callbacks: MarketDataCallbacks): Unsubscribe[];
}

/**
 * Adapter limited to the Scout's public market-data capabilities. It deliberately
 * exposes no account or order mutation method.
 */
export function createBinanceScoutMarketDataSource(
  exchange: MarketDataPort,
): ScoutMarketDataSource {
  if (
    !exchange.subscribeToKlineCandles ||
    !exchange.subscribeToAggTrades ||
    !exchange.subscribeToDepthDiff
  ) {
    throw new Error('Binance market-data subscriptions required by SUI SR Scout are unavailable');
  }

  return {
    getCandles: (symbol, interval, limit) => exchange.getCandles(symbol, interval, limit),
    getMarkPrice: (symbol) => exchange.getMarkPrice(symbol),
    getFundingRate: (symbol) => exchange.getFundingRate(symbol),
    subscribe(symbol, callbacks): Unsubscribe[] {
      const unsubs: Unsubscribe[] = [];

      unsubs.push(
        exchange.subscribeToKlineCandles!(symbol, '1m', (update) => {
          const candle: RawCandleEvent = {
            symbol: update.symbol,
            interval: update.interval,
            openTime: update.candle.openTime,
            open: update.candle.open,
            high: update.candle.high,
            low: update.candle.low,
            close: update.candle.close,
            volume: update.candle.volume,
            closeTime: update.candle.closeTime,
            // The shared adapter does not currently expose Binance kline's final flag.
            // ScoutMarketDataRuntime closes the preceding candle on the next open time.
            isClosed: false,
            exchangeTime: update.candle.closeTime,
            receivedAtMs: update.observedAtMs,
          };
          callbacks.onCandle?.(candle);
        }),
      );

      unsubs.push(
        exchange.subscribeToAggTrades!(
          symbol,
          (trade) => {
            const parsed: RawAggTradeEvent = {
              symbol,
              price: Number(trade.price),
              quantity: Number(trade.quantity),
              isBuyerMaker: trade.isBuyerMaker,
              tradeTime: trade.tradeTime ?? trade.eventTime,
              receivedAtMs: trade.receivedAtMs ?? Date.now(),
              aggregateTradeId: trade.aggregateTradeId ?? -1,
            };
            callbacks.onAggTrade?.(parsed);
          },
          (status) => callbacks.onStreamStatus?.(symbol, 'agg_trade', status),
        ),
      );

      unsubs.push(
        exchange.subscribeToDepthDiff!(symbol, '100ms', (depth) => {
          const parsed: RawDepthEvent = {
            symbol,
            bids: depth.bids.map(([price, qty]) => [Number(price), Number(qty)] as const),
            asks: depth.asks.map(([price, qty]) => [Number(price), Number(qty)] as const),
            firstUpdateId: depth.U,
            previousUpdateId: depth.pu,
            lastUpdateId: depth.u,
            eventTime: depth.E,
            receivedAtMs: depth.receivedAtMs,
          };
          callbacks.onDepth?.(parsed);
        }),
      );

      return unsubs;
    },
  };
}
