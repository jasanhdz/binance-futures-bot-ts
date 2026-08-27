// src/infra/adapters/BinanceAdapter.ts
import Binance from 'binance-api-node';
import {
  Exchange,
  PositionInfo,
  SymbolFilters,
  TradeFill,
  FundingSnapshot,
  BasisSnapshot,
} from '../../app/ports/Exchange';
import { Candle, Side } from '../../domain/types';
import { CONFIG } from '../config/environment';
import { Logger } from '../../app/ports/Logger';
import { noteRateLimitFromError } from './rate-limit';
import { randomBytes } from 'node:crypto';

const DEFAULT_MIN_REQ_GAP_MS = Number(process.env.BINANCE_REQ_GAP_MS ?? 40);
const EXCHANGE_INFO_TTL_MS = Number(process.env.BINANCE_EXCHANGEINFO_TTL_MS ?? 5 * 60_000);
const LEVERAGE_BRACKET_TTL_MS = Number(process.env.BINANCE_BRACKET_TTL_MS ?? 2 * 60_000);

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
import {
  BinanceDepthDiffEvent,
  BinanceDepthSnapshot,
} from '../../domain/strategies/micro-burst/MicroBurstMarketDataTypes';

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
  private accountInfoCache?: { data: any; ts: number };
  private wsCandleCache: Record<string, Candle> = {}; // Real-time cache
  private requestQueue: Promise<void> = Promise.resolve();
  private nextRequestAt = 0;
  private readonly minReqGapMs = Math.max(0, DEFAULT_MIN_REQ_GAP_MS);
  private readonly accountInfoTtlMs = Number(process.env.BINANCE_ACCOUNTINFO_TTL_MS ?? 250);

  constructor(private log: Logger) {
    this.wsManager = new WebSocketManager(this.cli, log, { isTestnet: CONFIG.IS_TESTNET });
    const isTestnet = process.env.IS_TESTNET === '1';
    this.cli
      .futuresPing()
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

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = async () => {
      const wait = Math.max(0, this.nextRequestAt - Date.now());
      if (wait > 0) await sleep(wait);
      try {
        const result = await task();
        this.nextRequestAt = Date.now() + this.minReqGapMs;
        return result;
      } catch (err) {
        this.nextRequestAt = Date.now() + this.minReqGapMs;
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
      const info = await this.enqueue(() => this.cli.futuresAccountInfo());
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
      const raw = await this.enqueue(() =>
        this.cli.futuresCandles({ symbol, interval: interval as any, limit }),
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
    const data = await this.enqueue(() => this.cli.futuresFundingRate({ symbol, limit: 1 }));
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
    const markData = await this.enqueue(() => this.cli.futuresMarkPrice());
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
      const data = await this.enqueue(() => this.cli.futuresExchangeInfo());
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
      const data = await this.enqueue(() =>
        this.cli.futuresLeverageBracket({
          symbol,
          recvWindow: Number(process.env.BINANCE_RECV_WINDOW ?? 20_000),
        }),
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
      const pm: any = await this.enqueue(() => (this.cli as any).futuresPositionMode());
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
      const t: any = await this.enqueue(() => this.cli.futuresTime());
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
  ): () => void {
    return this.wsManager.connectAggTrades(symbol, (trade) => {
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
    });
  }

  public async getDepthSnapshot(symbol: string, levels = 20): Promise<BinanceDepthSnapshot> {
    const book = await this.cli.futuresBook({ symbol, limit: levels });
    return {
      lastUpdateId: book.lastUpdateId,
      bids: book.bids.map((b) => [b.price, b.quantity] as [string, string]),
      asks: book.asks.map((a) => [a.price, a.quantity] as [string, string]),
      receivedAtMs: Date.now(),
    };
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
      const b = await this.enqueue(() => this.cli.futuresAccountBalance());
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

  async setLeverage(symbol: string, leverage: number) {
    try {
      const response: any = await this.enqueue(() =>
        this.cli.futuresLeverage({ symbol, leverage }),
      );
      if (Number(response?.leverage) !== leverage) {
        throw new Error(`Binance leverage response mismatch: requested ${leverage}`);
      }
      const risk: any[] = await this.enqueue(() => this.cli.futuresPositionRisk({ symbol }));
      const row = risk.find((item) => item.symbol === symbol);
      if (!row || Number(row.leverage) !== leverage) {
        throw new Error(`Binance leverage readback mismatch or unavailable for ${symbol}`);
      }
    } catch (err) {
      noteRateLimitFromError(err);
      throw err;
    }
  }

  async ensureMarginType(symbol: string, marginType: 'ISOLATED' | 'CROSSED' = 'ISOLATED') {
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
      if (!(await verify())) {
        await this.enqueue(() => this.cli.futuresMarginType({ symbol, marginType }));
      }
      if (!(await verify())) throw new Error(`Binance margin type readback mismatch for ${symbol}`);
      this.marginTypeCache.set(symbol, { type: marginType, ts: Date.now() });
    } catch (err: any) {
      noteRateLimitFromError(err);
      const msg = (err?.message || err?.msg || '').toString();
      if (/No need to change margin type|margin type cannot be changed/i.test(msg)) {
        try {
          if (await verify()) {
            this.marginTypeCache.set(symbol, { type: marginType, ts: Date.now() });
            return;
          }
        } catch {
          // Preserve the fail-closed ambiguity below when state cannot be read.
        }
        this.marginTypeCache.delete(symbol);
        throw new Error(`Binance margin type change is ambiguous for ${symbol}: ${msg}`);
      }
      throw err;
    }
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
      const res = await this.enqueue(() => this.cli.futuresOrder(payload));
      this.log.debug('api_market_open', {
        ms: Date.now() - t0,
        symbol,
        side,
        qty: quantity,
      });
      this.invalidateAccountInfo();
      return { avgPrice: +(res.avgPrice || 0), orderId: String(res.orderId) };
    } catch (e: any) {
      noteRateLimitFromError(e);
      if (BinanceExchange.posSideMismatch(e)) {
        const res = await this.enqueue(() => this.cli.futuresOrder(base));
        this.hedgeCache = undefined;
        this.log.warn('api_market_open_fallback', { symbol, side, qty: quantity });
        this.invalidateAccountInfo();
        return { avgPrice: +(res.avgPrice || 0), orderId: String(res.orderId) };
      }
      throw e;
    }
  }

  async readMarketOpenByClientOrderId(
    symbol: string,
    clientOrderId: string,
  ): Promise<{ avgPrice: number; orderId: string } | null> {
    try {
      const order = await this.enqueue(() =>
        this.cli.futuresGetOrder({ symbol, origClientOrderId: clientOrderId }),
      );
      if (!['NEW', 'PARTIALLY_FILLED', 'FILLED'].includes(String(order.status))) {
        throw new Error(
          `market open reconciliation returned non-accepted status: ${String(order.status)}`,
        );
      }
      return { avgPrice: Number(order.avgPrice || 0), orderId: String(order.orderId) };
    } catch (error) {
      noteRateLimitFromError(error);
      if (isUnknownOrderError(error)) return null;
      throw error;
    }
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
      await this.enqueue(() => this.cli.futuresOrder(standardParams));
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
      if (BinanceExchange.posSideMismatch(e)) {
        const fallbackParams = { ...standardParams };
        delete fallbackParams.positionSide;
        await this.enqueue(() => this.cli.futuresOrder(fallbackParams));
        this.hedgeCache = undefined;
        this.log.warn('api_stop_upsert_fallback', {
          symbol,
          side,
          stopPrice,
          placement: 'standard_order_without_position_side',
        });
        return true;
      }
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
      await this.enqueue(() => this.placeAlgoOrderRaw(algoParams));
      this.log.warn('api_stop_upsert_algo', {
        ms: Date.now() - startedAt,
        symbol,
        side,
        stopPrice,
      });
      return true;
    } catch (fallbackError: any) {
      noteRateLimitFromError(fallbackError);
      if (BinanceExchange.posSideMismatch(fallbackError)) {
        delete algoParams.positionSide;
        await this.enqueue(() => this.placeAlgoOrderRaw(algoParams));
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
    const queryString =
      Object.keys(params)
        .map((key) => `${key}=${encodeURIComponent(params[key])}`)
        .join('&') + `&timestamp=${timestamp}`;

    const signature = require('crypto')
      .createHmac('sha256', CONFIG.API_SECRET)
      .update(queryString)
      .digest('hex');

    const signedParams = {
      ...params,
      timestamp,
      signature,
    };

    await this.enqueue(async () => {
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
        throw new Error(`Algo Order failed: ${response.status} ${errorText}`);
      }

      return response.json();
    });

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
      await this.enqueue(() => this.cli.futuresOrder(standardParams));
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
        await this.enqueue(() => this.cli.futuresOrder(fallbackParams));
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
      await this.enqueue(() => this.placeAlgoOrderRaw(algoParams));
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
        await this.enqueue(() => this.placeAlgoOrderRaw(algoParams));
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

  private async placeAlgoOrderRaw(params: any): Promise<any> {
    const timestamp = params.timestamp || Date.now();
    const qsParams = { ...params, timestamp };
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
      signature,
    };

    const res = await fetch(`${CONFIG.HTTP_FUTURES}/fapi/v1/algoOrder`, {
      method: 'POST',
      headers: {
        'X-MBX-APIKEY': CONFIG.API_KEY,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(signedParams).toString(),
    });

    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Raw algo order failed: ${res.status} ${txt}`);
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
    const queryString =
      Object.keys(params)
        .map((key) => `${key}=${encodeURIComponent(params[key])}`)
        .join('&') + `&timestamp=${timestamp}`;

    const signature = require('crypto')
      .createHmac('sha256', CONFIG.API_SECRET)
      .update(queryString)
      .digest('hex');

    const signedParams = {
      ...params,
      timestamp,
      signature,
    };

    await this.enqueue(async () => {
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
        throw new Error(`Algo TP Order failed: ${response.status} ${errorText}`);
      }

      return response.json();
    });

    this.log.info('api_tp_algo_placed', { symbol, side, tp: triggerPrice });
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
      await this.enqueue(() => this.cli.futuresOrder(payload));
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
        const queryString = `symbol=${symbol}&timestamp=${timestamp}`;
        const signature = require('crypto')
          .createHmac('sha256', CONFIG.API_SECRET)
          .update(queryString)
          .digest('hex');

        const response = await fetch(
          `${CONFIG.HTTP_FUTURES}/fapi/v1/openAlgoOrders?${queryString}&signature=${signature}`,
          {
            headers: { 'X-MBX-APIKEY': CONFIG.API_KEY },
          },
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
              const qs = `symbol=${symbol}&algoId=${o.algoId}&timestamp=${Date.now()}`;
              const sig = require('crypto')
                .createHmac('sha256', CONFIG.API_SECRET)
                .update(qs)
                .digest('hex');

              const delRes = await fetch(
                `${CONFIG.HTTP_FUTURES}/fapi/v1/algoOrder?${qs}&signature=${sig}`,
                {
                  method: 'DELETE',
                  headers: { 'X-MBX-APIKEY': CONFIG.API_KEY },
                },
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
        const queryString = `symbol=${symbol}&timestamp=${timestamp}`;
        const signature = require('crypto')
          .createHmac('sha256', CONFIG.API_SECRET)
          .update(queryString)
          .digest('hex');

        const response = await fetch(
          `${CONFIG.HTTP_FUTURES}/fapi/v1/openAlgoOrders?${queryString}&signature=${signature}`,
          {
            headers: { 'X-MBX-APIKEY': CONFIG.API_KEY },
          },
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
              const qs = `symbol=${symbol}&algoId=${o.algoId}&timestamp=${Date.now()}`;
              const sig = require('crypto')
                .createHmac('sha256', CONFIG.API_SECRET)
                .update(qs)
                .digest('hex');

              const delRes = await fetch(
                `${CONFIG.HTTP_FUTURES}/fapi/v1/algoOrder?${qs}&signature=${sig}`,
                {
                  method: 'DELETE',
                  headers: { 'X-MBX-APIKEY': CONFIG.API_KEY },
                },
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
    const queryString = `symbol=${symbol}&algoId=${algoId}&timestamp=${timestamp}`;
    const signature = require('crypto')
      .createHmac('sha256', CONFIG.API_SECRET)
      .update(queryString)
      .digest('hex');

    const response = await fetch(
      `${CONFIG.HTTP_FUTURES}/fapi/v1/algoOrder?${queryString}&signature=${signature}`,
      {
        method: 'DELETE',
        headers: {
          'X-MBX-APIKEY': CONFIG.API_KEY,
        },
      },
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Raw algo cancel failed: ${response.status} ${text}`);
    }
    return true;
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
          workingType: o.workingType,
          owner: String(o.clientOrderId || o.origClientOrderId || o.clientAlgoId || '').startsWith(
            'se_',
          )
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
      const queryString = `symbol=${symbol}&timestamp=${timestamp}`;
      const signature = require('crypto')
        .createHmac('sha256', CONFIG.API_SECRET)
        .update(queryString)
        .digest('hex');

      const response = await fetch(
        `${CONFIG.HTTP_FUTURES}/fapi/v1/openAlgoOrders?${queryString}&signature=${signature}`,
        {
          headers: {
            'X-MBX-APIKEY': CONFIG.API_KEY,
          },
        },
      );

      if (!response.ok) throw new Error(`open algo orders failed: ${response.status}`);
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
            workingType: o.workingType,
            owner: String(
              o.clientOrderId || o.origClientOrderId || o.clientAlgoId || '',
            ).startsWith('se_')
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
