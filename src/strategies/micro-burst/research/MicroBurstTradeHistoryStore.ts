import { MicroBurstTradeRecord } from './MicroBurstOutcomeTypes';

const DEFAULT_RETENTION_MS = 10 * 60_000;

/**
 * Exchange-time ordered trade history shared by all outcome observations for a symbol.
 * Retention is deliberately time-only: high-frequency symbols must not lose early ticks.
 */
export class MicroBurstTradeHistoryStore {
  private readonly histories = new Map<string, MicroBurstTradeRecord[]>();
  private readonly identities = new Map<string, Set<string>>();

  constructor(private readonly retentionMs: number = DEFAULT_RETENTION_MS) {
    if (!Number.isFinite(retentionMs) || retentionMs < DEFAULT_RETENTION_MS) {
      throw new Error(`retentionMs must be at least ${DEFAULT_RETENTION_MS}`);
    }
  }

  append(symbol: string, trade: MicroBurstTradeRecord): void {
    if (!symbol || !isValidTrade(trade)) return;
    const history = this.histories.get(symbol) ?? [];
    const identity = tradeIdentity(trade);
    const identities = this.identities.get(symbol) ?? new Set<string>();
    if (identities.has(identity)) return;
    const index = upperBound(history, trade);
    history.splice(index, 0, Object.freeze({ ...trade }));
    this.histories.set(symbol, history);
    identities.add(identity);
    this.identities.set(symbol, identities);
  }

  query(
    symbol: string,
    fromExclusive: number,
    toInclusive: number,
  ): readonly MicroBurstTradeRecord[] {
    if (toInclusive <= fromExclusive) return Object.freeze([]);
    const history = this.histories.get(symbol) ?? [];
    const start = history.findIndex((trade) => trade.eventTime > fromExclusive);
    if (start === -1) return Object.freeze([]);
    const end = history.findIndex(
      (trade, index) => index >= start && trade.eventTime > toInclusive,
    );
    return Object.freeze(history.slice(start, end === -1 ? undefined : end));
  }

  prune(nowMs: number): void {
    const cutoff = nowMs - this.retentionMs;
    for (const [symbol, history] of this.histories) {
      const firstRetained = history.findIndex((trade) => trade.eventTime > cutoff);
      if (firstRetained === -1) {
        this.histories.delete(symbol);
        this.identities.delete(symbol);
      } else if (firstRetained > 0) {
        history.splice(0, firstRetained);
        this.identities.set(symbol, new Set(history.map(tradeIdentity)));
      }
    }
  }
}

function isValidTrade(trade: MicroBurstTradeRecord): boolean {
  return (
    Number.isFinite(trade.eventTime) &&
    Number.isFinite(trade.receivedAtMs) &&
    Number.isFinite(trade.price) &&
    trade.price > 0 &&
    Number.isFinite(trade.quantity) &&
    trade.quantity >= 0
  );
}

function upperBound(
  history: readonly MicroBurstTradeRecord[],
  trade: MicroBurstTradeRecord,
): number {
  let low = 0;
  let high = history.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (compareTrades(history[middle], trade) <= 0) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Binance aggregate IDs are canonical; the remaining fields provide a stable fallback. */
export function tradeIdentity(trade: MicroBurstTradeRecord): string {
  if (Number.isFinite(trade.aggregateTradeId)) return `a:${trade.aggregateTradeId}`;
  if (Number.isFinite(trade.firstTradeId) && Number.isFinite(trade.lastTradeId))
    return `r:${trade.firstTradeId}:${trade.lastTradeId}`;
  return `f:${trade.eventTime}:${trade.tradeTime ?? ''}:${trade.price}:${trade.quantity}:${trade.isBuyerMaker ? 1 : 0}`;
}

export function compareTrades(a: MicroBurstTradeRecord, b: MicroBurstTradeRecord): number {
  return (
    a.eventTime - b.eventTime ||
    (a.aggregateTradeId ?? a.firstTradeId ?? a.lastTradeId ?? Number.MAX_SAFE_INTEGER) -
      (b.aggregateTradeId ?? b.firstTradeId ?? b.lastTradeId ?? Number.MAX_SAFE_INTEGER) ||
    (a.firstTradeId ?? Number.MAX_SAFE_INTEGER) - (b.firstTradeId ?? Number.MAX_SAFE_INTEGER) ||
    (a.lastTradeId ?? Number.MAX_SAFE_INTEGER) - (b.lastTradeId ?? Number.MAX_SAFE_INTEGER) ||
    a.receivedAtMs - b.receivedAtMs
  );
}
