import { Side } from '../../domain/types';
import { ShadowMarketQuote } from './ShadowTradingTypes';

export function executableEntryPrice(
  side: Side,
  quote: ShadowMarketQuote | undefined,
  atMs: number,
): number | undefined {
  if (!quote || quote.status !== 'HEALTHY' || quote.observedAtMs > atMs) return undefined;
  return side === 'LONG' ? quote.bestAsk : quote.bestBid;
}

export function executableExitPrice(
  side: Side,
  quote: ShadowMarketQuote | undefined,
  atMs: number,
): number | undefined {
  if (!quote || quote.status !== 'HEALTHY' || quote.observedAtMs > atMs) return undefined;
  return side === 'LONG' ? quote.bestBid : quote.bestAsk;
}
