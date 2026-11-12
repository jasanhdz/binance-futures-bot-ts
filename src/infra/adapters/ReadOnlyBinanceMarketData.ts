import type { Logger } from '../../app/ports/Logger';
import type { MarketDataPort } from '../../app/ports/MarketData';
import { BinanceExchange } from './BinanceAdapter';
import { createReadOnlyAuditedExchange } from './ReadOnlyAuditedExchange';

export interface ReadOnlyMarketDataSource extends MarketDataPort {
  disconnectAll?(): void;
}

/** Creates a public-data-only Binance port for isolated observational tooling. */
export function createReadOnlyBinanceMarketData(
  logger: Logger,
  codeSha?: string,
  sourceFactory?: (logger: Logger) => ReadOnlyMarketDataSource,
): ReturnType<typeof createReadOnlyAuditedExchange> & { disconnectAll(): void } {
  const source: ReadOnlyMarketDataSource = sourceFactory
    ? sourceFactory(logger)
    : (new BinanceExchange(logger) as ReadOnlyMarketDataSource);
  return {
    ...createReadOnlyAuditedExchange(source, codeSha),
    disconnectAll: () => {
      if (source.disconnectAll) source.disconnectAll();
      else
        (source as unknown as { wsManager: { disconnectAll(): void } }).wsManager.disconnectAll();
    },
  };
}
