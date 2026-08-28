import type { CandlePort, OrderBookPort, QuotePort } from '../../app/ports/MarketData';
import type { BenchmarkDescriptor, BenchmarkMarketDataPort } from './BenchmarkMarketData';
import type {
  AggTradeFeatureReader,
  MarketSnapshotRequest,
  MarketSnapshotSources,
  SnapshotCapabilityRequest,
} from './MarketSnapshotProvider';

export interface RegisteredSymbolCapabilities {
  readonly quote?: QuotePort;
  readonly orderBook?: OrderBookPort;
  readonly aggTrade?: AggTradeFeatureReader;
}

export interface SharedMarketCapabilities {
  readonly candles?: CandlePort;
  readonly benchmark?: BenchmarkMarketDataPort;
}

/**
 * Non-owning catalog of already-provisioned read capabilities.
 * Registration never starts, stops, subscribes to, or acquires the underlying source.
 */
export class MarketDataCapabilityCatalog {
  private readonly bySymbol = new Map<string, Readonly<RegisteredSymbolCapabilities>>();
  private shared: Readonly<SharedMarketCapabilities> = Object.freeze({});

  registerSymbol(symbol: string, capabilities: RegisteredSymbolCapabilities): void {
    this.bySymbol.set(normalizeSymbol(symbol), Object.freeze({ ...capabilities }));
  }

  unregisterSymbol(symbol: string): boolean {
    return this.bySymbol.delete(normalizeSymbol(symbol));
  }

  getSymbolCapabilities(symbol: string): Readonly<RegisteredSymbolCapabilities> | undefined {
    return this.bySymbol.get(normalizeSymbol(symbol));
  }

  registerShared(capabilities: SharedMarketCapabilities): void {
    this.shared = Object.freeze({ ...capabilities });
  }

  getSharedCapabilities(): Readonly<SharedMarketCapabilities> {
    return this.shared;
  }

  asSnapshotSources(): MarketSnapshotSources {
    const catalog = this;
    return Object.freeze({
      quoteFor: (symbol: string) => catalog.getSymbolCapabilities(symbol)?.quote,
      orderBookFor: (symbol: string) => catalog.getSymbolCapabilities(symbol)?.orderBook,
      aggTradeFor: (symbol: string) => catalog.getSymbolCapabilities(symbol)?.aggTrade,
      get candles() {
        return catalog.getSharedCapabilities().candles;
      },
      get benchmark() {
        return catalog.getSharedCapabilities().benchmark;
      },
    }) as MarketSnapshotSources;
  }
}

export interface MarketDataConsumerProfile {
  readonly id: string;
  readonly primary: SnapshotCapabilityRequest;
  readonly benchmark?: SnapshotCapabilityRequest;
}

export function defineMarketDataConsumerProfile(
  profile: MarketDataConsumerProfile,
): MarketDataConsumerProfile {
  if (!profile.id.trim()) throw new Error('MARKET_DATA_CONSUMER_PROFILE_ID_REQUIRED');
  return deepFreeze({
    id: profile.id,
    primary: normalizeCapabilityRequest(profile.primary),
    ...(profile.benchmark
      ? { benchmark: normalizeCapabilityRequest(profile.benchmark) }
      : {}),
  });
}

export function composeMarketSnapshotRequest(
  profile: MarketDataConsumerProfile,
  symbol: string,
  benchmarkDescriptor?: BenchmarkDescriptor,
): MarketSnapshotRequest {
  const request: MarketSnapshotRequest = {
    symbol: normalizeSymbol(symbol),
    ...cloneCapabilityRequest(profile.primary),
    ...(profile.benchmark
      ? {
          benchmark: {
            descriptor: normalizeBenchmarkDescriptor(
              benchmarkDescriptor ?? missingBenchmarkDescriptor(),
            ),
            ...cloneCapabilityRequest(profile.benchmark),
          },
        }
      : {}),
  };
  return deepFreeze(request);
}

function normalizeCapabilityRequest(request: SnapshotCapabilityRequest): SnapshotCapabilityRequest {
  const normalized: SnapshotCapabilityRequest = {};
  if (request.quote === true) Object.assign(normalized, { quote: true });
  if (request.orderBookFeatures === true) Object.assign(normalized, { orderBookFeatures: true });
  if (request.aggTrade === true) Object.assign(normalized, { aggTrade: true });
  else if (request.aggTrade && typeof request.aggTrade === 'object')
    Object.assign(normalized, { aggTrade: { windowMs: request.aggTrade.windowMs } });
  if (request.candles)
    Object.assign(normalized, {
      candles: { interval: request.candles.interval, limit: request.candles.limit },
    });
  return deepFreeze(normalized);
}

function cloneCapabilityRequest(request: SnapshotCapabilityRequest): SnapshotCapabilityRequest {
  return {
    ...(request.quote === true ? { quote: true } : {}),
    ...(request.orderBookFeatures === true ? { orderBookFeatures: true } : {}),
    ...(request.aggTrade === true
      ? { aggTrade: true }
      : request.aggTrade && typeof request.aggTrade === 'object'
        ? { aggTrade: { windowMs: request.aggTrade.windowMs } }
        : {}),
    ...(request.candles
      ? { candles: { interval: request.candles.interval, limit: request.candles.limit } }
      : {}),
  };
}

function normalizeBenchmarkDescriptor(descriptor: BenchmarkDescriptor): BenchmarkDescriptor {
  return Object.freeze({ id: descriptor.id, symbol: normalizeSymbol(descriptor.symbol) });
}

function missingBenchmarkDescriptor(): never {
  throw new Error('BENCHMARK_DESCRIPTOR_REQUIRED');
}

function normalizeSymbol(symbol: string): string {
  return symbol.toUpperCase();
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
