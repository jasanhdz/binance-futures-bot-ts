import type { QuotePort, QuoteSnapshot, OrderBookPort } from '../../app/ports/MarketData';

/** Derives a neutral quote fact from one authoritative synchronized order book. */
export class OrderBookQuoteProvider implements QuotePort {
  constructor(
    private readonly symbol: string,
    private readonly orderBook: OrderBookPort,
  ) {}

  getQuote(): QuoteSnapshot {
    const sourceHealth = this.orderBook.getHealth();
    const state = this.orderBook.getState();
    const observedAtMs = isValidTimestamp(state.observedAtMs) ? state.observedAtMs : null;

    if (sourceHealth !== 'HEALTHY') {
      return this.snapshot(sourceHealth, observedAtMs);
    }

    const bid = state.bids[0]?.price;
    const ask = state.asks[0]?.price;
    if (!isValidPrice(bid) || !isValidPrice(ask) || ask <= bid || observedAtMs === null) {
      return this.snapshot('ANOMALOUS', observedAtMs);
    }

    const mid = (bid + ask) / 2;
    const spread = ask - bid;
    return Object.freeze({
      symbol: this.symbol,
      bid,
      ask,
      mid,
      spread,
      spreadBps: (spread / bid) * 10_000,
      health: 'HEALTHY' as const,
      observedAtMs,
      source: 'SYNCHRONIZED_ORDER_BOOK' as const,
    });
  }

  private snapshot(health: QuoteSnapshot['health'], observedAtMs: number | null): QuoteSnapshot {
    return Object.freeze({
      symbol: this.symbol,
      bid: null,
      ask: null,
      mid: null,
      spread: null,
      spreadBps: null,
      health,
      observedAtMs,
      source: 'SYNCHRONIZED_ORDER_BOOK' as const,
    });
  }
}

function isValidPrice(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}

function isValidTimestamp(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}
