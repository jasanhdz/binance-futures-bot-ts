// src/infra/binance/BinanceExchange.ts
import Binance from 'binance-api-node';
import {
  Exchange,
  PositionInfo,
  SymbolFilters,
  TradeFill,
  FundingSnapshot,
  BasisSnapshot,
} from '../../core/ports/Exchange';
import { Candle, Side } from '../../core/types';
import { CONFIG } from '../config';
import { Logger } from '../../core/ports/Logger';
import { noteRateLimitFromError } from '../rate-limit';

const DEFAULT_MIN_REQ_GAP_MS = Number(process.env.BINANCE_REQ_GAP_MS ?? 40);
const EXCHANGE_INFO_TTL_MS = Number(process.env.BINANCE_EXCHANGEINFO_TTL_MS ?? 5 * 60_000);
const LEVERAGE_BRACKET_TTL_MS = Number(process.env.BINANCE_BRACKET_TTL_MS ?? 2 * 60_000);

type CandleCacheEntry = {
  candles: Candle[];
  ts: number;
  interval: string;
  ttl: number;
};

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

export class BinanceExchange implements Exchange {
  private cli = Binance({
    apiKey: CONFIG.API_KEY,
    apiSecret: CONFIG.API_SECRET,
    httpFutures: CONFIG.HTTP_FUTURES,
    wsFutures: CONFIG.WS_FUTURES,
  });

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
  private requestQueue: Promise<void> = Promise.resolve();
  private nextRequestAt = 0;
  private readonly minReqGapMs = Math.max(0, DEFAULT_MIN_REQ_GAP_MS);
  private readonly accountInfoTtlMs = Number(process.env.BINANCE_ACCOUNTINFO_TTL_MS ?? 250);

  constructor(private log: Logger) {
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
      open: +c.open,
      high: +c.high,
      low: +c.low,
      close: +c.close,
      volume: +c.volume,
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
    const data = await this.enqueue(() =>
      this.cli.futuresFundingRate({ symbol, limit: 1 }),
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

  private async isHedgeMode(): Promise<boolean> {
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
      this.hedgeCache = { value: false, at: Date.now() };
      return false;
    }
  }

  private static posSideMismatch(e: any) {
    const m = (e?.message || '').toLowerCase();
    return m.includes('positionside') || m.includes('position side');
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
      const value = +(usdt?.balance ?? '0');
      this.usdtCache = { value, ts: now };
      return value;
    } catch (err) {
      noteRateLimitFromError(err);
      throw err;
    }
  }

  async setLeverage(symbol: string, leverage: number) {
    try {
      await this.enqueue(() => this.cli.futuresLeverage({ symbol, leverage }));
    } catch (err) {
      noteRateLimitFromError(err);
      throw err;
    }
  }

  async ensureMarginType(symbol: string, marginType: 'ISOLATED' | 'CROSSED' = 'ISOLATED') {
    const now = Date.now();
    const cached = this.marginTypeCache.get(symbol);
    if (cached && cached.type === marginType && now - cached.ts < 5 * 60_000) {
      return;
    }
    try {
      await this.enqueue(() => this.cli.futuresMarginType({ symbol, marginType }));
      this.marginTypeCache.set(symbol, { type: marginType, ts: now });
    } catch (err: any) {
      noteRateLimitFromError(err);
      const msg = (err?.message || err?.msg || '').toString();
      if (/No need to change margin type/i.test(msg) || /margin type cannot be changed/i.test(msg)) {
        this.marginTypeCache.set(symbol, { type: marginType, ts: now });
        this.log.debug('margin_type_skip', { symbol, requested: marginType, err: msg });
        return;
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
    if (side === 'ANY') return ps.some((p: any) => p.symbol === symbol && Math.abs(+p.positionAmt) > 0);
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
      unrealizedPnl: pos.unrealizedProfit !== undefined ? Number(pos.unrealizedProfit) : undefined,
    };
  }

  async marketOpen(symbol: string, side: Side, quantity: number) {
    const hedge = await this.isHedgeMode();

    const base: any = {
      symbol,
      type: 'MARKET' as const,
      quantity: String(quantity),
      newOrderRespType: 'RESULT' as const,
      side: side === 'LONG' ? 'BUY' : 'SELL',
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

  async placeStopClose(symbol: string, side: Side, stopPrice: number): Promise<boolean> {
    const hedge = await this.isHedgeMode();
    const base: any = {
      symbol,
      type: 'STOP_MARKET',
      side: side === 'LONG' ? 'SELL' : 'BUY',
      stopPrice: String(stopPrice),
      closePosition: 'true',
      workingType: 'MARK_PRICE',
    };
    const payload = hedge ? { ...base, positionSide: side } : base;

    const t0 = Date.now();
    try {
      await this.enqueue(() => this.cli.futuresOrder(payload));
      this.log.debug('api_stop_upsert', {
        ms: Date.now() - t0,
        symbol,
        side,
        stopPrice,
      });
      return true;
    } catch (e: any) {
      noteRateLimitFromError(e);

      // Check if error is about algo orders
      const msg = (e?.message || '').toLowerCase();
      if (msg.includes('algo') || msg.includes('order type not supported')) {
        this.log.debug('api_stop_fallback_to_algo', { symbol, side, stopPrice });
        try {
          await this.placeStopCloseAlgo(symbol, side, stopPrice);
          return true;
        } catch (algoErr: any) {
          const algoMsg = (algoErr?.message || '').toLowerCase();
          // -4130 = order already exists, which is OK
          if (algoMsg.includes('-4130') || algoMsg.includes('already') || algoMsg.includes('existing')) {
            this.log.debug('api_stop_algo_already_exists', { symbol, side });
            return false; // Silent success, but didn't create new
          }
          this.log.error('api_stop_algo_fail', { symbol, err: algoErr?.message || String(algoErr) });
          throw algoErr;
        }
      }

      if (BinanceExchange.posSideMismatch(e)) {
        await this.enqueue(() => this.cli.futuresOrder(base));
        this.hedgeCache = undefined;
        this.log.warn('api_stop_upsert_fallback', { symbol, side, stopPrice });
        return true;
      }
      throw e;
    }
  }

  private async placeStopCloseAlgo(symbol: string, side: Side, stopPrice: number): Promise<void> {
    const hedge = await this.isHedgeMode();

    const params: any = {
      symbol,
      algoType: 'CONDITIONAL',
      type: 'STOP_MARKET',
      side: side === 'LONG' ? 'SELL' : 'BUY',
      triggerPrice: String(stopPrice),
      workingType: 'MARK_PRICE',
      closePosition: 'true',
    };

    if (hedge) {
      params.positionSide = side;
    }

    const timestamp = Date.now();
    const queryString = Object.keys(params)
      .map(key => `${key}=${encodeURIComponent(params[key])}`)
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

  async placeTpClose(symbol: string, side: Side, triggerPrice: number): Promise<boolean> {
    const hedge = await this.isHedgeMode();
    const base: any = {
      symbol,
      type: 'TAKE_PROFIT_MARKET',
      side: side === 'LONG' ? 'SELL' : 'BUY',
      stopPrice: String(triggerPrice),
      closePosition: 'true',
      workingType: 'MARK_PRICE',
    };
    const payload = hedge ? { ...base, positionSide: side } : base;

    const t0 = Date.now();
    try {
      await this.enqueue(() => this.cli.futuresOrder(payload));
      this.log.debug('api_tp_upsert', {
        ms: Date.now() - t0,
        symbol,
        side,
        tp: triggerPrice,
      });
      return true;
    } catch (e: any) {
      noteRateLimitFromError(e);

      // Check if error is about algo orders
      const msg = (e?.message || '').toLowerCase();
      if (msg.includes('algo') || msg.includes('order type not supported')) {
        this.log.debug('api_tp_fallback_to_algo', { symbol, side, tp: triggerPrice });
        try {
          await this.placeTpCloseAlgo(symbol, side, triggerPrice);
          return true;
        } catch (algoErr: any) {
          const algoMsg = (algoErr?.message || '').toLowerCase();
          // -4130 = order already exists, which is OK
          if (algoMsg.includes('-4130') || algoMsg.includes('already') || algoMsg.includes('existing')) {
            this.log.debug('api_tp_algo_already_exists', { symbol, side });
            return false; // Silent success
          }
          this.log.error('api_tp_algo_fail', { symbol, err: algoErr?.message || String(algoErr) });
          throw algoErr;
        }
      }

      if (BinanceExchange.posSideMismatch(e)) {
        await this.enqueue(() => this.cli.futuresOrder(base));
        this.hedgeCache = undefined;
        this.log.warn('api_tp_upsert_fallback', { symbol, side, tp: triggerPrice });
        return true;
      }
      throw e;
    }
  }

  private async placeTpCloseAlgo(symbol: string, side: Side, triggerPrice: number): Promise<void> {
    const hedge = await this.isHedgeMode();

    const params: any = {
      symbol,
      algoType: 'CONDITIONAL',
      type: 'TAKE_PROFIT_MARKET',
      side: side === 'LONG' ? 'SELL' : 'BUY',
      triggerPrice: String(triggerPrice),
      workingType: 'MARK_PRICE',
      closePosition: 'true',
    };

    if (hedge) {
      params.positionSide = side;
    }

    const timestamp = Date.now();
    const queryString = Object.keys(params)
      .map(key => `${key}=${encodeURIComponent(params[key])}`)
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

    try {
      if (sideMode === 'BOTH') {
        await this.enqueue(() => this.cli.futuresOrder(base));
      } else {
        await this.enqueue(() =>
          this.cli.futuresOrder({ ...base, positionSide: side, reduceOnly: 'true' as const }),
        );
      }
      this.invalidateAccountInfo();
    } catch (e: any) {
      noteRateLimitFromError(e);
      if (BinanceExchange.posSideMismatch(e)) {
        await this.enqueue(() => this.cli.futuresOrder(base));
        this.hedgeCache = undefined;
        this.invalidateAccountInfo();
        return;
      }
      const m = (e?.message || '').toLowerCase();
      if (m.includes('reduceonly') || m.includes('reduce only')) {
        await this.enqueue(() => this.cli.futuresOrder(base));
        this.invalidateAccountInfo();
        return;
      }
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
      const open = await this.enqueue(() => this.cli.futuresOpenOrders({ symbol }));
      for (const o of open as any[]) {
        if (
          (o.type === 'STOP_MARKET' || o.type === 'TAKE_PROFIT_MARKET') &&
          isTrueish(o.closePosition) &&
          (!o.positionSide || o.positionSide === side)
        ) {
          await this.enqueue(() =>
            this.cli.futuresCancelOrder({ symbol, orderId: Number(o.orderId) }),
          );
        }
      }
    } catch (err) {
      noteRateLimitFromError(err);
      throw err;
    }
  }

  async cancelOrderById(symbol: string, orderId: string) {
    try {
      await this.enqueue(() =>
        this.cli.futuresCancelOrder({ symbol, orderId: Number(orderId) }),
      );
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
            t === 'STOP_MARKET' || t === 'STOP' || t === 'TAKE_PROFIT_MARKET' || t === 'TAKE_PROFIT';
          if (!isType) return false;
          if (o.side !== wantSide) return false;
          const hedgeOk = !o.positionSide || o.positionSide === side || o.positionSide === 'BOTH';
          if (!hedgeOk) return false;
          return true;
        })
        .map((o) => ({
          orderId: String(o.orderId),
          type: o.type as any,
          stopPrice: Number(o.stopPrice),
        }));

      results.push(...standardOrders);
    } catch (err) {
      noteRateLimitFromError(err);
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
        }
      );

      if (response.ok) {
        const algoOrders = await response.json();

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
            const isStop = o.type === 'STOP_MARKET' || o.type === 'STOP';
            const isTp = o.type === 'TAKE_PROFIT_MARKET' || o.type === 'TAKE_PROFIT';
            return isStop || isTp;
          })
          .map((o) => ({
            orderId: String(o.algoId),
            type: o.type as any,
            stopPrice: Number(o.triggerPrice || 0),
          }));

        results.push(...validAlgoOrders);
      }
    } catch (err) {
      // Algo orders might not be available, silently continue
      this.log.debug('list_algo_orders_fail', { symbol, err: (err as any)?.message });
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
        await this.enqueue(() => this.cli.futuresCancelOrder({ symbol, orderId: Number(id) }));
      } catch (e) {
        noteRateLimitFromError(e);
        this.log.warn('cancel_order_fail', { id, err: (e as any)?.message });
      }
    }
  }
}
