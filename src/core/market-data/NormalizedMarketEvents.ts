/** Strategy-neutral, lossless envelopes for normalized market-data observations. */

export type MarketDataFeed = 'AGG_TRADE' | 'DEPTH' | 'MARK_PRICE' | 'CANDLE' | 'BTC_CONTEXT';
export type GapKind =
  | 'AGG_TRADE_SEQUENCE'
  | 'DEPTH_SEQUENCE'
  | 'SUBSCRIPTION'
  | 'ARCHIVE'
  | 'UNKNOWN_LEGACY';

export interface AggTradeEvent {
  feed: 'AGG_TRADE';
  symbol: string;
  eventTimeMs: number;
  receivedAtMs: number;
  price: number;
  quantity: number;
  isBuyerMaker: boolean;
  aggregateTradeId?: number;
  firstTradeId?: number;
  lastTradeId?: number;
  tradeTimeMs?: number;
}

export interface DepthEvent {
  feed: 'DEPTH';
  symbol: string;
  eventTimeMs: number;
  transactionTimeMs?: number;
  receivedAtMs: number;
  firstUpdateId: number;
  finalUpdateId: number;
  previousFinalUpdateId?: number;
  bids: readonly (readonly [string, string])[];
  asks: readonly (readonly [string, string])[];
}

export interface MarketDataGap {
  symbol: string;
  kind: GapKind;
  startedAtMs: number;
  endedAtMs: number;
  feed?: MarketDataFeed;
  details?: Readonly<Record<string, unknown>>;
}

export function parseAggTrade(
  symbol: string,
  data: unknown,
  receivedAtMs: number,
): AggTradeEvent | null {
  const value = record(data);
  const price = number(value.p);
  const quantity = number(value.q);
  const eventTimeMs = number(value.T ?? value.E);
  if (
    !symbol ||
    !Number.isFinite(receivedAtMs) ||
    !Number.isFinite(price) ||
    price <= 0 ||
    !Number.isFinite(quantity) ||
    quantity < 0 ||
    !Number.isFinite(eventTimeMs) ||
    eventTimeMs <= 0 ||
    typeof value.m !== 'boolean'
  )
    return null;
  return {
    feed: 'AGG_TRADE',
    symbol,
    eventTimeMs,
    receivedAtMs,
    price,
    quantity,
    isBuyerMaker: value.m,
    aggregateTradeId: optionalNumber(value.a),
    firstTradeId: optionalNumber(value.f),
    lastTradeId: optionalNumber(value.l),
    tradeTimeMs: optionalNumber(value.T),
  };
}

export function parseDepth(symbol: string, data: unknown, receivedAtMs: number): DepthEvent | null {
  const value = record(data);
  const firstUpdateId = number(value.U),
    finalUpdateId = number(value.u);
  const eventTimeMs = number(value.E);
  if (
    !symbol ||
    !Number.isFinite(receivedAtMs) ||
    !Number.isFinite(eventTimeMs) ||
    eventTimeMs <= 0 ||
    !Number.isSafeInteger(firstUpdateId) ||
    firstUpdateId <= 0 ||
    !Number.isSafeInteger(finalUpdateId) ||
    finalUpdateId < firstUpdateId ||
    !Array.isArray(value.b) ||
    !Array.isArray(value.a)
  )
    return null;
  return {
    feed: 'DEPTH',
    symbol,
    eventTimeMs,
    transactionTimeMs: optionalNumber(value.T),
    receivedAtMs,
    firstUpdateId,
    finalUpdateId,
    previousFinalUpdateId: optionalNumber(value.pu),
    bids: value.b,
    asks: value.a,
  };
}

function record(value: unknown): Record<string, any> {
  return value !== null && typeof value === 'object' ? (value as Record<string, any>) : {};
}
function number(value: unknown): number {
  return typeof value === 'number' ? value : Number(value);
}
function optionalNumber(value: unknown): number | undefined {
  const result = number(value);
  return Number.isFinite(result) ? result : undefined;
}
