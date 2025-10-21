// src/infra/binance/BinanceExchange.ts
import Binance from 'binance-api-node';
import { Exchange, PositionInfo, SymbolFilters } from '../../core/ports/Exchange';
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
  private requestQueue: Promise<void> = Promise.resolve();
  private nextRequestAt = 0;
  private readonly minReqGapMs = Math.max(0, DEFAULT_MIN_REQ_GAP_MS);

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
      const value = +(usdt?.availableBalance ?? '0');
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
      const capTier = capItem?.brackets?.find((b: any) => leverage <= Number(b.initialLeverage));

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
    try {
      const info = await this.enqueue(() => this.cli.futuresAccountInfo());
      const ps = info.positions || [];
      if (side === 'ANY') return ps.some((p) => p.symbol === symbol && Math.abs(+p.positionAmt) > 0);
      return ps.some((p) => {
        if (p.symbol !== symbol) return false;
        const amt = +p.positionAmt;
        if (p.positionSide === 'BOTH') return side === 'LONG' ? amt > 0 : amt < 0;
        return p.positionSide === side && Math.abs(amt) > 0;
      });
    } catch (err) {
      noteRateLimitFromError(err);
      throw err;
    }
  }

  async readActivePosition(symbol: string, sideHint: Side): Promise<PositionInfo | null> {
    try {
      const info = await this.enqueue(() => this.cli.futuresAccountInfo());
      const pos = info.positions.find((p) => {
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
      };
    } catch (err) {
      noteRateLimitFromError(err);
      throw err;
    }
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
      return { avgPrice: +(res.avgPrice || 0), orderId: String(res.orderId) };
    } catch (e: any) {
      noteRateLimitFromError(e);
      if (BinanceExchange.posSideMismatch(e)) {
        const res = await this.enqueue(() => this.cli.futuresOrder(base));
        this.hedgeCache = undefined;
        this.log.warn('api_market_open_fallback', { symbol, side, qty: quantity });
        return { avgPrice: +(res.avgPrice || 0), orderId: String(res.orderId) };
      }
      throw e;
    }
  }

  async placeStopClose(symbol: string, side: Side, stopPrice: number): Promise<void> {
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
    } catch (e: any) {
      noteRateLimitFromError(e);
      if (BinanceExchange.posSideMismatch(e)) {
        await this.enqueue(() => this.cli.futuresOrder(base));
        this.hedgeCache = undefined;
        this.log.warn('api_stop_upsert_fallback', { symbol, side, stopPrice });
        return;
      }
      throw e;
    }
  }

  async placeTpClose(symbol: string, side: Side, triggerPrice: number): Promise<void> {
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
    } catch (e: any) {
      noteRateLimitFromError(e);
      if (BinanceExchange.posSideMismatch(e)) {
        await this.enqueue(() => this.cli.futuresOrder(base));
        this.hedgeCache = undefined;
        this.log.warn('api_tp_upsert_fallback', { symbol, side, tp: triggerPrice });
        return;
      }
      throw e;
    }
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
    } catch (e: any) {
      noteRateLimitFromError(e);
      if (BinanceExchange.posSideMismatch(e)) {
        await this.enqueue(() => this.cli.futuresOrder(base));
        this.hedgeCache = undefined;
        return;
      }
      const m = (e?.message || '').toLowerCase();
      if (m.includes('reduceonly') || m.includes('reduce only')) {
        await this.enqueue(() => this.cli.futuresOrder(base));
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
    try {
      const open = await this.enqueue(() => this.cli.futuresOpenOrders({ symbol }));
      const wantSide = this.orderSideForPosition(side);

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

      return (open as any[])
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
    } catch (err) {
      noteRateLimitFromError(err);
      throw err;
    }
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
