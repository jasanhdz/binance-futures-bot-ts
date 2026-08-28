import { createHash } from 'node:crypto';
import type { CandlePort, OrderBookPort, QuotePort } from '../../app/ports/MarketData';
import {
  calculateAggTradeFeaturesV1,
  calculateCandleFeaturesV1,
  calculateOrderBookFeaturesV1,
  calculateQuoteFeaturesV1,
  type AggTradeFeaturesV1,
  type AggTradeFlowInput,
  type CandleFeaturesV1,
  type NeutralFeatureHealth,
  type OrderBookFeaturesV1,
  type QuoteFeaturesV1,
} from './SharedNeutralMarketFeatures';
import type { BenchmarkDescriptor, BenchmarkMarketDataPort } from './BenchmarkMarketData';

export const MARKET_SNAPSHOT_V1 = 'MARKET_SNAPSHOT_V1' as const;
export const MARKET_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const AGG_TRADE_SNAPSHOT_WINDOW_MS = 300_000 as const;

export type SnapshotAggregateHealth = 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE';
export type SnapshotCapabilityStatus = 'NOT_REQUESTED' | 'AVAILABLE' | 'UNAVAILABLE';
export type SnapshotTimestampDomain = 'LOCAL_CAPTURE' | 'EVENT_TIME' | 'NONE';

export interface SnapshotCapability<T> {
  readonly requested: boolean;
  readonly status: SnapshotCapabilityStatus;
  readonly health: NeutralFeatureHealth | 'NOT_REQUESTED';
  readonly value: T | null;
  readonly sourceTimestampMs: number | null;
  readonly sourceTimestampDomain: SnapshotTimestampDomain;
  readonly error?: string;
}

export interface SnapshotFlowRequest {
  readonly windowMs: number;
}

export interface SnapshotCandleRequest {
  readonly interval: string;
  readonly limit: number;
}

export interface SnapshotCapabilityRequest {
  readonly quote?: boolean;
  readonly orderBookFeatures?: boolean;
  readonly aggTrade?: boolean | SnapshotFlowRequest;
  readonly candles?: SnapshotCandleRequest;
}

export interface MarketSnapshotRequest extends SnapshotCapabilityRequest {
  readonly symbol: string;
  readonly benchmark?: SnapshotCapabilityRequest & {
    readonly descriptor: BenchmarkDescriptor;
  };
}

export interface SnapshotPrimaryMarketData {
  readonly quote: SnapshotCapability<QuoteFeaturesV1>;
  readonly orderBookFeatures: SnapshotCapability<OrderBookFeaturesV1>;
  readonly aggTrade: SnapshotCapability<AggTradeFeaturesV1> & {
    readonly requestedWindowMs: number | null;
  };
  readonly candles: SnapshotCapability<CandleFeaturesV1> & {
    readonly interval: string | null;
    readonly limit: number | null;
  };
}

export interface SnapshotBenchmarkMarketData {
  readonly descriptor: BenchmarkDescriptor;
  readonly data: SnapshotPrimaryMarketData;
}

export interface MarketSnapshotProvenance {
  readonly snapshotSchemaVersion: 1;
  readonly featureSchema: 'SHARED_MARKET_FEATURES_V1';
  readonly symbol: string;
  readonly request: MarketSnapshotRequest;
  readonly benchmark?: BenchmarkDescriptor;
}

export interface MarketSnapshotV1 {
  readonly schemaVersion: 1;
  readonly snapshotId: string;
  readonly symbol: string;
  readonly captureStartedAtMs: number;
  readonly capturedAtMs: number;
  readonly primary: SnapshotPrimaryMarketData;
  readonly benchmark?: SnapshotBenchmarkMarketData;
  readonly health: SnapshotAggregateHealth;
  readonly provenance: MarketSnapshotProvenance;
}

export interface AggTradeFeatureReader {
  getTakerFlow(windowMs: number): AggTradeFlowInput;
}

export interface MarketSnapshotSources {
  readonly quoteFor?: (symbol: string) => QuotePort | undefined;
  readonly orderBookFor?: (symbol: string) => OrderBookPort | undefined;
  readonly aggTradeFor?: (symbol: string) => AggTradeFeatureReader | undefined;
  readonly candles?: CandlePort;
  readonly benchmark?: BenchmarkMarketDataPort;
}

export interface SnapshotClock {
  now(): number;
}

type SnapshotFeature = {
  readonly health: NeutralFeatureHealth;
  readonly observedAtMs: number | null;
};

export class MarketSnapshotProvider {
  constructor(
    private readonly sources: MarketSnapshotSources,
    private readonly clock: SnapshotClock,
  ) {}

  async capture(request: MarketSnapshotRequest): Promise<MarketSnapshotV1> {
    const symbol = normalizeSymbol(request.symbol);
    const captureStartedAtMs = this.readClock();
    const primary = await this.readMarketData(symbol, request);
    let benchmark: SnapshotBenchmarkMarketData | undefined;
    if (request.benchmark) benchmark = await this.readBenchmark(request.benchmark);
    const capturedAtMs = this.readClock();
    if (capturedAtMs < captureStartedAtMs) throw new Error('INVALID_SNAPSHOT_CAPTURE_BOUNDARY');
    const causalPrimary = validateLocalCausality(primary, capturedAtMs);
    const causalBenchmark = benchmark
      ? { ...benchmark, data: validateLocalCausality(benchmark.data, capturedAtMs) }
      : undefined;
    const provenance = Object.freeze({
      snapshotSchemaVersion: MARKET_SNAPSHOT_SCHEMA_VERSION,
      featureSchema: 'SHARED_MARKET_FEATURES_V1' as const,
      symbol,
      request: freezeClone({ ...request, symbol }),
      ...(causalBenchmark ? { benchmark: freezeClone(causalBenchmark.descriptor) } : {}),
    });
    const snapshotWithoutId = {
      schemaVersion: MARKET_SNAPSHOT_SCHEMA_VERSION,
      symbol,
      captureStartedAtMs,
      capturedAtMs,
      primary: causalPrimary,
      ...(causalBenchmark ? { benchmark: causalBenchmark } : {}),
      health: aggregateHealth(causalPrimary, causalBenchmark?.data),
      provenance,
    };
    const snapshotId = hashCanonical(snapshotWithoutId);
    return deepFreeze({ ...snapshotWithoutId, snapshotId });
  }

  private async readMarketData(
    symbol: string,
    request: SnapshotCapabilityRequest,
  ): Promise<SnapshotPrimaryMarketData> {
    return this.readCapabilities(symbol, request, {
      quote: () => {
        const source = this.sources.quoteFor?.(symbol);
        if (!source) throw new Error('QUOTE_SOURCE_UNAVAILABLE');
        return calculateQuoteFeaturesV1(source.getQuote());
      },
      orderBookFeatures: () => {
        const source = this.sources.orderBookFor?.(symbol);
        if (!source) throw new Error('ORDER_BOOK_SOURCE_UNAVAILABLE');
        const health = source.getHealth();
        return calculateOrderBookFeaturesV1({ state: source.getState(), health });
      },
      aggTrade: () => {
        const source = this.sources.aggTradeFor?.(symbol);
        if (!source) throw new Error('AGG_TRADE_SOURCE_UNAVAILABLE');
        return calculateAggTradeFeaturesV1(source.getTakerFlow(AGG_TRADE_SNAPSHOT_WINDOW_MS));
      },
      candles: async (candleRequest) => {
        const config = candleRequest as SnapshotCandleRequest;
        if (!this.sources.candles) throw new Error('CANDLE_SOURCE_UNAVAILABLE');
        return calculateCandleFeaturesV1(
          await this.sources.candles.getSeries(symbol, config.interval, config.limit),
        );
      },
    });
  }

  private async readBenchmark(
    request: NonNullable<MarketSnapshotRequest['benchmark']>,
  ): Promise<SnapshotBenchmarkMarketData> {
    const descriptor = freezeClone({
      id: request.descriptor.id,
      symbol: normalizeSymbol(request.descriptor.symbol),
    });
    let dataSource: ReturnType<BenchmarkMarketDataPort['getBenchmark']> | undefined;
    try {
      dataSource = this.sources.benchmark?.getBenchmark(descriptor);
    } catch {
      dataSource = undefined;
    }
    const data = await this.readCapabilities(descriptor.symbol, request, {
      quote: () => {
        if (!dataSource?.quote) throw new Error('BENCHMARK_QUOTE_SOURCE_UNAVAILABLE');
        return calculateQuoteFeaturesV1(dataSource.quote.getQuote());
      },
      orderBookFeatures: () => {
        if (!dataSource?.orderBook) throw new Error('BENCHMARK_ORDER_BOOK_SOURCE_UNAVAILABLE');
        const health = dataSource.orderBook.getHealth();
        return calculateOrderBookFeaturesV1({ state: dataSource.orderBook.getState(), health });
      },
      aggTrade: () => {
        throw new Error('BENCHMARK_AGG_TRADE_SOURCE_UNAVAILABLE');
      },
      candles: async (candleRequest) => {
        if (!dataSource) throw new Error('BENCHMARK_SOURCE_UNAVAILABLE');
        const config = candleRequest as SnapshotCandleRequest;
        return calculateCandleFeaturesV1(
          await dataSource.candles.getSeries(config.interval, config.limit),
        );
      },
    });
    return { descriptor, data };
  }

  private async readCapabilities(
    symbol: string,
    request: SnapshotCapabilityRequest,
    readers: {
      quote: () => QuoteFeaturesV1;
      orderBookFeatures: () => OrderBookFeaturesV1;
      aggTrade: () => AggTradeFeaturesV1;
      candles: (request: SnapshotCandleRequest) => Promise<CandleFeaturesV1>;
    },
  ): Promise<SnapshotPrimaryMarketData> {
    const aggTradeRequested = request.aggTrade === true || typeof request.aggTrade === 'object';
    const aggTradeWindowIsCanonical =
      request.aggTrade === true ||
      (typeof request.aggTrade === 'object' &&
        request.aggTrade.windowMs === AGG_TRADE_SNAPSHOT_WINDOW_MS);
    const quote = await this.readOne(request.quote === true, readers.quote, 'LOCAL_CAPTURE');
    const orderBookFeatures = await this.readOne(
      request.orderBookFeatures === true,
      readers.orderBookFeatures,
      'LOCAL_CAPTURE',
    );
    const aggTrade = (await this.readOne(
      aggTradeRequested,
      aggTradeWindowIsCanonical
        ? readers.aggTrade
        : () => {
            throw new Error('AGG_TRADE_WINDOW_NOT_SUPPORTED');
          },
      'EVENT_TIME',
    )) as SnapshotPrimaryMarketData['aggTrade'];
    const candles = (await this.readOne(
      request.candles !== undefined,
      () => readers.candles(request.candles!),
      'LOCAL_CAPTURE',
    )) as SnapshotPrimaryMarketData['candles'];
    const result = { quote, orderBookFeatures, aggTrade, candles };
    return {
      ...result,
      aggTrade: {
        ...result.aggTrade,
        requestedWindowMs: requestedAggTradeWindow(request.aggTrade),
      },
      candles: {
        ...result.candles,
        interval: request.candles?.interval ?? null,
        limit: request.candles?.limit ?? null,
      },
    };
  }

  private async readOne<T extends SnapshotFeature>(
    requested: boolean,
    reader: () => T | Promise<T>,
    timestampDomain: SnapshotTimestampDomain,
  ): Promise<SnapshotCapability<T>> {
    if (!requested)
      return {
        requested: false,
        status: 'NOT_REQUESTED',
        health: 'NOT_REQUESTED',
        value: null,
        sourceTimestampMs: null,
        sourceTimestampDomain: 'NONE',
      };
    try {
      return capabilityFromValue(await reader(), timestampDomain);
    } catch (error) {
      return unavailableCapability(error, timestampDomain);
    }
  }

  private readClock(): number {
    const value = this.clock.now();
    if (!Number.isFinite(value) || value < 0) throw new Error('INVALID_SNAPSHOT_CLOCK');
    return value;
  }
}

function requestedAggTradeWindow(request: SnapshotCapabilityRequest['aggTrade']): number | null {
  if (request === undefined || request === false) return null;
  return request === true ? AGG_TRADE_SNAPSHOT_WINDOW_MS : request.windowMs;
}

function capabilityFromValue<T extends SnapshotFeature>(
  value: T,
  sourceTimestampDomain: SnapshotTimestampDomain,
): SnapshotCapability<T> {
  const usable = value.health === 'HEALTHY';
  return {
    requested: true,
    status: usable ? 'AVAILABLE' : 'UNAVAILABLE',
    health: value.health,
    value: usable ? value : null,
    sourceTimestampMs: value.observedAtMs,
    sourceTimestampDomain,
  };
}

function unavailableCapability(
  error: unknown,
  sourceTimestampDomain: SnapshotTimestampDomain,
): SnapshotCapability<never> {
  return {
    requested: true,
    status: 'UNAVAILABLE',
    health: 'UNAVAILABLE',
    value: null,
    sourceTimestampMs: null,
    sourceTimestampDomain,
    error: String(error),
  };
}

function validateLocalCausality(data: SnapshotPrimaryMarketData, capturedAtMs: number) {
  const validate = <T>(capability: SnapshotCapability<T>): SnapshotCapability<T> => {
    if (capability.status !== 'AVAILABLE' || capability.value === null) return capability;
    if (
      capability.sourceTimestampDomain === 'LOCAL_CAPTURE' &&
      capability.sourceTimestampMs !== null &&
      capability.sourceTimestampMs > capturedAtMs
    )
      return {
        requested: true,
        status: 'UNAVAILABLE',
        health: 'ANOMALOUS',
        value: null,
        sourceTimestampMs: capability.sourceTimestampMs,
        sourceTimestampDomain: capability.sourceTimestampDomain,
        error: 'SOURCE_OBSERVED_AFTER_CAPTURE_BOUNDARY',
      };
    return capability;
  };
  return {
    ...data,
    quote: validate(data.quote),
    orderBookFeatures: validate(data.orderBookFeatures),
    candles: {
      ...validate(data.candles),
      interval: data.candles.interval,
      limit: data.candles.limit,
    },
  };
}

function aggregateHealth(
  primary: SnapshotPrimaryMarketData,
  benchmark?: SnapshotPrimaryMarketData,
): SnapshotAggregateHealth {
  const capabilities = [
    ...Object.values(primary),
    ...(benchmark ? Object.values(benchmark) : []),
  ].filter((capability): capability is SnapshotCapability<unknown> => 'status' in capability);
  const requested = capabilities.filter((capability) => capability.requested);
  const available = requested.filter((capability) => capability.status === 'AVAILABLE');
  if (available.length === requested.length && requested.length > 0) return 'COMPLETE';
  if (available.length > 0) return 'PARTIAL';
  return 'UNAVAILABLE';
}

function normalizeSymbol(symbol: string): string {
  return symbol.toUpperCase();
}

function hashCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function freezeClone<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
