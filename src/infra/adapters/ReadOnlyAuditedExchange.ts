import { Exchange } from '../../app/ports/Exchange';
import { MarketDataPort } from '../../app/ports/MarketData';

export interface MutationAudit {
  codeSha?: string;
  readOnlyCalls: { public: number; authenticated: number };
  blockedMutationAttempts: Record<string, number>;
  totalMutationAttempts: number;
  forwardedMutationCalls: number;
  events: Array<{ method: string; at: string; symbol?: string }>;
}

const authenticatedReads = new Set([
  'getUSDTBalance',
  'getUSDTAccountSnapshot',
  'hasOpenPosition',
  'readActivePosition',
  'readMarketOpenByClientOrderId',
  'readMarketOpenEvidence',
  'getRecentFills',
  'listCloseOrdersForSide',
]);

const mutations = new Set([
  'setLeverage',
  'ensureMarginType',
  'marketOpen',
  'placeStopClose',
  'placeTpClose',
  'closeSideMarketSafe',
  'cancelOrderById',
  'cancelCloseOrdersForSide',
  'cancelStopOrdersForSide',
  'cancelAllOrders',
  'cancelOrdersByIds',
]);

export function createReadOnlyAuditedExchange(
  target: Exchange,
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
  const exchange = new Proxy(target, {
    get(source, property, receiver) {
      const value = Reflect.get(source, property, receiver);
      if (typeof value !== 'function' || typeof property !== 'string') return value;
      if (mutations.has(property)) {
        return (...args: unknown[]) => {
          const symbol = typeof args[0] === 'string' ? args[0] : undefined;
          audit.totalMutationAttempts++;
          audit.blockedMutationAttempts[property] =
            (audit.blockedMutationAttempts[property] ?? 0) + 1;
          audit.events.push({ method: property, at: new Date().toISOString(), symbol });
          throw new Error('MUTATION_FORBIDDEN_IN_SHADOW_SOAK');
        };
      }
      return (...args: unknown[]) => {
        audit.readOnlyCalls[authenticatedReads.has(property) ? 'authenticated' : 'public']++;
        return value.apply(source, args);
      };
    },
  }) as MarketDataPort;
  return { exchange, audit };
}
