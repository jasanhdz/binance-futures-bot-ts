import { Side } from '../types';
import { ShadowMarketQuote } from './ShadowTradingTypes';

export function executableEntryPrice(
  side: Side,
  quote: ShadowMarketQuote | undefined,
  atMs: number,
): number | undefined {
  if (!validQuote(quote) || quote.observedAtMs > atMs) return undefined;
  return side === 'LONG' ? quote.bestAsk : quote.bestBid;
}

export function executableExitPrice(
  side: Side,
  quote: ShadowMarketQuote | undefined,
  atMs: number,
): number | undefined {
  if (!validQuote(quote) || quote.observedAtMs > atMs) return undefined;
  return side === 'LONG' ? quote.bestBid : quote.bestAsk;
}

function validQuote(quote: ShadowMarketQuote | undefined): quote is ShadowMarketQuote {
  return Boolean(
    quote &&
      quote.status === 'HEALTHY' &&
      Number.isFinite(quote.bestBid) &&
      Number.isFinite(quote.bestAsk) &&
      quote.bestBid > 0 &&
      quote.bestAsk > quote.bestBid &&
      Number.isFinite(quote.observedAtMs),
  );
}
