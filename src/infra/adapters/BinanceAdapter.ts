// src/infra/adapters/BinanceAdapter.ts
import Binance, { type QueryFuturesOrderResult } from 'binance-api-node';
import {
  Exchange,
  PositionInfo,
  SymbolFilters,
  TradeFill,
  FundingSnapshot,
  BasisSnapshot,
  EntryRecoveryExpectation,
  RecoverableEntryPosition,
  MicroBurstEntryRiskEvidence,
  IdentifiedStopRequest,
} from '../../app/ports/Exchange';
import { Candle, Side } from '../../core/types';
import { CONFIG } from '../config/environment';
import { Logger } from '../../app/ports/Logger';
import {
  getRateLimitMetrics,
  isRateLimited,
  noteRateLimitBlockedRequest,
  noteRateLimitFromError,
  parseRateLimitError,
} from './rate-limit';
import { SharedBinanceRateLimiter } from './shared-binance-rate-limit';
import { randomBytes } from 'node:crypto';
import {
  validMicroBurstSettlementIdentity,
  reconcileMicroBurstEconomics,
  validMicroBurstEconomicIdentity,
  type MicroBurstEconomicIdentity,
  type MicroBurstSettlementIdentity,
  type MicroBurstSettlementEvidence,
} from '../../strategies/micro-burst/domain/MicroBurstSettlement';

type SharedRequestPriority = 'normal' | 'critical';

function validIdentifiedStop(request: IdentifiedStopRequest): boolean {
  return (
    /^[A-Z0-9]+$/.test(request.symbol) &&
    /^bot_sl_[a-f0-9]{28}$/.test(request.clientOrderId) &&
    Number.isFinite(request.triggerPrice) &&
    request.triggerPrice > 0 &&
    request.workingType === 'MARK_PRICE' &&
    (request.side === 'LONG' || request.side === 'SHORT') &&
    (request.closePosition === true
      ? request.quantity === undefined &&
        request.reduceOnly === undefined &&
        ['BOTH', request.side].includes(request.positionSide)
      : request.closePosition === false &&
        request.positionSide === 'BOTH' &&
        request.reduceOnly === true &&
        Number.isFinite(request.quantity) &&
        quantityUnits(request.quantity!) !== undefined)
  );
}

function matchesStopCoverage(
  request: IdentifiedStopRequest,
  order: Record<string, unknown>,
): boolean {
  if (request.closePosition) return order.closePosition === true || order.closePosition === 'true';
  return (
    (order.closePosition === false || order.closePosition === 'false') &&
    (order.reduceOnly === true || order.reduceOnly === 'true') &&
    quantityUnits(order.quantity as string | number) === quantityUnits(request.quantity!)
  );
}

function isBotProtectionId(value: unknown): boolean {
  return (
    typeof value === 'string' && (value.startsWith('se_') || /^bot_sl_[a-f0-9]{28}$/.test(value))
  );
}

/** Exact decimal quantity comparison, without accepting a missing fill via float tolerance. */
function quantityUnits(value: string | number): bigint | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const text = String(value);
  if (text.length > 128) return undefined;
  const parsed = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(text);
  if (!parsed) return undefined;
  const scale = 18 + Number(parsed[3] ?? 0) - (parsed[2]?.length ?? 0);
  if (!Number.isSafeInteger(scale) || Math.abs(scale) > 36) return undefined;
  const digits = BigInt(parsed[1] + (parsed[2] ?? ''));
  if (digits <= 0) return undefined;
  if (scale >= 0) return digits * BigInt(10) ** BigInt(scale);
  const divisor = BigInt(10) ** BigInt(-scale);
  return digits % divisor === BigInt(0) ? digits / divisor : undefined;
}

const DEFAULT_MIN_REQ_GAP_MS = Number(process.env.BINANCE_REQ_GAP_MS ?? 40);
const EXCHANGE_INFO_TTL_MS = Number(process.env.BINANCE_EXCHANGEINFO_TTL_MS ?? 5 * 60_000);
const LEVERAGE_BRACKET_TTL_MS = Number(process.env.BINANCE_BRACKET_TTL_MS ?? 2 * 60_000);
const LEVERAGE_CACHE_TTL_MS = Number(process.env.BINANCE_LEVERAGE_TTL_MS ?? 30_000);
const DEFAULT_REQUEST_WEIGHT = 5;
const REQUEST_WEIGHT_WINDOW_MS = 60_000;
const MAX_REQUEST_WEIGHT_PER_MINUTE = Number(
  process.env.BINANCE_MAX_REQUEST_WEIGHT_PER_MINUTE ?? 2_000,
);

type CandleCacheEntry = {
  candles: Candle[];
  ts: number;
  interval: string;
  ttl: number;
};

type HedgeMode = boolean | 'UNKNOWN';

const CANDLE_INTERVAL_SETTINGS: Record<string, { minFetch: number; ttl: number }> = {
  '1m': { minFetch: 240, ttl: 5_000 },
  '3m': { minFetch: 240, ttl: 7_000 },
  '5m': { minFetch: 320, ttl: 10_000 },
  '15m': { minFetch: 180, ttl: 20_000 },
  '30m': { minFetch: 160, ttl: 30_000 },
  '1h': { minFetch: 160, ttl: 60_000 },
  '2h': { minFetch: 140, ttl: 90_000 },
  '4h': { minFetch: 120, ttl: 120_000 },
  '6h': { minFetch: 100, ttl: 180_000 },
  '8h': { minFetch: 90, ttl: 240_000 },
  '12h': { minFetch: 72, ttl: 240_000 },
  '1d': { minFetch: 5, ttl: 300_000 },
  '3d': { minFetch: 5, ttl: 300_000 },
  '1w': { minFetch: 5, ttl: 300_000 },
  '1M': { minFetch: 5, ttl: 300_000 },
};

function resolveCandleSettings(interval: string, limit: number): { fetch: number; ttl: number } {
  const preset = CANDLE_INTERVAL_SETTINGS[interval];
  if (preset) {
    return {
      fetch: Math.max(limit, preset.minFetch),
      ttl: preset.ttl,
    };
  }
  if (interval.endsWith('m')) {
    return { fetch: Math.max(limit, 240), ttl: 10_000 };
  }
  if (interval.endsWith('h')) {
    return { fetch: Math.max(limit, 120), ttl: 120_000 };
  }
  if (interval.endsWith('d') || interval === '1w' || interval === '1M') {
    return { fetch: Math.max(limit, 5), ttl: 300_000 };
  }
  return { fetch: limit, ttl: 10_000 };
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function rawHttpError(prefix: string, status: number, body: string, retryAfter?: string | null) {
  const error = Object.assign(new Error(`${prefix}: ${status} ${body}`), {
    status,
    response: { status, data: { msg: body } },
    retryAfter: retryAfter ?? undefined,
  });
  return error;
}

function isTrueish(v: unknown): boolean {
  return v === true || v === 'true' || v === 'TRUE' || v === 1 || v === '1';
}

function canonicalMarginType(value: unknown): 'ISOLATED' | 'CROSSED' | undefined {
  const normalized = String(value ?? '').toUpperCase();
  if (normalized === 'ISOLATED') return 'ISOLATED';
  if (normalized === 'CROSS' || normalized === 'CROSSED') return 'CROSSED';
  return undefined;
}

function bracketClientId(kind: 'sl' | 'tp', symbol: string, side: Side): string {
  // Keep the ownership prefix while making retries and concurrent positions distinct.
  const nonce = randomBytes(10).toString('hex');
  return `se_${kind}_${nonce}_${symbol}_${side}`.slice(0, 36);
}

function isUnknownOrderError(error: unknown): boolean {
  const candidate = error as {
    code?: unknown;
    response?: { data?: { code?: unknown } };
    body?: { code?: unknown };
  };
  return [candidate?.code, candidate?.response?.data?.code, candidate?.body?.code]
    .map((code) => Number(code))
    .some((code) => code === -2013);
}

import { WebSocketManager } from './WebSocketManager';
import type {
  BinanceDepthDiffEvent,
  BinanceDepthSnapshot,
  LiveCandleUpdate,
} from '../../app/ports/MarketData';

export class BinanceExchange implements Exchange {
  private cli = Binance({
    apiKey: CONFIG.API_KEY,
    apiSecret: CONFIG.API_SECRET,
    httpFutures: CONFIG.HTTP_FUTURES,
    wsFutures: CONFIG.WS_FUTURES,
  });
  private wsManager: WebSocketManager;

  private hedgeCache?: { value: boolean; at: number };
  private candleCache = new Map<string, CandleCacheEntry>();
  private markCache = new Map<string, { price: number; ts: number }>();
  private markPriceInflight?: Promise<void>;
  private fundingCache = new Map<string, { snapshot: FundingSnapshot; ts: number }>();
  private basisCache = new Map<string, { snapshot: BasisSnapshot; ts: number }>();

  private usdtCache?: { value: number; ts: number };
  private filtersCache = new Map<
    string,
    {
      filters: SymbolFilters;
      ts: number;
      leverage: number;
    }
  >();
  private exchangeInfoCache?: { data: any; ts: number };
  private leverageBracketCache = new Map<string, { data: any; ts: number }>();
  private marginTypeCache = new Map<string, { type: 'ISOLATED' | 'CROSSED'; ts: number }>();
  private leverageCache = new Map<string, { leverage: number; ts: number }>();
  private marginInflight = new Map<string, Promise<void>>();
  private leverageInflight = new Map<string, Promise<void>>();
  private accountInfoCache?: { data: any; ts: number };
  private wsCandleCache: Record<string, Candle> = {}; // Real-time cache
  private requestQueue: Promise<void> = Promise.resolve();
  private nextRequestAt = 0;
  private readonly minReqGapMs = Math.max(0, DEFAULT_MIN_REQ_GAP_MS);
  private readonly recentRequestWeights: Array<{ at: number; weight: number }> = [];
  private readonly sharedRateLimiter = new SharedBinanceRateLimiter('01-Trading-Bot');
  private readonly depthSnapshotInflight = new Map<string, Promise<BinanceDepthSnapshot>>();
  private requestMetrics = {
    requests: 0,
    totalWeight: 0,
    weightBlocked: 0,
    cooldownBlocked: 0,
  };
  private readonly accountInfoTtlMs = Number(process.env.BINANCE_ACCOUNTINFO_TTL_MS ?? 250);

  constructor(private log: Logger) {
    this.wsManager = new WebSocketManager(this.cli, log, { isTestnet: CONFIG.IS_TESTNET });
    const isTestnet = process.env.IS_TESTNET === '1';
    void this.enqueue(() => this.cli.futuresPing(), DEFAULT_REQUEST_WEIGHT, 'ping')
      .then(() => {
        this.log.info('binance_connected', {
          net: isTestnet ? 'TESTNET' : 'PROD',
          http: CONFIG.HTTP_FUTURES,
          ws: CONFIG.WS_FUTURES,
        });
        this.log.info('ping_ok');
      })
      .catch((err: any) => {
        noteRateLimitFromError(err);
        this.log.error('binance_connect_error', { err: err?.message || String(err) });
      });
  }

  public getRequestMetrics() {
    return {
      ...this.requestMetrics,
      weightUsed: this.getRequestWeightUsed(),
      maxWeightPerMinute: MAX_REQUEST_WEIGHT_PER_MINUTE,
      shared: this.sharedRateLimiter.getMetrics(),
    };
  }

  private enqueue<T>(
    task: () => Promise<T>,
    weight = DEFAULT_REQUEST_WEIGHT,
    endpoint = 'unknown',
    priority: SharedRequestPriority = 'normal',
  ): Promise<T> {
    const run = async () => {
      await this.sharedRateLimiter.acquire(weight, endpoint, priority);
      while (isRateLimited()) {
        noteRateLimitBlockedRequest();
        this.requestMetrics.cooldownBlocked++;
        await sleep(Math.max(25, Math.min(5_000, getRateLimitMetrics().banUntil - Date.now())));
      }
      const requestWeight = Math.max(1, weight);
      while (this.getRequestWeightUsed() + requestWeight > MAX_REQUEST_WEIGHT_PER_MINUTE) {
        this.requestMetrics.weightBlocked++;
        const oldest = this.recentRequestWeights[0];
        await sleep(Math.max(25, oldest.at + REQUEST_WEIGHT_WINDOW_MS - Date.now()));
      }
      const wait = Math.max(0, this.nextRequestAt - Date.now());
      if (wait > 0) await sleep(wait);
      try {
        const at = Date.now();
        this.recentRequestWeights.push({ at, weight: requestWeight });
        this.requestMetrics.requests++;
        this.requestMetrics.totalWeight += requestWeight;
        const result = await task();
        this.nextRequestAt = Date.now() + this.minReqGapMs;
        return result;
      } catch (err) {
        this.nextRequestAt = Date.now() + this.minReqGapMs;
        noteRateLimitFromError(err);
        const details = parseRateLimitError(err);
        if (details?.banUntil)
          this.sharedRateLimiter.noteRateLimit(details.banUntil, details.status);
        throw err;
      }
    };

    const chained = this.requestQueue.then(run, run);
    this.requestQueue = chained.then(
      () => undefined,
      () => undefined,
    );
    return chained;
  }

  private getRequestWeightUsed(now = Date.now()): number {
    while (
      this.recentRequestWeights.length &&
      this.recentRequestWeights[0].at <= now - REQUEST_WEIGHT_WINDOW_MS
    ) {
      this.recentRequestWeights.shift();
    }
    return this.recentRequestWeights.reduce((total, item) => total + item.weight, 0);
  }

  private invalidateAccountInfo() {
    this.accountInfoCache = undefined;
  }

  private async getAccountInfo(force = false): Promise<any> {
    const cached = this.accountInfoCache;
    const now = Date.now();
    if (!force && cached && now - cached.ts < this.accountInfoTtlMs) {
      return cached.data;
    }
    try {
      const info = await this.enqueue(
        () => this.cli.futuresAccountInfo(),
        DEFAULT_REQUEST_WEIGHT,
        'account_info',
      );
      this.accountInfoCache = { data: info, ts: Date.now() };
      return info;
    } catch (err) {
      this.invalidateAccountInfo();
      noteRateLimitFromError(err);
      throw err;
    }
  }

  private cacheKey(symbol: string, interval: string) {
    return `${symbol}|${interval}`;
  }

  private fromRestCandle(c: any): Candle {
    return {
      openTime: c.openTime,
      timestamp: c.openTime, // Alias
      open: +c.open,
      high: +c.high,
      low: +c.low,
      close: +c.close,
      volume: +c.volume,
      buyVolume: +(c.baseAssetVolume || c.buyVolume || 0),
      closeTime: c.closeTime,
    };
  }

  private async fetchCandles(symbol: string, interval: string, limit: number) {
    try {
      const raw = await this.enqueue(
        () => this.cli.futuresCandles({ symbol, interval: interval as any, limit }),
        DEFAULT_REQUEST_WEIGHT,
        'candles',
      );
      return raw.map((c) => this.fromRestCandle(c));
    } catch (err) {
      const until = noteRateLimitFromError(err);
      if (until) {
        this.log.warn('rest_candles_rate_limited', { symbol, interval, limit, banUntil: until });
      }
      throw err;
    }
  }

  async getFundingRate(symbol: string): Promise<FundingSnapshot> {
    const now = Date.now();
    const cached = this.fundingCache.get(symbol);
    if (cached && now - cached.ts < 60_000) {
      return cached.snapshot;
    }
    const data = await this.enqueue(
      () => this.cli.futuresFundingRate({ symbol, limit: 1 }),
      DEFAULT_REQUEST_WEIGHT,
      'funding_rate',
    );
    const entry = Array.isArray(data) && data.length ? data[0] : undefined;
    const rate = entry && entry.fundingRate !== undefined ? Number(entry.fundingRate) : NaN;
    const nextFundingTime =
      entry && entry.fundingTime !== undefined ? Number(entry.fundingTime) : undefined;
    const snapshot: FundingSnapshot = { rate, nextFundingTime };
    this.fundingCache.set(symbol, { snapshot, ts: now });
    return snapshot;
  }

  async getBasisSnapshot(symbol: string): Promise<BasisSnapshot> {
    const now = Date.now();
    const cached = this.basisCache.get(symbol);
    if (cached && now - cached.ts < 5_000) {
      return cached.snapshot;
    }
    const markData = await this.enqueue(
      () => this.cli.futuresMarkPrice(),
      DEFAULT_REQUEST_WEIGHT,
      'mark_price',
    );
    const entry = Array.isArray(markData)
      ? (markData.find((r: any) => r.symbol === symbol) as any)
      : (markData as any);
    const markPrice = entry && entry.markPrice !== undefined ? Number(entry.markPrice) : NaN;
    const indexPrice = entry && entry.indexPrice !== undefined ? Number(entry.indexPrice) : NaN;
    const basisPct =
      Number.isFinite(markPrice) && Number.isFinite(indexPrice) && indexPrice !== 0
        ? (markPrice - indexPrice) / Math.abs(indexPrice)
        : NaN;
    const basisSnapshot: BasisSnapshot = { markPrice, indexPrice, basisPct };
    this.basisCache.set(symbol, { snapshot: basisSnapshot, ts: now });
    return basisSnapshot;
  }

  private async getExchangeInfoSnapshot(): Promise<any> {
    const now = Date.now();
    if (this.exchangeInfoCache && now - this.exchangeInfoCache.ts < EXCHANGE_INFO_TTL_MS) {
      return this.exchangeInfoCache.data;
    }
    try {
      const data = await this.enqueue(
        () => this.cli.futuresExchangeInfo(),
        DEFAULT_REQUEST_WEIGHT,
        'exchange_info',
      );
      this.exchangeInfoCache = { data, ts: now };
      return data;
    } catch (err) {
      noteRateLimitFromError(err);
      throw err;
    }
  }

  private async getLeverageBrackets(symbol: string): Promise<any[]> {
    const now = Date.now();
    const cached = this.leverageBracketCache.get(symbol);
    if (cached && now - cached.ts < LEVERAGE_BRACKET_TTL_MS) {
      return cached.data;
    }
    try {
      const data = await this.enqueue(
        () =>
          this.cli.futuresLeverageBracket({
            symbol,
            recvWindow: Number(process.env.BINANCE_RECV_WINDOW ?? 20_000),
          }),
        DEFAULT_REQUEST_WEIGHT,
        'leverage_bracket',
      );
      this.leverageBracketCache.set(symbol, { data, ts: now });
      return data;
    } catch (err) {
      noteRateLimitFromError(err);
      throw err;
    }
  }

  private async isHedgeMode(): Promise<HedgeMode> {
    if (this.hedgeCache && Date.now() - this.hedgeCache.at < 60_000) {
      return this.hedgeCache.value;
    }
    try {
      const pm: any = await this.enqueue(
        () => (this.cli as any).futuresPositionMode(),
        DEFAULT_REQUEST_WEIGHT,
        'position_mode',
      );
      const val = !!pm?.dualSidePosition;
      this.hedgeCache = { value: val, at: Date.now() };
      return val;
    } catch (err) {
      noteRateLimitFromError(err);
      return 'UNKNOWN';
    }
  }

  private async mutationHedgeMode(): Promise<boolean> {
    const hedge = await this.isHedgeMode();
    if (hedge === 'UNKNOWN') {
      throw new Error('Cannot place order: Binance position mode is unknown');
    }
    return hedge;
  }

  private static posSideMismatch(e: any) {
    const m = (e?.message || '').toLowerCase();
    return m.includes('positionside') || m.includes('position side');
  }

  /**
   * Get price precision (decimal places) for a symbol from cached exchange info.
   * Falls back to 2 for USDT pairs if cache is not available.
   */
  private getPricePrecision(symbol: string): number {
    if (this.exchangeInfoCache) {
      const s = this.exchangeInfoCache.data.symbols?.find((x: any) => x.symbol === symbol);
      if (s) {
        const pf = s.filters.find((f: any) => f.filterType === 'PRICE_FILTER');
        if (pf?.tickSize) {
          const tickStr = String(pf.tickSize);
          if (tickStr.includes('.')) {
            // Count significant decimal places (e.g., "0.01" → 2)
            const decimals = tickStr.split('.')[1]!;
            const trimmed = decimals.replace(/0+$/, '');
            return Math.max(trimmed.length, 0);
          }
          return 0;
        }
      }
    }
    // Default: 2 for USDT pairs (ETH, BTC, etc.)
    return 2;
  }

  /** Format a price to the correct precision for the symbol */
  private formatPrice(symbol: string, price: number): string {
    return price.toFixed(this.getPricePrecision(symbol));
  }

  // ---------- Exchange implementation ----------

  async getServerTime() {
    try {
      const t: any = await this.enqueue(
        () => this.cli.futuresTime(),
        DEFAULT_REQUEST_WEIGHT,
        'server_time',
      );
      return Number((t && t.serverTime) ?? t);
    } catch (err) {
      noteRateLimitFromError(err);
      throw err;
    }
  }

  async getCandles(symbol: string, interval: string, limit: number): Promise<Candle[]> {
    const key = this.cacheKey(symbol, interval);
    const cached = this.candleCache.get(key);
    const now = Date.now();

    const { fetch, ttl } = resolveCandleSettings(interval, limit);

    if (cached && now - cached.ts < ttl && cached.candles.length >= limit) {
      return cached.candles.slice(-limit);
    }

    const candles = await this.fetchCandles(symbol, interval, fetch);
    this.candleCache.set(key, { candles, ts: now, interval, ttl });
    return candles.slice(-limit);
  }

  async getLastCandle(symbol: string): Promise<Candle | null> {
    if (this.wsCandleCache[symbol]) {
      return this.wsCandleCache[symbol];
    }
    const candles = await this.getCandles(symbol, '5m', 1);
    return candles.length > 0 ? candles[candles.length - 1] : null;
  }

  getCachedCandles(symbol: string, interval: string, limit: number): Candle[] {
    const normalizedSymbol = String(symbol || '').toUpperCase();
    const candles = this.candleCache.get(this.cacheKey(normalizedSymbol, interval))?.candles || [];
    const wsCandle = interval === '5m' ? this.wsCandleCache[normalizedSymbol] : undefined;
    const merged = wsCandle
      ? [...candles.filter((candle) => candle.openTime !== wsCandle.openTime), wsCandle]
      : candles;
    return merged.slice(-Math.max(0, limit));
  }

  public subscribeToKlineCandles(
    symbol: string,
    interval: string,
    callback: (update: LiveCandleUpdate) => void,
  ): () => void {
    const normalizedSymbol = String(symbol || '').toUpperCase();
    return this.wsManager.connectCandles(normalizedSymbol, interval, (wsCandle) => {
      const candle: Candle = {
        openTime: wsCandle.startTime,
        timestamp: wsCandle.startTime,
        open: Number(wsCandle.open),
        high: Number(wsCandle.high),
        low: Number(wsCandle.low),
        close: Number(wsCandle.close),
        volume: Number(wsCandle.volume),
        buyVolume: Number((wsCandle as any).buyVolume || (wsCandle as any).baseAssetVolume || 0),
        closeTime: wsCandle.closeTime,
      };
      if (interval === '5m') this.wsCandleCache[normalizedSymbol] = candle;
      callback({
        symbol: normalizedSymbol,
        interval,
        candle: { ...candle },
        observedAtMs: Date.now(),
        source: 'WEBSOCKET',
      });
    });
  }

  public subscribeToCandles(symbol: string): () => void {
    const unsubscribeCandle = this.wsManager.connectCandles(symbol, '5m', (wsCandle) => {
      // Base candle processing
      const candle: Candle = {
        openTime: wsCandle.startTime,
        timestamp: wsCandle.startTime,
        open: Number(wsCandle.open),
        high: Number(wsCandle.high),
        low: Number(wsCandle.low),
        close: Number(wsCandle.close),
        volume: Number(wsCandle.volume),
        // We initialize buyVolume from the WS candle, but the aggTrades will overlay on it
        buyVolume: Number((wsCandle as any).buyVolume || (wsCandle as any).baseAssetVolume || 0),
        closeTime: wsCandle.closeTime,
      };

      // Preserve the accumulated buyVolume if the aggTrade stream has already started filling it
      // but only if the candle timestamps match (meaning we are still in the same 5m period)
      const existingCandle = this.wsCandleCache[symbol];
      if (existingCandle && existingCandle.openTime === candle.openTime) {
        // Keep the max: either the Binance kline update, or our high-frequency aggTrade accumulation
        candle.buyVolume = Math.max(candle.buyVolume, existingCandle.buyVolume);
      }

      this.wsCandleCache[symbol] = candle;
    });

    // Sub-candle High-Frequency AggTrade accumulation (The 10th Dimension Momentum Fix)
    // The kline update is slow (often every 2 seconds). aggTrade is instant (milisegundos).
    const unsubscribeAggTrade = this.wsManager.connectAggTrades(symbol, (trade) => {
      const currentCandle = this.wsCandleCache[symbol];
      if (currentCandle) {
        // isBuyerMaker = false significa que el Taker fue COMPRADOR. (Agresividad de compra)
        // En Binance, isBuyerMaker: true significa que el Maker era comprador, por ende el Taker VENDIÓ.
        // CVD Taker Buy Volume = !isBuyerMaker
        if (!trade.isBuyerMaker) {
          currentCandle.buyVolume += Number(trade.quantity);
        }
      }
    });
    return () => {
      unsubscribeCandle();
      unsubscribeAggTrade();
    };
  }

  public subscribeToPartialDepth(
    symbol: string,
    levels: number,
    speed: '100ms' | '250ms' | '500ms',
    callback: (depth: any) => void,
  ): () => void {
    return this.wsManager.connectPartialDepth(symbol, levels, speed, callback);
  }

  public subscribeToDepthDiff(
    symbol: string,
    speed: '100ms' | '250ms' | '500ms',
    callback: (depth: BinanceDepthDiffEvent) => void,
  ): () => void {
    return this.wsManager.connectDepthDiff(symbol, speed, callback);
  }

  public subscribeToAggTrades(
    symbol: string,
    callback: (trade: {
      isBuyerMaker: boolean;
      quantity: string;
      price: string;
      eventTime: number;
      receivedAtMs?: number;
      tradeTime?: number;
      aggregateTradeId?: number;
      firstTradeId?: number;
      lastTradeId?: number;
    }) => void,
    onStatus?: (status: 'connecting' | 'open' | 'reconnecting') => void,
  ): () => void {
    return this.wsManager.connectAggTrades(
      symbol,
      (trade) => {
        callback({
          isBuyerMaker: trade.isBuyerMaker,
          quantity: trade.quantity,
          price: trade.price,
          // Prefer the exchange trade timestamp for causal outcome ordering.
          eventTime: Number((trade as any).tradeTime ?? (trade as any).eventTime),
          receivedAtMs: trade.receivedAtMs,
          tradeTime: Number((trade as any).tradeTime ?? (trade as any).eventTime),
          aggregateTradeId: (trade as any).aggregateTradeId,
          firstTradeId: (trade as any).firstTradeId,
          lastTradeId: (trade as any).lastTradeId,
        });
      },
      onStatus,
    );
  }

  public async getDepthSnapshot(symbol: string, levels = 20): Promise<BinanceDepthSnapshot> {
    const key = `${symbol}:${levels}`;
    const existing = this.depthSnapshotInflight.get(key);
    if (existing) return existing;
    const request = this.enqueue(
      () => this.cli.futuresBook({ symbol, limit: levels }),
      20,
      'depth_snapshot',
    ).then((book) => ({
      lastUpdateId: book.lastUpdateId,
      bids: book.bids.map((b) => [b.price, b.quantity] as [string, string]),
      asks: book.asks.map((a) => [a.price, a.quantity] as [string, string]),
      receivedAtMs: Date.now(),
    }));
    this.depthSnapshotInflight.set(key, request);
    void request.then(
      () => this.depthSnapshotInflight.delete(key),
      () => this.depthSnapshotInflight.delete(key),
    );
    return request;
  }

  public simulateChaos(durationMs: number) {
    this.wsManager.simulateChaos(durationMs);
  }

  async getMarkPrice(symbol: string) {
    const cached = this.markCache.get(symbol);
    const now = Date.now();
    if (cached && now - cached.ts < 2_000 && Number.isFinite(cached.price)) {
      return cached.price;
    }

    try {
      if (!this.markPriceInflight) {
        this.markPriceInflight = this.enqueue(async () => {
          const snapshot = await this.cli.futuresMarkPrice();
          const ts = Date.now();
          for (const item of snapshot) {
            const priceVal = Number(item.markPrice);
            if (Number.isFinite(priceVal)) {
              this.markCache.set(item.symbol, { price: priceVal, ts });
            }
          }
        }).finally(() => {
          this.markPriceInflight = undefined;
        });
      }

      await this.markPriceInflight;
      const updated = this.markCache.get(symbol);
      if (!updated) throw new Error('markPrice missing');
      return updated.price;
    } catch (err) {
      noteRateLimitFromError(err);
      if (cached) return cached.price;
      throw err;
    }
  }

  async getUSDTBalance() {
    const now = Date.now();
    if (this.usdtCache && now - this.usdtCache.ts < 5_000) {
      return this.usdtCache.value;
    }
    try {
      const b = await this.enqueue(
        () => this.cli.futuresAccountBalance(),
        DEFAULT_REQUEST_WEIGHT,
        'account_balance',
      );
      const usdt = b.find((x) => x.asset === 'USDT');
      // NINJA v7.0 FIX: Use AVAILABLE balance (free margin) instead of total balance
      // This prevents "Insufficient Margin" errors when other positions are open.
      const value = +(usdt?.availableBalance ?? usdt?.balance ?? '0');
      this.usdtCache = { value, ts: now };
      return value;
    } catch (err) {
      noteRateLimitFromError(err);
      throw err;
    }
  }

  async getUSDTAccountSnapshot() {
    const info = await this.getAccountInfo();
    const usdtAsset = Array.isArray(info.assets)
      ? info.assets.find((asset: any) => asset.asset === 'USDT')
      : undefined;
    const walletBalance =
      this.finiteNumber(info.totalWalletBalance) ?? this.finiteNumber(usdtAsset?.walletBalance);
    const availableBalance =
      this.finiteNumber(info.availableBalance) ?? this.finiteNumber(usdtAsset?.availableBalance);
    const unrealizedPnlTotal =
      this.finiteNumber(info.totalUnrealizedProfit) ??
      this.finiteNumber(usdtAsset?.unrealizedProfit);
    const equityTotal =
      walletBalance !== undefined && unrealizedPnlTotal !== undefined
        ? walletBalance + unrealizedPnlTotal
        : (this.finiteNumber(info.totalMarginBalance) ??
          this.finiteNumber(usdtAsset?.marginBalance));

    return {
      walletBalance,
      availableBalance,
      unrealizedPnlTotal,
      equityTotal,
    };
  }

  private finiteNumber(value: unknown): number | undefined {
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    const cached = this.leverageCache.get(symbol);
    if (cached && Date.now() - cached.ts < LEVERAGE_CACHE_TTL_MS && cached.leverage === leverage) {
      this.log.debug('binance_leverage_already_desired', { symbol, leverage });
      return;
    }
    const existing = this.leverageInflight.get(symbol);
    if (existing) {
      await existing;
      return this.setLeverage(symbol, leverage);
    }
    const operation = (async () => {
      try {
        const before: any[] = await this.enqueue(
          () => this.cli.futuresPositionRisk({ symbol }),
          DEFAULT_REQUEST_WEIGHT,
          'position_risk',
        );
        const beforeRow = before.find((item) => item.symbol === symbol);
        if (beforeRow && Number(beforeRow.leverage) === leverage) {
          this.leverageCache.set(symbol, { leverage, ts: Date.now() });
          this.log.debug('binance_leverage_already_desired', { symbol, leverage });
          return;
        }
        const response: any = await this.enqueue(
          () => this.cli.futuresLeverage({ symbol, leverage }),
          DEFAULT_REQUEST_WEIGHT,
          'leverage_mutation',
          'critical',
        );
        if (Number(response?.leverage) !== leverage) {
          throw new Error(`Binance leverage response mismatch: requested ${leverage}`);
        }
        const risk: any[] = await this.enqueue(
          () => this.cli.futuresPositionRisk({ symbol }),
          DEFAULT_REQUEST_WEIGHT,
          'position_risk',
        );
        const row = risk.find((item) => item.symbol === symbol);
        if (!row || Number(row.leverage) !== leverage) {
          throw new Error(`Binance leverage readback mismatch or unavailable for ${symbol}`);
        }
        this.leverageCache.set(symbol, { leverage, ts: Date.now() });
        this.log.info('binance_leverage_changed_and_verified', { symbol, leverage });
      } catch (err) {
        noteRateLimitFromError(err);
        this.leverageCache.delete(symbol);
        throw err;
      } finally {
        this.leverageInflight.delete(symbol);
      }
    })();
    this.leverageInflight.set(symbol, operation);
    return operation;
  }

  async ensureMarginType(
    symbol: string,
    marginType: 'ISOLATED' | 'CROSSED' = 'ISOLATED',
  ): Promise<void> {
    const cached = this.marginTypeCache.get(symbol);
    if (cached && cached.type === marginType && Date.now() - cached.ts < LEVERAGE_CACHE_TTL_MS) {
      this.log.debug('binance_margin_already_desired', { symbol, marginType });
      return;
    }
    const existing = this.marginInflight.get(symbol);
    if (existing) {
      await existing;
      return this.ensureMarginType(symbol, marginType);
    }
    const operation = (async () => {
      const verify = async () => {
        const info: any = await this.getAccountInfo(true);
        const rows = (info.positions || []).filter((p: any) => p.symbol === symbol);
        const values = rows
          .map((p: any) => canonicalMarginType(p.marginType))
          .filter(
            (value: string | undefined): value is 'ISOLATED' | 'CROSSED' => value !== undefined,
          );
        return values.length > 0 && values.every((value: string) => value === marginType);
      };
      try {
        if (await verify()) {
          this.marginTypeCache.set(symbol, { type: marginType, ts: Date.now() });
          this.log.debug('binance_margin_already_desired', { symbol, marginType });
          return;
        }
        await this.enqueue(
          () => this.cli.futuresMarginType({ symbol, marginType }),
          DEFAULT_REQUEST_WEIGHT,
          'margin_mutation',
          'critical',
        );
        if (!(await verify()))
          throw new Error(`Binance margin type readback mismatch for ${symbol}`);
        this.marginTypeCache.set(symbol, { type: marginType, ts: Date.now() });
        this.log.info('binance_margin_changed_and_verified', { symbol, marginType });
      } catch (err: any) {
        noteRateLimitFromError(err);
        const msg = (err?.message || err?.msg || '').toString();
        if (/No need to change margin type|margin type cannot be changed/i.test(msg)) {
          this.marginTypeCache.set(symbol, { type: marginType, ts: Date.now() });
          this.log.debug('binance_margin_already_desired', { symbol, marginType });
          return;
        }
        this.marginTypeCache.delete(symbol);
        if (
          /timeout|timed out|fetch failed|network|429|418/i.test(msg) ||
          err?.status === 429 ||
          err?.status === 418
        ) {
          this.log.error('binance_margin_unknown_after_request', {
            symbol,
            marginType,
            error: msg,
          });
          throw new Error(`Binance margin type change is ambiguous for ${symbol}: ${msg}`);
        }
        throw err;
      } finally {
        this.marginInflight.delete(symbol);
      }
    })();
    this.marginInflight.set(symbol, operation);
    return operation;
  }

  async getSymbolFilters(symbol: string, leverage: number): Promise<SymbolFilters> {
    const now = Date.now();
    const cached = this.filtersCache.get(symbol);
    if (cached && now - cached.ts < 60_000 && cached.leverage === leverage) {
      return cached.filters;
    }
    try {
      const [bracketsResponse, exchangeInfo] = await Promise.all([
        this.getLeverageBrackets(symbol),
        this.getExchangeInfoSnapshot(),
      ]);
      const capItem = bracketsResponse.find((r: any) => r.symbol === symbol);
      let capTier: any = undefined;
      if (capItem?.brackets?.length) {
        // Ordenar ascendente por initialLeverage para tomar la primera que cubra el leverage solicitado
        const sorted = [...capItem.brackets].sort(
          (a: any, b: any) => Number(a.initialLeverage) - Number(b.initialLeverage),
        );
        const fallback = sorted.length ? sorted[sorted.length - 1] : undefined;
        capTier = sorted.find((b: any) => leverage <= Number(b.initialLeverage)) ?? fallback;
      }

      const s = exchangeInfo.symbols.find((x: any) => x.symbol === symbol);
      if (!s) throw new Error(`Símbolo no encontrado en exchangeInfo: ${symbol}`);

      type AnyFilter = { filterType: string } & Record<string, any>;
      const isPriceFilter = (f: AnyFilter): f is AnyFilter & { tickSize: string } =>
        f?.filterType === 'PRICE_FILTER' && typeof f.tickSize === 'string';
      const isLotSizeFilter = (f: AnyFilter): f is AnyFilter & { stepSize: string } =>
        (f?.filterType === 'MARKET_LOT_SIZE' || f?.filterType === 'LOT_SIZE') &&
        typeof f.stepSize === 'string';
      const isMinNotionalFilter = (f: AnyFilter): f is AnyFilter & { notional: string } =>
        f?.filterType === 'MIN_NOTIONAL' && typeof f.notional === 'string';

      const pf = (s.filters as AnyFilter[]).find(isPriceFilter);
      const lot =
        (s.filters as AnyFilter[]).find((f) => f.filterType === 'MARKET_LOT_SIZE') ??
        (s.filters as AnyFilter[]).find((f) => f.filterType === 'LOT_SIZE');
      const lotOk = lot && isLotSizeFilter(lot as AnyFilter) ? (lot as AnyFilter) : undefined;
      const mn = (s.filters as AnyFilter[]).find(isMinNotionalFilter)?.notional ?? '5';

      const tickSizeStr = pf?.tickSize ?? '0.0001';
      const stepSizeStr = lotOk?.stepSize ?? '0.1';

      const pricePrecision = tickSizeStr.includes('.') ? tickSizeStr.split('.')[1]!.length : 0;
      const qtyPrecision = stepSizeStr.includes('.') ? stepSizeStr.split('.')[1]!.length : 0;

      const filters = {
        tickSize: Number(tickSizeStr),
        stepSize: Number(stepSizeStr),
        pricePrecision,
        qtyPrecision,
        minNotional: Number(mn),
        notionalCap: capTier ? Number(capTier.notionalCap) : undefined,
      };
      this.filtersCache.set(symbol, { filters, ts: now, leverage });
      return filters;
    } catch (err) {
      noteRateLimitFromError(err);
      throw err;
    }
  }

  async hasOpenPosition(symbol: string, side: 'LONG' | 'SHORT' | 'ANY') {
    const info = await this.getAccountInfo();
    const ps = info.positions || [];
    if (side === 'ANY')
      return ps.some((p: any) => p.symbol === symbol && Math.abs(+p.positionAmt) > 0);
    return ps.some((p: any) => {
      if (p.symbol !== symbol) return false;
      const amt = +p.positionAmt;
      if (p.positionSide === 'BOTH') return side === 'LONG' ? amt > 0 : amt < 0;
      return p.positionSide === side && Math.abs(amt) > 0;
    });
  }

  async readActivePosition(symbol: string, sideHint: Side): Promise<PositionInfo | null> {
    const info = await this.getAccountInfo();
    const pos = info.positions.find((p: any) => {
      if (p.symbol !== symbol) return false;
      const amt = +p.positionAmt;
      if (p.positionSide === 'BOTH') return sideHint === 'LONG' ? amt > 0 : amt < 0;
      return p.positionSide === sideHint && Math.abs(amt) > 0;
    });
    if (!pos) return null;
    return {
      sideMode: (pos.positionSide as any) || 'BOTH',
      qtyAbs: Math.abs(+pos.positionAmt),
      entryPrice: +pos.entryPrice,
      leverage: +(pos.leverage || CONFIG.LEVERAGE),
      isolatedMargin: pos.isolatedWallet
        ? Number(pos.isolatedWallet)
        : pos.positionInitialMargin
          ? Number(pos.positionInitialMargin)
          : undefined,
      unrealizedPnl: pos.unrealizedProfit !== undefined ? Number(pos.unrealizedProfit) : undefined,
    };
  }

  async readFreshActivePosition(symbol: string, sideHint: Side): Promise<PositionInfo | null> {
    if (sideHint !== 'LONG' && sideHint !== 'SHORT') throw new Error('POSITION_SIDE_INVALID');
    const rows = await this.enqueue(() => this.cli.futuresPositionRisk({ symbol }));
    if (!Array.isArray(rows)) throw new Error('POSITION_SNAPSHOT_INVALID');
    const candidates = rows.filter(
      (row) =>
        row.symbol === symbol && (row.positionSide === 'BOTH' || row.positionSide === sideHint),
    );
    if (candidates.length !== 1) throw new Error('POSITION_SNAPSHOT_INCOMPLETE');
    const row = candidates[0];
    if (
      typeof row.positionAmt !== 'string' ||
      !row.positionAmt.trim() ||
      !Number.isFinite(Number(row.positionAmt))
    ) {
      throw new Error('POSITION_QUANTITY_INVALID');
    }
    const amount = Number(row.positionAmt);
    if (
      amount === 0 ||
      (row.positionSide === 'BOTH' && (sideHint === 'LONG' ? amount < 0 : amount > 0))
    )
      return null;
    if (
      (sideHint === 'LONG' ? amount < 0 : amount > 0) ||
      !Number.isFinite(Number(row.entryPrice)) ||
      Number(row.entryPrice) <= 0 ||
      !Number.isFinite(Number(row.leverage)) ||
      Number(row.leverage) <= 0
    )
      throw new Error('POSITION_SNAPSHOT_INVALID');
    return {
      sideMode: row.positionSide,
      qtyAbs: Math.abs(amount),
      entryPrice: Number(row.entryPrice),
      leverage: Number(row.leverage),
    };
  }

  async marketOpen(symbol: string, side: Side, quantity: number, clientOrderId?: string) {
    const hedge = await this.mutationHedgeMode();

    const base: any = {
      symbol,
      type: 'MARKET' as const,
      quantity: String(quantity),
      newOrderRespType: 'RESULT' as const,
      side: side === 'LONG' ? 'BUY' : 'SELL',
      ...(clientOrderId ? { newClientOrderId: clientOrderId } : {}),
    };
    const payload = hedge ? { ...base, positionSide: side } : base;

    const t0 = Date.now();
    try {
      const res = await this.enqueue(
        () => this.cli.futuresOrder(payload),
        DEFAULT_REQUEST_WEIGHT,
        'order_mutation',
        'critical',
      );
      this.log.debug('api_market_open', {
        ms: Date.now() - t0,
        symbol,
        side,
        qty: quantity,
      });
      this.invalidateAccountInfo();
      if (
        !Number.isSafeInteger(Number(res.orderId)) ||
        Number(res.orderId) <= 0 ||
        (clientOrderId && (res.clientOrderId !== clientOrderId || res.symbol !== symbol))
      )
        throw new Error('ENTRY_ACK_IDENTITY_MISMATCH');
      return { avgPrice: +(res.avgPrice || 0), orderId: String(res.orderId) };
    } catch (e: any) {
      noteRateLimitFromError(e);
      // A mutation is one transport send. Mode changes require a new admission,
      // never an invisible fallback under the same persisted request identity.
      if (BinanceExchange.posSideMismatch(e)) this.hedgeCache = undefined;
      throw e;
    }
  }

  async readMarketOpenByClientOrderId(
    symbol: string,
    clientOrderId: string,
    expected?: EntryRecoveryExpectation,
  ): Promise<{ avgPrice: number; orderId: string } | null> {
    const order = await this.queryOpeningOrder(symbol, clientOrderId, expected);
    return { avgPrice: Number(order.avgPrice || 0), orderId: String(order.orderId) };
  }

  private async queryOpeningOrder(
    symbol: string,
    clientOrderId: string,
    expected?: EntryRecoveryExpectation,
  ): Promise<QueryFuturesOrderResult> {
    try {
      const order = await this.enqueue(() =>
        this.cli.futuresGetOrder({ symbol, origClientOrderId: clientOrderId }),
      );
      if (
        order.symbol !== symbol ||
        order.clientOrderId !== clientOrderId ||
        order.type !== 'MARKET' ||
        !Number.isSafeInteger(Number(order.orderId)) ||
        Number(order.orderId) <= 0
      ) {
        throw new Error('ENTRY_LOOKUP_IDENTITY_MISMATCH');
      }
      if (!['NEW', 'PARTIALLY_FILLED', 'FILLED'].includes(String(order.status))) {
        throw new Error(
          `market open reconciliation returned non-accepted status: ${String(order.status)}`,
        );
      }
      if (
        expected &&
        (!Number.isFinite(expected.quantity) ||
          expected.quantity <= 0 ||
          !Number.isSafeInteger(expected.notBeforeMs) ||
          expected.notBeforeMs < 0 ||
          (expected.side !== 'LONG' && expected.side !== 'SHORT') ||
          order.status !== 'FILLED' ||
          order.side !== (expected.side === 'LONG' ? 'BUY' : 'SELL') ||
          !['BOTH', expected.side].includes(String(order.positionSide)) ||
          Number(order.origQty) !== expected.quantity ||
          Number(order.executedQty) !== expected.quantity ||
          !Number.isSafeInteger(Number(order.time)) ||
          Number(order.time) < expected.notBeforeMs ||
          !Number.isFinite(Number(order.avgPrice)) ||
          Number(order.avgPrice) <= 0)
      )
        throw new Error('ENTRY_RECOVERY_EXECUTION_MISMATCH');
      return order;
    } catch (error) {
      noteRateLimitFromError(error);
      // A just-submitted order can be invisible briefly. The caller must not
      // interpret -2013 as definitive absence during ambiguity resolution.
      if (isUnknownOrderError(error)) throw error;
      throw error;
    }
  }

  async readRecoverableEntryPosition(
    symbol: string,
    clientOrderId: string,
    expected: EntryRecoveryExpectation,
  ): Promise<RecoverableEntryPosition | null> {
    const order = await this.queryOpeningOrder(symbol, clientOrderId, expected);
    const startedAt = Date.now();
    // Recovery is deliberately bounded. A full page or history outside the query
    // window requires explicit reconciliation, not an inference from a partial list.
    if (
      order.reduceOnly !== false ||
      order.closePosition !== false ||
      !Number.isSafeInteger(order.updateTime) ||
      order.updateTime < order.time ||
      order.updateTime > startedAt ||
      startedAt - order.time > 7 * 86_400_000
    )
      return null;
    const readPosition = async () => {
      const positions = await this.enqueue(() => this.cli.futuresPositionRisk({ symbol }));
      if (!Array.isArray(positions)) return undefined;
      const candidates = positions.filter(
        (p) => p.symbol === symbol && p.positionSide === order.positionSide,
      );
      if (candidates.length !== 1) return undefined;
      const p = candidates[0];
      if (
        Math.abs(Number(p.positionAmt)) !== expected.quantity ||
        (expected.side === 'LONG' ? Number(p.positionAmt) <= 0 : Number(p.positionAmt) >= 0) ||
        Number(p.entryPrice) !== Number(order.avgPrice) ||
        !Number.isFinite(Number(p.leverage)) ||
        Number(p.leverage) <= 0 ||
        !Number.isSafeInteger(p.updateTime) ||
        p.updateTime < order.time ||
        p.updateTime > order.updateTime
      )
        return undefined;
      return p;
    };
    const before = await readPosition();
    if (!before) return null;
    // No orderId filter: intervening close/reopen or manual fills must remain visible.
    const fills = await this.enqueue(() =>
      this.cli.futuresUserTrades({ symbol, startTime: order.time, limit: 1000 }),
    );
    if (!Array.isArray(fills) || !fills.length || fills.length >= 1000) return null;
    const ids = new Set<string>();
    let quantity = BigInt(0);
    for (const fill of fills) {
      const units = quantityUnits(fill.qty);
      const id = String(fill.id);
      if (
        !Number.isSafeInteger(fill.id) ||
        fill.id < 0 ||
        ids.has(id) ||
        fill.symbol !== symbol ||
        String(fill.orderId) !== String(order.orderId) ||
        fill.side !== order.side ||
        fill.positionSide !== order.positionSide ||
        !Number.isSafeInteger(fill.time) ||
        fill.time < order.time ||
        fill.time > order.updateTime ||
        !Number.isFinite(Number(fill.price)) ||
        Number(fill.price) <= 0 ||
        units === undefined
      )
        return null;
      ids.add(id);
      quantity += units;
    }
    if (quantity !== quantityUnits(expected.quantity)) return null;
    const after = await readPosition();
    if (!after || after.updateTime !== before.updateTime || after.leverage !== before.leverage)
      return null;
    return {
      source: 'BINANCE_ORDER_AND_TRADES_V1',
      observedAt: Date.now(),
      symbol,
      side: expected.side,
      clientOrderId,
      orderId: String(order.orderId),
      filledAt: order.updateTime,
      fillIds: [...ids],
      position: {
        sideMode: after.positionSide,
        qtyAbs: expected.quantity,
        entryPrice: Number(after.entryPrice),
        leverage: Number(after.leverage),
      },
    };
  }

  async readMarketOpenEvidence(
    symbol: string,
    clientOrderId: string,
    since: number,
  ): Promise<{ avgPrice: number; orderId: string } | null> {
    const allOrders = (this.cli as any).futuresAllOrders;
    if (typeof allOrders !== 'function') return null;
    const orders = await this.enqueue(() =>
      allOrders.call(this.cli, { symbol, startTime: Math.max(0, since - 1000), limit: 100 }),
    );
    const order = (orders as any[]).find(
      (candidate) =>
        String(candidate.clientOrderId ?? candidate.origClientOrderId) === clientOrderId,
    );
    if (!order || !['NEW', 'PARTIALLY_FILLED', 'FILLED'].includes(String(order.status)))
      return null;
    return { avgPrice: Number(order.avgPrice || 0), orderId: String(order.orderId) };
  }

  async sendStopCloseOnce(
    request: import('../../app/ports/Exchange').IdentifiedStopRequest,
  ): Promise<import('../../app/ports/Exchange').StopOrderReceipt> {
    const params = {
      symbol: request.symbol,
      side: request.side === 'LONG' ? 'SELL' : 'BUY',
      positionSide: request.positionSide,
      algoType: 'CONDITIONAL',
      type: 'STOP_MARKET',
      triggerPrice: String(request.triggerPrice),
      workingType: request.workingType,
      ...(request.closePosition
        ? { closePosition: 'true' }
        : { quantity: String(request.quantity), reduceOnly: 'true' }),
      clientAlgoId: request.clientOrderId,
    };
    if (!validIdentifiedStop(request)) throw new Error('STOP_REQUEST_INVALID');
    const receipt = await this.enqueue(
      () => this.placeAlgoOrderRaw(params),
      DEFAULT_REQUEST_WEIGHT,
      'protection_algo_mutation',
      'critical',
    );
    if (
      receipt?.clientAlgoId !== request.clientOrderId ||
      receipt?.symbol !== request.symbol ||
      !receipt?.algoId ||
      (typeof receipt.algoId === 'number' && !Number.isSafeInteger(receipt.algoId)) ||
      !/^\d+$/.test(String(receipt.algoId))
    )
      throw new Error('STOP_ACK_IDENTITY');
    return { clientOrderId: receipt.clientAlgoId, orderId: String(receipt.algoId) };
  }

  async readStopCloseByClientOrderId(
    request: import('../../app/ports/Exchange').IdentifiedStopRequest,
  ): Promise<import('../../app/ports/Exchange').StopOrderReceipt | null> {
    const order = await this.readStopCloseState(request);
    return order?.status === 'NEW'
      ? { clientOrderId: order.clientOrderId, orderId: order.orderId }
      : null;
  }

  async readTriggeredStop(
    request: import('../../app/ports/Exchange').IdentifiedStopRequest,
    quantity: number,
  ): Promise<
    (import('../../app/ports/Exchange').StopOrderReceipt & { executedOrderId: string }) | null
  > {
    if (
      !validIdentifiedStop(request) ||
      !Number.isFinite(quantity) ||
      quantity <= 0 ||
      (!request.closePosition && quantityUnits(quantity) !== quantityUnits(request.quantity!)) ||
      !/^[A-Z0-9]+$/.test(request.symbol)
    )
      return null;
    const algo = await this.enqueue(
      () => this.placeAlgoOrderRaw({ clientAlgoId: request.clientOrderId }, 'GET'),
      1,
      'micro_triggered_stop',
    );
    if (
      !algo ||
      algo.clientAlgoId !== request.clientOrderId ||
      algo.symbol !== request.symbol ||
      algo.algoStatus !== 'FINISHED' ||
      algo.algoType !== 'CONDITIONAL' ||
      algo.orderType !== 'STOP_MARKET' ||
      algo.side !== (request.side === 'LONG' ? 'SELL' : 'BUY') ||
      algo.positionSide !== request.positionSide ||
      Number(algo.triggerPrice) !== request.triggerPrice ||
      algo.workingType !== 'MARK_PRICE' ||
      !matchesStopCoverage(request, algo) ||
      !/^[1-9]\d*$/.test(String(algo.algoId)) ||
      (typeof algo.algoId === 'number' && !Number.isSafeInteger(algo.algoId)) ||
      !/^[1-9]\d*$/.test(String(algo.actualOrderId)) ||
      !Number.isSafeInteger(Number(algo.actualOrderId))
    )
      return null;
    const order = await this.enqueue(
      () =>
        this.cli.futuresGetOrder({ symbol: request.symbol, orderId: Number(algo.actualOrderId) }),
      1,
      'micro_triggered_stop_order',
    );
    if (
      String(order.orderId) !== String(algo.actualOrderId) ||
      order.symbol !== request.symbol ||
      order.side !== algo.side ||
      order.positionSide !== request.positionSide ||
      order.status !== 'FILLED' ||
      quantityUnits(order.executedQty) !== quantityUnits(quantity)
    )
      return null;
    return {
      clientOrderId: request.clientOrderId,
      orderId: String(algo.algoId),
      executedOrderId: String(order.orderId),
    };
  }

  async readStopCloseState(
    request: import('../../app/ports/Exchange').IdentifiedStopRequest,
  ): Promise<import('../../app/ports/Exchange').StopOrderState | null> {
    if (!validIdentifiedStop(request)) throw new Error('STOP_REQUEST_INVALID');
    // Only NEW protection and definitive cancellation are interpreted. Not-found,
    // triggered and unexpected statuses never authorize resubmission or retirement.
    const order = await this.enqueue(
      () => this.placeAlgoOrderRaw({ clientAlgoId: request.clientOrderId }, 'GET'),
      DEFAULT_REQUEST_WEIGHT,
    );
    if (
      !order ||
      order.clientAlgoId !== request.clientOrderId ||
      !String(order.clientAlgoId).startsWith('bot_sl_') ||
      order.symbol !== request.symbol ||
      !order.algoId ||
      (typeof order.algoId === 'number' && !Number.isSafeInteger(order.algoId)) ||
      !/^\d+$/.test(String(order.algoId)) ||
      !['NEW', 'CANCELED'].includes(order.algoStatus) ||
      order.algoType !== 'CONDITIONAL' ||
      order.orderType !== 'STOP_MARKET' ||
      order.side !== (request.side === 'LONG' ? 'SELL' : 'BUY') ||
      order.positionSide !== request.positionSide ||
      Number(order.triggerPrice) !== request.triggerPrice ||
      order.workingType !== 'MARK_PRICE' ||
      !matchesStopCoverage(request, order)
    )
      return null;
    return {
      clientOrderId: order.clientAlgoId,
      orderId: String(order.algoId),
      status: order.algoStatus,
    };
  }

  async placeStopClose(
    symbol: string,
    side: Side,
    stopPrice: number,
    qty?: number,
  ): Promise<boolean> {
    const hedge = await this.mutationHedgeMode();

    const standardParams = this.buildStandardCloseTriggerParams(
      symbol,
      side,
      'STOP_MARKET',
      stopPrice,
      hedge,
      qty,
    );
    const algoParams: any = {
      symbol,
      side: side === 'LONG' ? 'SELL' : 'BUY',
      type: 'STOP_MARKET',
      algoType: 'CONDITIONAL',
      triggerPrice: this.formatPrice(symbol, stopPrice),
      workingType: 'MARK_PRICE',
      timestamp: Date.now(),
      clientAlgoId: bracketClientId('sl', symbol, side),
    };

    if (qty) {
      algoParams.quantity = String(qty);
      if (!hedge) algoParams.reduceOnly = 'true';
    } else {
      algoParams.closePosition = 'true';
    }

    if (hedge) algoParams.positionSide = side;

    const t0 = Date.now();
    try {
      await this.enqueue(
        () => this.cli.futuresOrder(standardParams),
        DEFAULT_REQUEST_WEIGHT,
        'protection_order_mutation',
        'critical',
      );
      this.log.debug('api_stop_upsert', {
        ms: Date.now() - t0,
        symbol,
        side,
        stopPrice,
        placement: 'standard_order',
      });
      return true;
    } catch (e: any) {
      noteRateLimitFromError(e);
      if (e?.code === -4061) {
        const fallbackParams = { ...standardParams };
        delete fallbackParams.positionSide;
        await this.enqueue(
          () => this.cli.futuresOrder(fallbackParams),
          DEFAULT_REQUEST_WEIGHT,
          'protection_order_mutation',
          'critical',
        );
        this.hedgeCache = undefined;
        this.log.warn('api_stop_upsert_fallback', {
          symbol,
          side,
          stopPrice,
          placement: 'standard_order_without_position_side',
        });
        return true;
      }
      // Only an explicit unsupported-order endpoint rejection permits a different
      // transport. Timeout/network/unknown responses may already have placed a stop.
      if (e?.code !== -4120) throw e;
      return this.placeStopCloseAlgoFallback(symbol, side, stopPrice, algoParams, e, t0);
    }
  }

  private async placeStopCloseAlgoFallback(
    symbol: string,
    side: Side,
    stopPrice: number,
    algoParams: any,
    cause: any,
    startedAt: number,
  ): Promise<boolean> {
    this.log.warn('api_stop_standard_order_failed_using_algo_fallback', {
      symbol,
      side,
      stopPrice,
      error: String(cause),
    });
    try {
      await this.enqueue(
        () => this.placeAlgoOrderRaw(algoParams),
        DEFAULT_REQUEST_WEIGHT,
        'protection_algo_mutation',
        'critical',
      );
      this.log.warn('api_stop_upsert_algo', {
        ms: Date.now() - startedAt,
        symbol,
        side,
        stopPrice,
      });
      return true;
    } catch (fallbackError: any) {
      noteRateLimitFromError(fallbackError);
      if (fallbackError?.code === -4061) {
        delete algoParams.positionSide;
        await this.enqueue(
          () => this.placeAlgoOrderRaw(algoParams),
          DEFAULT_REQUEST_WEIGHT,
          'protection_algo_mutation',
          'critical',
        );
        this.hedgeCache = undefined;
        this.log.warn('api_stop_upsert_algo_without_position_side', { symbol, side, stopPrice });
        return true;
      }
      this.log.warn('api_stop_algo_failed', {
        symbol,
        side,
        stopPrice,
        error: String(fallbackError),
      });
      throw fallbackError;
    }
  }

  private async placeStopCloseAlgo(symbol: string, side: Side, stopPrice: number): Promise<void> {
    const hedge = await this.mutationHedgeMode();

    const params: any = {
      symbol,
      algoType: 'CONDITIONAL',
      type: 'STOP_MARKET',
      side: side === 'LONG' ? 'SELL' : 'BUY',
      triggerPrice: this.formatPrice(symbol, stopPrice),
      workingType: 'MARK_PRICE',
      closePosition: 'true',
    };

    if (hedge) {
      params.positionSide = side;
    }

    const timestamp = Date.now();
    const recvWindow = Number(process.env.BINANCE_RECV_WINDOW ?? 20_000);
    const queryString =
      Object.keys(params)
        .map((key) => `${key}=${encodeURIComponent(params[key])}`)
        .join('&') + `&timestamp=${timestamp}&recvWindow=${recvWindow}`;

    const signature = require('crypto')
      .createHmac('sha256', CONFIG.API_SECRET)
      .update(queryString)
      .digest('hex');

    const signedParams = {
      ...params,
      timestamp,
      recvWindow,
      signature,
    };

    await this.enqueue(
      async () => {
        const response = await fetch(`${CONFIG.HTTP_FUTURES}/fapi/v1/algoOrder`, {
          method: 'POST',
          headers: {
            'X-MBX-APIKEY': CONFIG.API_KEY,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams(signedParams as any).toString(),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw rawHttpError(
            'Algo Order failed',
            response.status,
            errorText,
            response.headers.get('retry-after'),
          );
        }

        return response.json();
      },
      DEFAULT_REQUEST_WEIGHT,
      'protection_algo_mutation',
      'critical',
    );

    this.log.info('api_stop_algo_placed', { symbol, side, stopPrice });
  }

  async placeTpClose(
    symbol: string,
    side: Side,
    triggerPrice: number,
    qty?: number,
  ): Promise<boolean> {
    const hedge = await this.mutationHedgeMode();

    const standardParams = this.buildStandardCloseTriggerParams(
      symbol,
      side,
      'TAKE_PROFIT_MARKET',
      triggerPrice,
      hedge,
      qty,
    );
    const algoParams: any = {
      symbol,
      side: side === 'LONG' ? 'SELL' : 'BUY',
      type: 'TAKE_PROFIT_MARKET',
      algoType: 'CONDITIONAL',
      triggerPrice: this.formatPrice(symbol, triggerPrice),
      workingType: 'MARK_PRICE',
      timestamp: Date.now(),
      clientAlgoId: bracketClientId('tp', symbol, side),
    };

    if (qty) {
      algoParams.quantity = String(qty);
      if (!hedge) algoParams.reduceOnly = 'true';
    } else {
      algoParams.closePosition = 'true';
    }

    if (hedge) algoParams.positionSide = side;

    const t0 = Date.now();
    try {
      await this.enqueue(
        () => this.cli.futuresOrder(standardParams),
        DEFAULT_REQUEST_WEIGHT,
        'protection_order_mutation',
        'critical',
      );
      this.log.debug('api_tp_upsert', {
        ms: Date.now() - t0,
        symbol,
        side,
        tp: triggerPrice,
        placement: 'standard_order',
      });
      return true;
    } catch (e: any) {
      noteRateLimitFromError(e);
      if (BinanceExchange.posSideMismatch(e)) {
        const fallbackParams = { ...standardParams };
        delete fallbackParams.positionSide;
        await this.enqueue(
          () => this.cli.futuresOrder(fallbackParams),
          DEFAULT_REQUEST_WEIGHT,
          'protection_order_mutation',
          'critical',
        );
        this.hedgeCache = undefined;
        this.log.warn('api_tp_upsert_fallback', {
          symbol,
          side,
          tp: triggerPrice,
          placement: 'standard_order_without_position_side',
        });
        return true;
      }
      return this.placeTpCloseAlgoFallback(symbol, side, triggerPrice, algoParams, e, t0);
    }
  }

  private buildStandardCloseTriggerParams(
    symbol: string,
    side: Side,
    type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET',
    triggerPrice: number,
    hedge: boolean,
    qty?: number,
  ): any {
    const params: any = {
      symbol,
      side: side === 'LONG' ? 'SELL' : 'BUY',
      type,
      stopPrice: this.formatPrice(symbol, triggerPrice),
      workingType: 'MARK_PRICE',
      newOrderRespType: 'RESULT' as const,
      newClientOrderId: bracketClientId(type === 'STOP_MARKET' ? 'sl' : 'tp', symbol, side),
    };
    if (qty) {
      params.quantity = String(qty);
      if (!hedge) params.reduceOnly = 'true';
    } else {
      params.closePosition = 'true';
    }
    if (hedge) params.positionSide = side;
    return params;
  }

  private async placeTpCloseAlgoFallback(
    symbol: string,
    side: Side,
    triggerPrice: number,
    algoParams: any,
    cause: any,
    startedAt: number,
  ): Promise<boolean> {
    this.log.warn('api_tp_standard_order_failed_using_algo_fallback', {
      symbol,
      side,
      tp: triggerPrice,
      error: String(cause),
    });
    try {
      await this.enqueue(
        () => this.placeAlgoOrderRaw(algoParams),
        DEFAULT_REQUEST_WEIGHT,
        'protection_algo_mutation',
        'critical',
      );
      this.log.warn('api_tp_upsert_algo', {
        ms: Date.now() - startedAt,
        symbol,
        side,
        tp: triggerPrice,
      });
      return true;
    } catch (fallbackError: any) {
      noteRateLimitFromError(fallbackError);
      if (BinanceExchange.posSideMismatch(fallbackError)) {
        delete algoParams.positionSide;
        await this.enqueue(
          () => this.placeAlgoOrderRaw(algoParams),
          DEFAULT_REQUEST_WEIGHT,
          'protection_algo_mutation',
          'critical',
        );
        this.hedgeCache = undefined;
        this.log.warn('api_tp_upsert_algo_without_position_side', {
          symbol,
          side,
          tp: triggerPrice,
        });
        return true;
      }
      this.log.warn('api_tp_algo_failed', {
        symbol,
        side,
        tp: triggerPrice,
        error: String(fallbackError),
      });
      throw fallbackError;
    }
  }

  private async placeAlgoOrderRaw(params: any, method: 'POST' | 'GET' = 'POST'): Promise<any> {
    const timestamp = params.timestamp || Date.now();
    const recvWindow = Number(process.env.BINANCE_RECV_WINDOW ?? 20_000);
    const qsParams = { ...params, timestamp, recvWindow };
    const queryString = Object.keys(qsParams)
      .map((key) => `${key}=${encodeURIComponent(qsParams[key])}`)
      .join('&');

    const signature = require('crypto')
      .createHmac('sha256', CONFIG.API_SECRET)
      .update(queryString)
      .digest('hex');

    const signedParams = {
      ...params,
      timestamp,
      recvWindow,
      signature,
    };

    const res = await fetch(
      `${CONFIG.HTTP_FUTURES}/fapi/v1/algoOrder${method === 'GET' ? `?${queryString}&signature=${signature}` : ''}`,
      {
        method,
        headers: {
          'X-MBX-APIKEY': CONFIG.API_KEY,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: method === 'POST' ? new URLSearchParams(signedParams).toString() : undefined,
      },
    );

    if (!res.ok) {
      const txt = await res.text();
      throw rawHttpError('Raw algo order failed', res.status, txt, res.headers.get('retry-after'));
    }
    return res.json();
  }

  private async placeTpCloseAlgo(symbol: string, side: Side, triggerPrice: number): Promise<void> {
    const hedge = await this.mutationHedgeMode();

    const params: any = {
      symbol,
      algoType: 'CONDITIONAL',
      type: 'TAKE_PROFIT_MARKET',
      side: side === 'LONG' ? 'SELL' : 'BUY',
      triggerPrice: this.formatPrice(symbol, triggerPrice),
      workingType: 'MARK_PRICE',
      closePosition: 'true',
    };

    if (hedge) {
      params.positionSide = side;
    }

    const timestamp = Date.now();
    const recvWindow = Number(process.env.BINANCE_RECV_WINDOW ?? 20_000);
    const queryString =
      Object.keys(params)
        .map((key) => `${key}=${encodeURIComponent(params[key])}`)
        .join('&') + `&timestamp=${timestamp}&recvWindow=${recvWindow}`;

    const signature = require('crypto')
      .createHmac('sha256', CONFIG.API_SECRET)
      .update(queryString)
      .digest('hex');

    const signedParams = {
      ...params,
      timestamp,
      recvWindow,
      signature,
    };

    await this.enqueue(
      async () => {
        const response = await fetch(`${CONFIG.HTTP_FUTURES}/fapi/v1/algoOrder`, {
          method: 'POST',
          headers: {
            'X-MBX-APIKEY': CONFIG.API_KEY,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams(signedParams as any).toString(),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw rawHttpError(
            'Algo TP Order failed',
            response.status,
            errorText,
            response.headers.get('retry-after'),
          );
        }

        return response.json();
      },
      DEFAULT_REQUEST_WEIGHT,
      'protection_algo_mutation',
      'critical',
    );

    this.log.info('api_tp_algo_placed', { symbol, side, tp: triggerPrice });
  }

  async sendMarketCloseOnce(
    request: import('../../app/ports/Exchange').IdentifiedCloseRequest,
  ): Promise<void> {
    if (
      !/^[A-Z0-9]+$/.test(request.symbol) ||
      !['LONG', 'SHORT'].includes(request.side) ||
      !['BOTH', request.side].includes(request.positionSide) ||
      !Number.isFinite(request.quantity) ||
      request.quantity <= 0 ||
      !/^bot_cl_[a-f0-9]{28}$/.test(request.clientOrderId) ||
      !Number.isSafeInteger(request.notBeforeMs) ||
      request.notBeforeMs < 0
    )
      throw new Error('CLOSE_REQUEST_INVALID');
    try {
      await this.enqueue(
        () =>
          this.cli.futuresOrder({
            symbol: request.symbol,
            type: 'MARKET',
            side: request.side === 'LONG' ? 'SELL' : 'BUY',
            quantity: String(request.quantity),
            positionSide: request.positionSide,
            ...(request.positionSide === 'BOTH' ? { reduceOnly: 'true' as const } : {}),
            newClientOrderId: request.clientOrderId,
            newOrderRespType: 'RESULT',
          }),
        DEFAULT_REQUEST_WEIGHT,
        'protection_order_mutation',
        'critical',
      );
    } finally {
      // Even a lost ACK may have changed the account. Never retry or infer a fill here.
      this.invalidateAccountInfo();
    }
  }

  async readMarketCloseByClientOrderId(
    request: import('../../app/ports/Exchange').IdentifiedCloseRequest,
  ): Promise<import('../../app/ports/Exchange').IdentifiedCloseEvidence | null> {
    const order = await this.enqueue(() =>
      this.cli.futuresGetOrder({
        symbol: request.symbol,
        origClientOrderId: request.clientOrderId,
      }),
    );
    const executed = Number(order.executedQty);
    const status = String(order.status);
    if (
      !/^bot_cl_[a-f0-9]{28}$/.test(request.clientOrderId) ||
      ![order.origQty, order.executedQty, order.time, order.updateTime].every(
        (value) =>
          (typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) &&
          Number.isFinite(Number(value)),
      ) ||
      !['LONG', 'SHORT'].includes(request.side) ||
      !['BOTH', request.side].includes(request.positionSide) ||
      !Number.isFinite(request.quantity) ||
      request.quantity <= 0 ||
      !Number.isSafeInteger(request.notBeforeMs) ||
      request.notBeforeMs < 0 ||
      order.symbol !== request.symbol ||
      order.clientOrderId !== request.clientOrderId ||
      !/^[1-9]\d*$/.test(String(order.orderId)) ||
      !Number.isSafeInteger(Number(order.orderId)) ||
      order.type !== 'MARKET' ||
      order.side !== (request.side === 'LONG' ? 'SELL' : 'BUY') ||
      order.positionSide !== request.positionSide ||
      (request.positionSide === 'BOTH'
        ? ![true, 'true'].includes(order.reduceOnly as boolean | string)
        : ![false, 'false'].includes(order.reduceOnly as boolean | string)) ||
      Number(order.origQty) !== request.quantity ||
      !Number.isFinite(executed) ||
      executed < 0 ||
      executed > request.quantity ||
      !['NEW', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'EXPIRED'].includes(status) ||
      (status === 'FILLED' && executed !== request.quantity) ||
      (status === 'PARTIALLY_FILLED' && !(executed > 0 && executed < request.quantity)) ||
      !Number.isSafeInteger(Number(order.time)) ||
      Number(order.time) < request.notBeforeMs ||
      !Number.isSafeInteger(Number(order.updateTime)) ||
      Number(order.updateTime) < Number(order.time)
    )
      return null;
    return {
      clientOrderId: request.clientOrderId,
      orderId: String(order.orderId),
      status: status as import('../../app/ports/Exchange').IdentifiedCloseEvidence['status'],
      executedQuantity: executed,
    };
  }

  async closeSideMarketSafe(
    symbol: string,
    side: Side,
    qtyAbs: number,
    sideMode: 'BOTH' | 'LONG' | 'SHORT',
  ) {
    const base: any = {
      symbol,
      type: 'MARKET',
      quantity: String(qtyAbs),
      newOrderRespType: 'RESULT' as const,
      side: side === 'LONG' ? 'SELL' : 'BUY',
    };

    if (sideMode !== 'BOTH' && sideMode !== side) {
      throw new Error(`Cannot close ${side}: Binance position mode is unknown or mismatched`);
    }

    const payload =
      sideMode === 'BOTH'
        ? { ...base, reduceOnly: 'true' as const }
        : { ...base, positionSide: side };

    try {
      await this.enqueue(
        () => this.cli.futuresOrder(payload),
        DEFAULT_REQUEST_WEIGHT,
        'protection_order_mutation',
        'critical',
      );
      this.invalidateAccountInfo();
    } catch (e: any) {
      noteRateLimitFromError(e);
      throw e;
    }
  }

  async openStopForSide(symbol: string, side: Side) {
    const list = await this.listCloseOrdersForSide(symbol, side);
    const stops = list.filter((o) => o.type === 'STOP_MARKET' || o.type === 'STOP');
    if (!stops.length) return null;

    const pick =
      side === 'LONG'
        ? stops.reduce((a, b) => (Number(a.stopPrice) > Number(b.stopPrice) ? a : b))
        : stops.reduce((a, b) => (Number(a.stopPrice) < Number(b.stopPrice) ? a : b));

    return { stopPrice: pick.stopPrice, orderId: pick.orderId };
  }

  async cancelCloseOrdersForSide(symbol: string, side: Side) {
    try {
      // 1. Cancelar Órdenes Estándar (Standard Orders)
      const open = await this.enqueue(() => this.cli.futuresOpenOrders({ symbol }));
      for (const o of open as any[]) {
        if (
          (o.type === 'STOP_MARKET' ||
            o.type === 'TAKE_PROFIT_MARKET' ||
            o.type === 'STOP' ||
            o.type === 'TAKE_PROFIT') &&
          (isTrueish(o.closePosition) || isTrueish(o.reduceOnly)) &&
          (!o.positionSide || o.positionSide === side || o.positionSide === 'BOTH')
        ) {
          await this.enqueue(() =>
            this.cli.futuresCancelOrder({ symbol, orderId: Number(o.orderId) }),
          );
        }
      }

      // 2. Cancelar Órdenes Algo (Conditional Orders) - EL ESLABÓN PERDIDO
      // Necesario porque la App de Binance a veces crea estos stops
      try {
        const timestamp = Date.now();
        const recvWindow = Number(process.env.BINANCE_RECV_WINDOW ?? 20_000);
        const queryString = `symbol=${symbol}&timestamp=${timestamp}&recvWindow=${recvWindow}`;
        const signature = require('crypto')
          .createHmac('sha256', CONFIG.API_SECRET)
          .update(queryString)
          .digest('hex');

        const response = await this.enqueue(() =>
          fetch(
            `${CONFIG.HTTP_FUTURES}/fapi/v1/openAlgoOrders?${queryString}&signature=${signature}`,
            {
              headers: { 'X-MBX-APIKEY': CONFIG.API_KEY },
            },
          ),
        );

        if (response.ok) {
          const algoOrders = await response.json();
          for (const o of algoOrders as any[]) {
            // Filtrar solo las órdenes condicionales que sean de cierre para nuestro lado
            if (o.algoType !== 'CONDITIONAL') continue;

            // Mapeo de lado: Si tengo LONG, el stop es SELL.
            const wantSide = side === 'LONG' ? 'SELL' : 'BUY';

            if (o.side !== wantSide) continue;

            // Verificar si es Stop o TP
            // Algo orders use 'orderType', not 'type'
            const type = o.orderType || o.type;
            const isStop = type === 'STOP_MARKET' || type === 'STOP';
            const isTp = type === 'TAKE_PROFIT_MARKET' || type === 'TAKE_PROFIT';

            if (isStop || isTp) {
              // Usar el endpoint específico para cancelar Algo Orders
              const cancelParams: any = { symbol, algoId: o.algoId };
              const qs = `symbol=${symbol}&algoId=${o.algoId}&timestamp=${Date.now()}&recvWindow=${recvWindow}`;
              const sig = require('crypto')
                .createHmac('sha256', CONFIG.API_SECRET)
                .update(qs)
                .digest('hex');

              const delRes = await this.enqueue(() =>
                fetch(`${CONFIG.HTTP_FUTURES}/fapi/v1/algoOrder?${qs}&signature=${sig}`, {
                  method: 'DELETE',
                  headers: { 'X-MBX-APIKEY': CONFIG.API_KEY },
                }),
              );

              if (!delRes.ok) {
                const txt = await delRes.text();
                this.log.warn('cancel_algo_api_fail', {
                  symbol,
                  algoId: o.algoId,
                  status: delRes.status,
                  body: txt,
                });
              } else {
                this.log.info('cancel_algo_success', { symbol, algoId: o.algoId });
              }
            }
          }
        }
      } catch (err: any) {
        // Ignorar errores de algo orders si no existen o fallan, para no bloquear el flujo principal
        this.log.debug('cancel_algo_check_fail', { symbol, err: err?.message });
      }
    } catch (err) {
      noteRateLimitFromError(err);
      throw err;
    }
  }

  async cancelStopOrdersForSide(symbol: string, side: Side) {
    try {
      // 1. Cancelar Órdenes Estándar (Standard Orders) - SOLO STOPS
      const open = await this.enqueue(() => this.cli.futuresOpenOrders({ symbol }));
      for (const o of open as any[]) {
        if (
          (o.type === 'STOP_MARKET' || o.type === 'STOP') &&
          (isTrueish(o.closePosition) || isTrueish(o.reduceOnly)) &&
          (!o.positionSide || o.positionSide === side || o.positionSide === 'BOTH')
        ) {
          await this.enqueue(() =>
            this.cli.futuresCancelOrder({ symbol, orderId: Number(o.orderId) }),
          );
        }
      }

      // 2. Cancelar Órdenes Algo (Conditional Orders) - SOLO STOPS
      try {
        const timestamp = Date.now();
        const recvWindow = Number(process.env.BINANCE_RECV_WINDOW ?? 20_000);
        const queryString = `symbol=${symbol}&timestamp=${timestamp}&recvWindow=${recvWindow}`;
        const signature = require('crypto')
          .createHmac('sha256', CONFIG.API_SECRET)
          .update(queryString)
          .digest('hex');

        const response = await this.enqueue(() =>
          fetch(
            `${CONFIG.HTTP_FUTURES}/fapi/v1/openAlgoOrders?${queryString}&signature=${signature}`,
            {
              headers: { 'X-MBX-APIKEY': CONFIG.API_KEY },
            },
          ),
        );

        if (response.ok) {
          const algoOrders = await response.json();
          for (const o of algoOrders as any[]) {
            if (o.algoType !== 'CONDITIONAL') continue;

            const wantSide = side === 'LONG' ? 'SELL' : 'BUY';
            if (o.side !== wantSide) continue;

            const type = o.orderType || o.type;
            const isStop = type === 'STOP_MARKET' || type === 'STOP';

            // SOLO CANCELAR SI ES STOP (Ignorar TP)
            if (isStop) {
              const qs = `symbol=${symbol}&algoId=${o.algoId}&timestamp=${Date.now()}&recvWindow=${recvWindow}`;
              const sig = require('crypto')
                .createHmac('sha256', CONFIG.API_SECRET)
                .update(qs)
                .digest('hex');

              const delRes = await this.enqueue(() =>
                fetch(`${CONFIG.HTTP_FUTURES}/fapi/v1/algoOrder?${qs}&signature=${sig}`, {
                  method: 'DELETE',
                  headers: { 'X-MBX-APIKEY': CONFIG.API_KEY },
                }),
              );

              if (!delRes.ok) {
                const txt = await delRes.text();
                this.log.warn('cancel_algo_stop_fail', {
                  symbol,
                  algoId: o.algoId,
                  status: delRes.status,
                  body: txt,
                });
              } else {
                this.log.info('cancel_algo_stop_success', { symbol, algoId: o.algoId });
              }
            }
          }
        }
      } catch (err: any) {
        this.log.debug('cancel_algo_stop_check_fail', { symbol, err: err?.message });
      }
    } catch (err) {
      noteRateLimitFromError(err);
      throw err;
    }
  }

  private async cancelAlgoOrderRaw(symbol: string, algoId: string) {
    const timestamp = Date.now();
    const recvWindow = Number(process.env.BINANCE_RECV_WINDOW ?? 20_000);
    const queryString = `symbol=${symbol}&algoId=${algoId}&timestamp=${timestamp}&recvWindow=${recvWindow}`;
    const signature = require('crypto')
      .createHmac('sha256', CONFIG.API_SECRET)
      .update(queryString)
      .digest('hex');

    const response = await this.enqueue(() =>
      fetch(`${CONFIG.HTTP_FUTURES}/fapi/v1/algoOrder?${queryString}&signature=${signature}`, {
        method: 'DELETE',
        headers: {
          'X-MBX-APIKEY': CONFIG.API_KEY,
        },
      }),
    );

    if (!response.ok) {
      const text = await response.text();
      throw rawHttpError(
        'Raw algo cancel failed',
        response.status,
        text,
        response.headers.get('retry-after'),
      );
    }
    return true;
  }

  async readCancelTarget(
    request: import('../../app/ports/Exchange').CancelTarget,
  ): Promise<'NEW' | 'CANCELED' | 'FILLED' | null> {
    if (
      typeof request.orderId !== 'string' ||
      !/^(?:ALGO_)?[1-9]\d*$/.test(request.orderId) ||
      typeof request.symbol !== 'string' ||
      !request.symbol.trim() ||
      (request.side !== 'LONG' && request.side !== 'SHORT') ||
      !['BOTH', request.side].includes(request.positionSide) ||
      !['STOP_MARKET', 'STOP', 'TAKE_PROFIT_MARKET', 'TAKE_PROFIT'].includes(request.type) ||
      !Number.isFinite(request.stopPrice) ||
      request.stopPrice <= 0
    )
      return null;
    const algo = request.orderId.startsWith('ALGO_');
    const id = algo ? request.orderId.slice(5) : request.orderId;
    if (!/^\d+$/.test(id) || (!algo && !Number.isSafeInteger(Number(id)))) return null;
    const order = await this.enqueue(() =>
      algo
        ? this.placeAlgoOrderRaw({ algoId: id }, 'GET')
        : this.cli.futuresGetOrder({ symbol: request.symbol, orderId: Number(id) }),
    );
    if (!order || typeof order !== 'object' || Array.isArray(order)) return null;
    const raw = order as Record<string, unknown>;
    const actualId = algo ? raw?.algoId : raw?.orderId;
    const clientId = algo ? raw?.clientAlgoId : raw?.clientOrderId;
    const status = algo ? raw?.algoStatus : raw?.status;
    if (
      !raw ||
      String(actualId) !== id ||
      (typeof actualId === 'number' && !Number.isSafeInteger(actualId)) ||
      typeof clientId !== 'string' ||
      !(clientId.startsWith('se_') || /^bot_sl_[a-f0-9]{28}$/.test(clientId)) ||
      raw.symbol !== request.symbol ||
      raw.side !== (request.side === 'LONG' ? 'SELL' : 'BUY') ||
      raw.positionSide !== request.positionSide ||
      (algo ? raw.orderType : raw.type) !== request.type ||
      Number(algo ? raw.triggerPrice : raw.stopPrice) !== request.stopPrice ||
      !(
        raw.closePosition === true ||
        raw.closePosition === 'true' ||
        raw.reduceOnly === true ||
        raw.reduceOnly === 'true'
      ) ||
      (algo && raw.algoType !== 'CONDITIONAL') ||
      (status !== 'NEW' && status !== 'CANCELED' && status !== 'FILLED')
    )
      return null;
    return status;
  }

  async cancelOrderById(symbol: string, orderId: string) {
    try {
      if (orderId.startsWith('ALGO_')) {
        await this.cancelAlgoOrderRaw(symbol, orderId.replace('ALGO_', ''));
        return;
      }
      await this.enqueue(() => this.cli.futuresCancelOrder({ symbol, orderId: Number(orderId) }));
    } catch (err) {
      noteRateLimitFromError(err);
      throw err;
    }
  }

  async cancelAllOrders(symbol: string) {
    try {
      await this.enqueue(() => this.cli.futuresCancelAllOpenOrders({ symbol }));
    } catch (err) {
      noteRateLimitFromError(err);
      throw err;
    }
  }

  private async microCommissionRate(symbol: string): Promise<number | null> {
    const params = new URLSearchParams({
      symbol,
      timestamp: String(await this.getServerTime()),
      recvWindow: '5000',
    });
    const signature = require('node:crypto')
      .createHmac('sha256', CONFIG.API_SECRET)
      .update(params.toString())
      .digest('hex');
    const response = await this.enqueue(
      () =>
        fetch(`${CONFIG.HTTP_FUTURES}/fapi/v1/commissionRate?${params}&signature=${signature}`, {
          headers: { 'X-MBX-APIKEY': CONFIG.API_KEY },
          signal: AbortSignal.timeout(5000),
        }),
      20,
      'micro_commission_rate',
    );
    if (!response.ok) {
      const error = rawHttpError(
        'MICRO_COMMISSION_READ_FAILED',
        response.status,
        '',
        response.headers.get('retry-after'),
      );
      noteRateLimitFromError(error);
      throw error;
    }
    const value = (await response.json()) as { symbol?: unknown; takerCommissionRate?: unknown };
    const rate =
      typeof value.takerCommissionRate === 'string' && value.takerCommissionRate.trim()
        ? Number(value.takerCommissionRate)
        : NaN;
    return value.symbol === symbol && Number.isFinite(rate) && rate >= 0 && rate < 1 ? rate : null;
  }

  async readMicroBurstEntryRisk(
    symbol: string,
    leverage: number,
  ): Promise<MicroBurstEntryRiskEvidence | null> {
    if (!/^[A-Z0-9]+$/.test(symbol) || ![20, 30].includes(leverage)) return null;
    const observedAtMs = await this.getServerTime();
    const account = await this.enqueue(
      () => this.cli.futuresAccountInfo(),
      5,
      'micro_entry_account',
    );
    const mode = await this.enqueue(
      () => this.cli.futuresPositionMode(),
      30,
      'micro_entry_position_mode',
    );
    const accountData = account as unknown as {
      canTrade?: unknown;
      multiAssetsMargin?: unknown;
      positions?: {
        symbol: string;
        positionAmt: string;
        positionSide: string;
        isolated: boolean;
        leverage: string;
      }[];
      assets?: { asset: string; walletBalance: string; availableBalance: string }[];
    };
    const num = (v: unknown) =>
      typeof v === 'string' && v.trim() ? Number(v) : typeof v === 'number' ? v : NaN;
    if (
      accountData.canTrade !== true ||
      accountData.multiAssetsMargin !== false ||
      mode.dualSidePosition !== false ||
      !Array.isArray(accountData.positions) ||
      !Array.isArray(accountData.assets) ||
      accountData.positions.some(
        (p) => !Number.isFinite(num(p.positionAmt)) || num(p.positionAmt) !== 0,
      )
    )
      return null;
    const positions = accountData.positions.filter((p) => p.symbol === symbol);
    const asset = accountData.assets.filter((a) => a.asset === 'USDT');
    if (
      positions.length !== 1 ||
      positions[0].positionSide !== 'BOTH' ||
      positions[0].isolated !== true ||
      num(positions[0].leverage) !== leverage ||
      asset.length !== 1
    )
      return null;
    const availableWallet = Math.min(num(asset[0].walletBalance), num(asset[0].availableBalance));
    if (!Number.isFinite(availableWallet) || availableWallet <= 0) return null;
    const tiers = await this.enqueue(
      () => this.cli.futuresLeverageBracket({ symbol, recvWindow: 5000 }),
      1,
      'micro_entry_tiers',
    );
    const rows = (
      tiers as unknown as { symbol: string; brackets: MicroBurstEntryRiskEvidence['brackets'] }[]
    ).filter((r) => r.symbol === symbol);
    const info = await this.getExchangeInfoSnapshot();
    const symbols = info.symbols.filter((s: { symbol: string }) => s.symbol === symbol);
    const liquidationFeeRate = num(symbols[0]?.liquidationFee);
    const takerFeeRate = await this.microCommissionRate(symbol);
    if (
      rows.length !== 1 ||
      !Array.isArray(rows[0].brackets) ||
      !rows[0].brackets.length ||
      symbols.length !== 1 ||
      symbols[0].marginAsset !== 'USDT' ||
      symbols[0].quoteAsset !== 'USDT' ||
      symbols[0].status !== 'TRADING' ||
      takerFeeRate === null ||
      !Number.isFinite(liquidationFeeRate) ||
      liquidationFeeRate < 0 ||
      liquidationFeeRate >= 1
    )
      return null;
    const brackets = rows[0].brackets.map((b) => ({
      notionalFloor: num(b.notionalFloor),
      notionalCap: num(b.notionalCap),
      initialLeverage: num(b.initialLeverage),
      maintMarginRatio: num(b.maintMarginRatio),
      cum: num(b.cum),
    }));
    if (
      brackets.some(
        (b, i) =>
          !Object.values(b).every(Number.isFinite) ||
          b.notionalFloor !== (i ? brackets[i - 1].notionalCap : 0) ||
          b.notionalCap <= b.notionalFloor ||
          b.maintMarginRatio < 0 ||
          b.maintMarginRatio >= 1 ||
          b.cum < 0 ||
          b.initialLeverage < 1,
      )
    )
      return null;
    return {
      source: 'BINANCE_ISOLATED_USDT_TIERS_V1',
      observedAtMs,
      availableWallet,
      takerFeeRate,
      liquidationFeeRate,
      leverage,
      positionSide: 'BOTH',
      marginType: 'ISOLATED',
      brackets,
    };
  }

  async readMicroBurstExitCosts(
    symbol: string,
    entryOrderId: string,
    quantity: number,
    sinceMs: number,
  ): Promise<{ observedAtMs: number; residualCostBps: number } | null> {
    const through = await this.getServerTime();
    if (
      !/^[A-Z0-9]+$/.test(symbol) ||
      !/^[1-9]\d*$/.test(entryOrderId) ||
      !Number.isSafeInteger(sinceMs) ||
      through < sinceMs ||
      through - sinceMs > 7 * 86_400_000 ||
      !Number.isFinite(quantity) ||
      quantity <= 0
    )
      return null;
    const trades = await this.enqueue(
      () =>
        this.cli.futuresUserTrades({ symbol, startTime: sinceMs, endTime: through, limit: 1000 }),
      5,
      'micro_exit_entry_fees',
    );
    if (!Array.isArray(trades) || !trades.length || trades.length >= 1000) return null;
    const numeric = (v: unknown) =>
      (typeof v === 'string' && v.trim()) || typeof v === 'number' ? Number(v) : NaN;
    let notional = 0,
      commission = 0,
      units = BigInt(0);
    const ids = new Set<string>();
    for (const t of trades) {
      if (
        String(t.orderId) !== entryOrderId ||
        t.symbol !== symbol ||
        t.positionSide !== 'BOTH' ||
        !['BUY', 'SELL'].includes(t.side) ||
        t.side !== trades[0].side ||
        t.commissionAsset !== 'USDT' ||
        !Number.isSafeInteger(t.id) ||
        t.id <= 0 ||
        ids.has(String(t.id)) ||
        numeric(t.realizedPnl) !== 0 ||
        !Number.isFinite(numeric(t.commission)) ||
        numeric(t.commission) < 0 ||
        !Number.isFinite(numeric(t.price)) ||
        numeric(t.price) <= 0 ||
        !quantityUnits(t.qty) ||
        numeric(t.qty) <= 0 ||
        !Number.isSafeInteger(t.time) ||
        t.time < sinceMs ||
        t.time > through
      )
        return null;
      ids.add(String(t.id));
      units += quantityUnits(t.qty)!;
      notional += numeric(t.price) * numeric(t.qty);
      commission += numeric(t.commission);
    }
    if (units !== quantityUnits(quantity) || !Number.isFinite(notional) || notional <= 0)
      return null;
    const funding = await this.enqueue(
      () =>
        this.cli.futuresIncome({
          symbol,
          incomeType: 'FUNDING_FEE',
          startTime: sinceMs,
          endTime: through,
          limit: 1000,
        }),
      30,
      'micro_exit_funding',
    );
    if (!Array.isArray(funding) || funding.length >= 1000) return null;
    const fundingIds = new Set<string>();
    let fundingCost = 0;
    for (const f of funding) {
      if (
        f.symbol !== symbol ||
        f.incomeType !== 'FUNDING_FEE' ||
        f.asset !== 'USDT' ||
        !String(f.tranId).match(/^[1-9]\d*$/) ||
        (typeof f.tranId === 'number' && !Number.isSafeInteger(f.tranId)) ||
        fundingIds.has(String(f.tranId)) ||
        !Number.isFinite(numeric(f.income)) ||
        !Number.isSafeInteger(f.time) ||
        f.time <= sinceMs ||
        f.time > through
      )
        return null;
      fundingIds.add(String(f.tranId));
      fundingCost -= numeric(f.income);
    }
    const taker = await this.microCommissionRate(symbol);
    if (taker === null) return null;
    return {
      observedAtMs: through,
      residualCostBps:
        (commission / notional + Math.max(0, fundingCost) / notional + taker) * 10_000,
    };
  }

  async readMicroBurstSettlement(
    identity: MicroBurstSettlementIdentity,
  ): Promise<MicroBurstSettlementEvidence | null> {
    if (!validMicroBurstSettlementIdentity(identity)) return null;
    return this.readHistoricalMicroSettlement(identity);
  }

  /** Read-only economics for legacy trades, without assigning a new policy or episode. */
  async readHistoricalMicroClose(
    input: Omit<MicroBurstEconomicIdentity, 'closeOrderIds'> & { clientOrderId: string },
  ): Promise<{
    identity: MicroBurstEconomicIdentity;
    evidence: MicroBurstSettlementEvidence;
  } | null> {
    if (
      !validMicroBurstEconomicIdentity({ ...input, closeOrderIds: ['discovery'] }) ||
      !/^[1-9]\d*$/.test(input.entryOrderId) ||
      !Number.isSafeInteger(Number(input.entryOrderId)) ||
      input.closedAtMs - input.openedAtMs > 7 * 86_400_000
    )
      return null;
    const order = await this.enqueue(
      () =>
        this.cli.futuresGetOrder({
          symbol: input.symbol,
          orderId: Number(input.entryOrderId),
        }),
      1,
      'historical_entry_identity',
    );
    if (order.clientOrderId !== input.clientOrderId || String(order.orderId) !== input.entryOrderId)
      return null;
    // Discovery is bounded and never itself sufficient to settle accounting.
    const trades = await this.enqueue(
      () =>
        this.cli.futuresUserTrades({
          symbol: input.symbol,
          startTime: input.openedAtMs,
          endTime: input.closedAtMs,
          limit: 1000,
        }),
      5,
      'historical_close_discovery',
    );
    if (!Array.isArray(trades) || !trades.length || trades.length >= 1000) return null;
    const closes = trades.filter((t) => String(t.orderId) !== input.entryOrderId);
    if (!closes.length) return null;
    const { clientOrderId: _, ...economic } = input;
    const identity = {
      ...economic,
      closeOrderIds: [...new Set(closes.map((t) => String(t.orderId)))],
      closedAtMs: Math.max(...closes.map((t) => t.time)),
    };
    if (identity.closedAtMs > input.closedAtMs) return null;
    const evidence = await this.readHistoricalMicroSettlement(identity);
    return evidence ? { identity, evidence } : null;
  }

  /** No type/side/ownership filters: any working order keeps historical retirement blocked. */
  async readMicroFlatAndOpenOrders(
    symbol: string,
  ): Promise<
    import('../../strategies/micro-burst/domain/MicroHistoricalClose').MicroFlatObservation | null
  > {
    if (!/^[A-Z0-9]+$/.test(symbol)) return null;
    const startedAtMs = await this.enqueue(() => this.cli.futuresTime(), 1, 'historical_flat_time');
    if (
      (await this.readFreshActivePosition(symbol, 'LONG')) !== null ||
      (await this.readFreshActivePosition(symbol, 'SHORT')) !== null
    )
      return null;
    const regular = await this.enqueue(
      () => this.cli.futuresOpenOrders({ symbol }),
      1,
      'historical_open_orders',
    );
    if (!Array.isArray(regular) || regular.length !== 0) return null;
    const algo = await this.enqueue(
      async () => {
        const query = new URLSearchParams({
          symbol,
          timestamp: String(Date.now()),
          recvWindow: '5000',
        }).toString();
        const signature = require('crypto')
          .createHmac('sha256', CONFIG.API_SECRET)
          .update(query)
          .digest('hex');
        const response = await fetch(
          `${CONFIG.HTTP_FUTURES}/fapi/v1/openAlgoOrders?${query}&signature=${signature}`,
          {
            headers: { 'X-MBX-APIKEY': CONFIG.API_KEY },
            signal: AbortSignal.timeout(5000),
            redirect: 'error',
          },
        );
        if (!response.ok)
          throw rawHttpError(
            'historical open algo orders failed',
            response.status,
            await response.text(),
            response.headers.get('retry-after'),
          );
        return response.json();
      },
      1,
      'historical_open_algo_orders',
    );
    if (!Array.isArray(algo) || algo.length !== 0) return null;
    if (
      (await this.readFreshActivePosition(symbol, 'LONG')) !== null ||
      (await this.readFreshActivePosition(symbol, 'SHORT')) !== null
    )
      return null;
    const observedAtMs = await this.enqueue(
      () => this.cli.futuresTime(),
      1,
      'historical_flat_time',
    );
    if (
      ![startedAtMs, observedAtMs].every(Number.isSafeInteger) ||
      observedAtMs < startedAtMs ||
      observedAtMs - startedAtMs > 10_000
    )
      return null;
    return {
      source: 'BINANCE_FRESH_FLAT_AND_ALL_OPEN_ORDERS',
      symbol,
      startedAtMs,
      observedAtMs,
      regularOpenOrders: 0,
      algoOpenOrders: 0,
    };
  }

  /** Read-only economics for legacy trades, without assigning a new policy or episode. */
  async readHistoricalMicroSettlement(
    identity: MicroBurstEconomicIdentity,
  ): Promise<MicroBurstSettlementEvidence | null> {
    if (!validMicroBurstEconomicIdentity(identity)) return null;
    // User-trade history is bounded by Binance retention and seven-day query windows.
    const serverTime = await this.enqueue(() => this.cli.futuresTime(), 1, 'settlement_time');
    if (
      !Number.isSafeInteger(serverTime) ||
      identity.closedAtMs > serverTime ||
      identity.openedAtMs < serverTime - 90 * 86_400_000 ||
      identity.closedAtMs - identity.openedAtMs > 7 * 86_400_000
    )
      return null;
    let reads = 0;
    const readInterval = async <T>(
      fetchPage: (startTime: number, endTime: number) => Promise<T[]>,
      startTime: number,
      endTime: number,
    ): Promise<T[] | null> => {
      if (++reads > 16) return null;
      const rows = await fetchPage(startTime, endTime);
      if (!Array.isArray(rows) || rows.length > 1000) return null;
      if (rows.length < 1000) return rows;
      // Inclusive disjoint windows avoid losing rows sharing the pagination boundary timestamp.
      if (startTime === endTime) return null;
      const midpoint = Math.floor((startTime + endTime) / 2);
      const left = await readInterval(fetchPage, startTime, midpoint);
      if (!left) return null;
      const right = await readInterval(fetchPage, midpoint + 1, endTime);
      return right && left.length + right.length <= 1000 ? [...left, ...right] : null;
    };
    const trades = await readInterval(
      (startTime, endTime) =>
        this.enqueue(
          () =>
            this.cli.futuresUserTrades({
              symbol: identity.symbol,
              startTime,
              endTime,
              limit: 1000,
            }),
          5,
          'settlement_trades',
        ),
      identity.openedAtMs,
      identity.closedAtMs,
    );
    if (!trades?.length) return null;
    const orderIds = [identity.entryOrderId, ...identity.closeOrderIds];
    const exactId = (value: unknown): string | null => {
      if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) return null;
      return (typeof value === 'string' || typeof value === 'number') &&
        /^[1-9]\d*$/.test(String(value))
        ? String(value)
        : null;
    };
    const number = (value: unknown): number =>
      (typeof value === 'string' && value.trim() !== '') || typeof value === 'number'
        ? Number(value)
        : NaN;
    if (orderIds.some((id) => !exactId(id) || !Number.isSafeInteger(Number(id)))) return null;
    if (
      trades.some(
        (trade) =>
          trade.positionSide !== 'BOTH' ||
          !exactId(trade.id) ||
          !exactId(trade.orderId) ||
          !orderIds.includes(String(trade.orderId)),
      )
    )
      return null;
    for (const orderId of orderIds) {
      const order = await this.enqueue(
        () => this.cli.futuresGetOrder({ symbol: identity.symbol, orderId: Number(orderId) }),
        1,
        'settlement_order',
      );
      const entry = orderId === identity.entryOrderId;
      const quantity = trades
        .filter((trade) => String(trade.orderId) === orderId)
        .reduce((total, trade) => total + (quantityUnits(trade.qty) ?? BigInt(0)), BigInt(0));
      if (
        exactId(order.orderId) !== orderId ||
        order.symbol !== identity.symbol ||
        order.positionSide !== 'BOTH' ||
        order.status !== 'FILLED' ||
        order.side !== ((identity.side === 'LONG') === entry ? 'BUY' : 'SELL') ||
        quantity <= BigInt(0) ||
        quantityUnits(order.executedQty) !== quantity ||
        quantityUnits(order.origQty) !== quantity
      )
        return null;
    }
    const income = await readInterval(
      (startTime, endTime) =>
        this.enqueue(
          () =>
            this.cli.futuresIncome({
              symbol: identity.symbol,
              incomeType: 'FUNDING_FEE',
              startTime,
              endTime,
              limit: 1000,
            }),
          30,
          'settlement_funding',
        ),
      identity.openedAtMs,
      identity.closedAtMs,
    );
    if (
      !income ||
      income.some(
        (row) =>
          row.incomeType !== 'FUNDING_FEE' ||
          !exactId(row.tranId) ||
          row.time <= identity.openedAtMs ||
          row.time >= identity.closedAtMs,
      )
    )
      return null;
    // BOTH-only attribution and both fresh side reads exclude opposite/hedged exposure.
    if (
      (await this.readFreshActivePosition(identity.symbol, 'LONG')) !== null ||
      (await this.readFreshActivePosition(identity.symbol, 'SHORT')) !== null
    )
      return null;
    const observedAtMs = await this.enqueue(() => this.cli.futuresTime(), 1, 'settlement_time');
    if (!Number.isSafeInteger(observedAtMs) || observedAtMs < serverTime) return null;
    const evidence: MicroBurstSettlementEvidence = {
      source: 'BINANCE_EXACT_ORDERS_TRADES_AND_INCOME_V1',
      observedAtMs,
      fillsComplete: true,
      fundingComplete: true,
      fundingFromMs: identity.openedAtMs,
      fundingThroughMs: identity.closedAtMs,
      exactOrdersFilledAndPositionFlat: true,
      fills: trades.map((trade) => ({
        id: String(trade.id),
        orderId: String(trade.orderId),
        symbol: trade.symbol,
        side: trade.side,
        quantity: number(trade.qty),
        price: number(trade.price),
        eventTimeMs: trade.time,
        realizedPnlUsdt: number(trade.realizedPnl),
        commission: number(trade.commission),
        commissionAsset: trade.commissionAsset,
      })),
      funding: income.map((row) => ({
        id: String(row.tranId),
        tradeId: identity.tradeId,
        symbol: row.symbol,
        asset: row.asset,
        amount: number(row.income),
        eventTimeMs: row.time,
      })),
    };
    return reconcileMicroBurstEconomics(identity, evidence).status === 'VERIFIED' ? evidence : null;
  }

  async getRecentFills(symbol: string, startTime?: number, limit = 100): Promise<TradeFill[]> {
    try {
      const trades = await this.enqueue(() =>
        this.cli.futuresUserTrades({
          symbol,
          startTime: startTime ? Number(startTime) : undefined,
          limit,
        }),
      );
      return (trades as any[]).map((t) => ({
        orderId: String(t.orderId),
        side: (t.side || '').toUpperCase() === 'BUY' ? 'BUY' : 'SELL',
        price: Number(t.price),
        qty: Number(t.qty),
        realizedPnl: t.realizedPnl !== undefined ? Number(t.realizedPnl) : undefined,
        commission: t.commission !== undefined ? Number(t.commission) : undefined,
        commissionAsset: t.commissionAsset,
        time: Number(t.time),
      }));
    } catch (err) {
      noteRateLimitFromError(err);
      throw err;
    }
  }

  async readLiquidationPrice(symbol: string, side: Side) {
    try {
      const risks: any[] = await this.enqueue(() => this.cli.futuresPositionRisk());
      const p = risks.find(
        (r) =>
          r.symbol === symbol &&
          ((r.positionSide === 'BOTH' &&
            (side === 'LONG' ? +r.positionAmt > 0 : +r.positionAmt < 0)) ||
            (r.positionSide === side && Math.abs(+r.positionAmt) > 0)),
      );
      const liq = p ? Number(p.liquidationPrice) : NaN;
      return Number.isFinite(liq) && liq > 0 ? liq : null;
    } catch (err) {
      noteRateLimitFromError(err);
      throw err;
    }
  }

  private orderSideForPosition(side: Side) {
    return side === 'LONG' ? 'SELL' : 'BUY';
  }

  async listCloseOrdersForSide(
    symbol: string,
    side: Side,
  ): Promise<
    {
      orderId: string;
      type: 'STOP_MARKET' | 'STOP' | 'TAKE_PROFIT_MARKET' | 'TAKE_PROFIT';
      stopPrice: number;
    }[]
  > {
    const wantSide = this.orderSideForPosition(side);
    const results: any[] = [];
    const listingErrors: unknown[] = [];

    // 1. Check standard orders
    try {
      const open = await this.enqueue(() => this.cli.futuresOpenOrders({ symbol }));

      this.log.debug('raw_open_orders', {
        count: (open as any[]).length,
        sample: (open as any[]).map((o) => ({
          id: o.orderId,
          type: o.type,
          side: o.side,
          positionSide: o.positionSide,
          closePosition: o.closePosition,
          reduceOnly: o.reduceOnly,
          stopPrice: o.stopPrice,
          workingType: o.workingType,
        })),
      });

      const standardOrders = (open as any[])
        .filter((o) => {
          const t: string = o.type;
          const isType =
            t === 'STOP_MARKET' ||
            t === 'STOP' ||
            t === 'TAKE_PROFIT_MARKET' ||
            t === 'TAKE_PROFIT';
          if (!isType) return false;
          if (o.side !== wantSide) return false;
          const hedgeOk = !o.positionSide || o.positionSide === side || o.positionSide === 'BOTH';
          if (!hedgeOk) return false;
          return (
            isTrueish(o.closePosition) ||
            isTrueish(o.reduceOnly) ||
            Number(o.origQty || o.quantity) > 0
          );
        })
        .map((o) => ({
          orderId: String(o.orderId),
          type: o.type as any,
          stopPrice: Number(o.stopPrice),
          closePosition: isTrueish(o.closePosition),
          reduceOnly: isTrueish(o.reduceOnly),
          quantity: Number(o.origQty || o.quantity || 0),
          positionSide: o.positionSide || 'BOTH',
          side: o.side,
          workingType: o.workingType,
          owner: isBotProtectionId(o.clientOrderId || o.origClientOrderId || o.clientAlgoId)
            ? 'BOT'
            : 'UNKNOWN',
        }));

      results.push(...standardOrders);
    } catch (err) {
      noteRateLimitFromError(err);
      listingErrors.push(err);
      this.log.warn('list_standard_orders_fail', { symbol, err: (err as any)?.message });
    }

    // 2. Check Algo Orders
    try {
      const timestamp = Date.now();
      const recvWindow = Number(process.env.BINANCE_RECV_WINDOW ?? 20_000);
      const queryString = `symbol=${symbol}&timestamp=${timestamp}&recvWindow=${recvWindow}`;
      const signature = require('crypto')
        .createHmac('sha256', CONFIG.API_SECRET)
        .update(queryString)
        .digest('hex');

      const response = await this.enqueue(() =>
        fetch(
          `${CONFIG.HTTP_FUTURES}/fapi/v1/openAlgoOrders?${queryString}&signature=${signature}`,
          {
            headers: {
              'X-MBX-APIKEY': CONFIG.API_KEY,
            },
          },
        ),
      );

      if (!response.ok) {
        const text = await response.text();
        throw rawHttpError(
          'open algo orders failed',
          response.status,
          text,
          response.headers.get('retry-after'),
        );
      }
      {
        const algoOrders = await response.json();
        if (!Array.isArray(algoOrders)) throw new Error('open algo orders returned invalid data');

        this.log.debug('raw_algo_orders', {
          count: (algoOrders as any[]).length,
          sample: (algoOrders as any[]).map((o) => ({
            id: o.algoId,
            type: o.algoType,
            side: o.side,
            positionSide: o.positionSide,
            triggerPrice: o.triggerPrice,
          })),
        });

        const validAlgoOrders = (algoOrders as any[])
          .filter((o) => {
            if (o.algoType !== 'CONDITIONAL') return false;
            if (o.side !== wantSide) return false;
            const hedgeOk = !o.positionSide || o.positionSide === side || o.positionSide === 'BOTH';
            if (!hedgeOk) return false;
            // Match order type
            const t = o.orderType || o.type;
            const isStop = t === 'STOP_MARKET' || t === 'STOP';
            const isTp = t === 'TAKE_PROFIT_MARKET' || t === 'TAKE_PROFIT';
            return (
              (isStop || isTp) &&
              (isTrueish(o.closePosition) ||
                isTrueish(o.reduceOnly) ||
                Number(o.quantity || o.origQty) > 0)
            );
          })
          .map((o) => ({
            orderId: 'ALGO_' + String(o.algoId),
            type: (o.orderType || o.type) as any,
            stopPrice: Number(o.triggerPrice || 0),
            closePosition: isTrueish(o.closePosition),
            reduceOnly: isTrueish(o.reduceOnly),
            quantity: Number(o.quantity || o.origQty || 0),
            positionSide: o.positionSide || 'BOTH',
            side: o.side,
            workingType: o.workingType,
            owner: isBotProtectionId(o.clientOrderId || o.origClientOrderId || o.clientAlgoId)
              ? 'BOT'
              : 'UNKNOWN',
          }));

        results.push(...validAlgoOrders);
      }
    } catch (err) {
      noteRateLimitFromError(err);
      listingErrors.push(err);
      this.log.debug('list_algo_orders_fail', { symbol, err: (err as any)?.message });
    }

    if (listingErrors.length > 0) {
      throw new Error(`close-order listing failed: ${listingErrors.map(String).join('; ')}`);
    }
    return results;
  }

  async openTpForSide(symbol: string, side: Side) {
    const list = await this.listCloseOrdersForSide(symbol, side);
    const tps = list.filter((o) => o.type === 'TAKE_PROFIT_MARKET' || o.type === 'TAKE_PROFIT');
    if (!tps.length) return null;
    const pick = tps[0];
    return { stopPrice: pick.stopPrice, orderId: pick.orderId };
  }

  async cancelOrdersByIds(symbol: string, orderIds: (string | number)[]) {
    for (const id of orderIds) {
      try {
        const idStr = String(id);
        if (idStr.startsWith('ALGO_')) {
          await this.cancelAlgoOrderRaw(symbol, idStr.replace('ALGO_', ''));
        } else {
          await this.enqueue(() => this.cli.futuresCancelOrder({ symbol, orderId: Number(id) }));
        }
      } catch (e) {
        noteRateLimitFromError(e);
        this.log.warn('cancel_order_fail', { id, err: (e as any)?.message });
      }
    }
  }
}
