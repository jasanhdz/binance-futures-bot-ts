import { MicroBurstTradeRecord } from '../../domain/strategies/micro-burst/MicroBurstOutcomeTypes';

const DEFAULT_RETENTION_MS = 10 * 60_000;

/**
 * Exchange-time ordered trade history shared by all outcome observations for a symbol.
 * Retention is deliberately time-only: high-frequency symbols must not lose early ticks.
 */
export class MicroBurstTradeHistoryStore {
  private readonly histories = new Map<string, MicroBurstTradeRecord[]>();

  constructor(private readonly retentionMs: number = DEFAULT_RETENTION_MS) {
    if (!Number.isFinite(retentionMs) || retentionMs < DEFAULT_RETENTION_MS) {
      throw new Error(`retentionMs must be at least ${DEFAULT_RETENTION_MS}`);
    }
  }

  append(symbol: string, trade: MicroBurstTradeRecord): void {
    if (!symbol || !isValidTrade(trade)) return;
    const history = this.histories.get(symbol) ?? [];
    const index = upperBound(history, trade);
    history.splice(index, 0, Object.freeze({ ...trade }));
    this.histories.set(symbol, history);
  }

  query(symbol: string, fromExclusive: number, toInclusive: number): readonly MicroBurstTradeRecord[] {
    if (toInclusive <= fromExclusive) return Object.freeze([]);
    const history = this.histories.get(symbol) ?? [];
    const start = history.findIndex((trade) => trade.eventTime > fromExclusive);
    if (start === -1) return Object.freeze([]);
    const end = history.findIndex((trade, index) => index >= start && trade.eventTime > toInclusive);
    return Object.freeze(history.slice(start, end === -1 ? undefined : end));
  }

  prune(nowMs: number): void {
    const cutoff = nowMs - this.retentionMs;
    for (const [symbol, history] of this.histories) {
      const firstRetained = history.findIndex((trade) => trade.eventTime > cutoff);
      if (firstRetained === -1) this.histories.delete(symbol);
      else if (firstRetained > 0) history.splice(0, firstRetained);
    }
  }
}

function isValidTrade(trade: MicroBurstTradeRecord): boolean {
  return Number.isFinite(trade.eventTime)
    && Number.isFinite(trade.receivedAtMs)
    && Number.isFinite(trade.price) && trade.price > 0
    && Number.isFinite(trade.quantity) && trade.quantity >= 0;
}

function upperBound(history: readonly MicroBurstTradeRecord[], trade: MicroBurstTradeRecord): number {
  let low = 0;
  let high = history.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (history[middle].eventTime <= trade.eventTime) low = middle + 1;
    else high = middle;
  }
  return low;
}
