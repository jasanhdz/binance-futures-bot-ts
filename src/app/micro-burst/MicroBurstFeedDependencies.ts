import type { MarketDataFeed } from '../../core/market-data/NormalizedMarketEvents';

export const MICRO_BURST_FEED_DEPENDENCIES: Readonly<Record<string, readonly MarketDataFeed[]>> =
  Object.freeze({
    tradeFlow: ['AGG_TRADE'],
    orderBook: ['DEPTH'],
    referencePrice: ['MARK_PRICE'],
    btcContext: ['CANDLE'],
  });

export const MICRO_BURST_OUTCOME_FEED_DEPENDENCIES: Readonly<
  Record<'SIGNAL_PRICE', readonly MarketDataFeed[]>
> = Object.freeze({
  SIGNAL_PRICE: ['AGG_TRADE'],
});

export function missingFeedDependencies(available: Iterable<MarketDataFeed>): string[] {
  const feeds = new Set(available);
  return Object.entries(MICRO_BURST_FEED_DEPENDENCIES)
    .filter(([, required]) => required.some((feed) => !feeds.has(feed)))
    .map(([name]) => name);
}
