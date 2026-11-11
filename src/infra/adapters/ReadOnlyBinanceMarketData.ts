import type { Logger } from '../../app/ports/Logger';
import { BinanceExchange } from './BinanceAdapter';
import { createReadOnlyAuditedExchange } from './ReadOnlyAuditedExchange';

/** Creates a public-data-only Binance port for isolated observational tooling. */
export function createReadOnlyBinanceMarketData(
  logger: Logger,
  codeSha?: string,
): ReturnType<typeof createReadOnlyAuditedExchange> & { disconnectAll(): void } {
  const source = new BinanceExchange(logger);
  return {
    ...createReadOnlyAuditedExchange(source, codeSha),
    disconnectAll: () =>
      (source as unknown as { wsManager: { disconnectAll(): void } }).wsManager.disconnectAll(),
  };
}
