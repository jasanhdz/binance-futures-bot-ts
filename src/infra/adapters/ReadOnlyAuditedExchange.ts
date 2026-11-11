import type { MarketDataPort } from '../../app/ports/MarketData';

export interface MutationAudit {
  codeSha?: string;
  readOnlyCalls: { public: number; authenticated: number };
  blockedMutationAttempts: Record<string, number>;
  totalMutationAttempts: number;
  forwardedMutationCalls: number;
  events: Array<{ method: string; at: string; symbol?: string }>;
}

const mutations = new Set([
  'setLeverage',
  'ensureMarginType',
  'marketOpen',
  'placeStopClose',
  'sendStopCloseOnce',
  'sendMarketCloseOnce',
  'placeTpClose',
  'closeSideMarketSafe',
  'cancelOrderById',
  'cancelCloseOrdersForSide',
  'cancelStopOrdersForSide',
  'cancelAllOrders',
  'cancelOrdersByIds',
]);

export function createReadOnlyAuditedExchange(
  target: MarketDataPort,
  codeSha?: string,
): { exchange: MarketDataPort; audit: MutationAudit } {
  const audit: MutationAudit = {
    codeSha,
    readOnlyCalls: { public: 0, authenticated: 0 },
    blockedMutationAttempts: {},
    totalMutationAttempts: 0,
    forwardedMutationCalls: 0,
    events: [],
  };
  const invoke = (method: keyof MarketDataPort, args: unknown[]): unknown => {
    const value = (target as unknown as Record<string, unknown>)[method] as unknown;
    if (typeof value !== 'function') throw new Error(`READ_ONLY_CAPABILITY_UNAVAILABLE:${method}`);
    audit.readOnlyCalls.public++;
    return (value as (...values: unknown[]) => unknown).apply(target, args);
  };
  const forward =
    (method: keyof MarketDataPort) =>
    (...args: unknown[]) =>
      invoke(method, args);
  const capabilities: Partial<MarketDataPort> = {
    getServerTime: forward('getServerTime') as MarketDataPort['getServerTime'],
    getCandles: forward('getCandles') as MarketDataPort['getCandles'],
    getLastCandle: forward('getLastCandle') as MarketDataPort['getLastCandle'],
    subscribeToCandles: forward('subscribeToCandles') as MarketDataPort['subscribeToCandles'],
    getMarkPrice: forward('getMarkPrice') as MarketDataPort['getMarkPrice'],
    getFundingRate: forward('getFundingRate') as MarketDataPort['getFundingRate'],
    getBasisSnapshot: forward('getBasisSnapshot') as MarketDataPort['getBasisSnapshot'],
    getCandleRequestDiagnostics: (() => {
      const value = target.getCandleRequestDiagnostics;
      if (typeof value !== 'function') return [];
      audit.readOnlyCalls.public++;
      return value.apply(target);
    }) as NonNullable<MarketDataPort['getCandleRequestDiagnostics']>,
  };
  const optionalMethods = [
    'getCachedCandles',
    'subscribeToKlineCandles',
    'subscribeToPartialDepth',
    'subscribeToDepthDiff',
    'subscribeToAggTrades',
    'getDepthSnapshot',
  ] as const;
  for (const method of optionalMethods) {
    if (typeof target[method] === 'function')
      (capabilities as Record<string, unknown>)[method] = forward(method) as unknown;
  }
  const allowed = new Set(Object.keys(capabilities));
  const marketData = Object.freeze(capabilities);
  // This proxy targets an object containing only MarketDataPort methods. Unknown
  // future Exchange methods fail closed rather than being forwarded implicitly.
  const exchange = new Proxy(marketData, {
    get(source, property, receiver) {
      if (typeof property !== 'string' || property in source)
        return Reflect.get(source, property, receiver);
      return (...args: unknown[]) => {
        const name = property;
        const symbol = typeof args[0] === 'string' ? args[0] : undefined;
        audit.totalMutationAttempts++;
        audit.blockedMutationAttempts[name] = (audit.blockedMutationAttempts[name] ?? 0) + 1;
        audit.events.push({ method: name, at: new Date().toISOString(), symbol });
        throw new Error(
          `${mutations.has(name) ? 'MUTATION_FORBIDDEN_IN_SHADOW_SOAK' : 'UNKNOWN_CAPABILITY_FORBIDDEN'}:${name}`,
        );
      };
    },
    has(source, property) {
      if (typeof property === 'string' && !allowed.has(property)) return false;
      return Reflect.has(source, property);
    },
  }) as MarketDataPort;
  return { exchange, audit };
}
