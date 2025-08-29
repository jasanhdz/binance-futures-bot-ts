// src/infra/binance/BinanceExchange.ts
import Binance, { FuturesOrder } from 'binance-api-node';
import { Exchange, PositionInfo, SymbolFilters } from '../../core/ports/Exchange';
import { Candle, Side } from '../../core/types';
import { CONFIG } from '../config';

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

  // cache simple del modo de posiciones (hedge/one-way)
  private hedgeCache?: { value: boolean; at: number };

  constructor() {
    const isTestnet = process.env.IS_TESTNET === '1';
    this.cli
      .futuresPing()
      .then(() => {
        console.log(`[Binance] Conectado a ${isTestnet ? 'TESTNET' : 'PROD'} ✅`);
        console.log(`[Binance] HTTP: ${CONFIG.HTTP_FUTURES} | WS: ${CONFIG.WS_FUTURES}`);
        console.log('✅ Ping Futures OK');
      })
      .catch((err: any) => {
        console.error('[Binance] Error de conexión:', err?.message || String(err));
      });
  }

  // ---------- utilidades internas ----------

  /** Devuelve true si la cuenta está en Hedge Mode, false si está en One-Way. Cachea 60s. */
  private async isHedgeMode(): Promise<boolean> {
    if (this.hedgeCache && Date.now() - this.hedgeCache.at < 60_000) {
      return this.hedgeCache.value;
    }
    try {
      // Nota: algunos tipos no están en @types → usar any
      const pm: any = await (this.cli as any).futuresPositionMode();
      const val = !!pm?.dualSidePosition; // true = hedge
      this.hedgeCache = { value: val, at: Date.now() };
      return val;
    } catch {
      // si no se puede leer, asumimos one-way para no romper
      this.hedgeCache = { value: false, at: Date.now() };
      return false;
    }
  }

  /** Detecta el mensaje de “position side mismatch” en diferentes variantes. */
  private static posSideMismatch(e: any) {
    const m = (e?.message || '').toLowerCase();
    return m.includes('positionside') || m.includes('position side');
  }

  // ---------- implementación de Exchange ----------

  async getServerTime() {
    const t: any = await this.cli.futuresTime();
    return Number((t && t.serverTime) ?? t);
  }

  async getCandles(symbol: string, interval: string, limit: number): Promise<Candle[]> {
    const raw = await this.cli.futuresCandles({ symbol, interval: interval as any, limit });
    return raw.map((c) => ({
      openTime: c.openTime,
      open: +c.open,
      high: +c.high,
      low: +c.low,
      close: +c.close,
      volume: +c.volume,
      closeTime: c.closeTime,
    }));
  }

  async getMarkPrice(symbol: string) {
    const mk = await this.cli.futuresMarkPrice();
    const it = mk.find((m) => m.symbol === symbol);
    if (!it) throw new Error('markPrice missing');
    return +it.markPrice;
  }

  async getUSDTBalance() {
    const b = await this.cli.futuresAccountBalance();
    const usdt = b.find((x) => x.asset === 'USDT');
    return +(usdt?.availableBalance ?? '0');
  }

  async setLeverage(symbol: string, leverage: number) {
    await this.cli.futuresLeverage({ symbol, leverage });
  }

  async getSymbolFilters(symbol: string, leverage: number): Promise<SymbolFilters> {
    // --- risk bracket (cap nocional al leverage actual) ---
    const info = await this.cli.futuresLeverageBracket({
      symbol,
      recvWindow: Number(process.env.BINANCE_RECV_WINDOW ?? 5000),
    });
    const capItem = info.find((r) => r.symbol === symbol);
    const capTier = capItem?.brackets?.find((b) => leverage <= Number(b.initialLeverage));

    // --- exchange info para filtros ---
    const ex = await this.cli.futuresExchangeInfo();
    const s = ex.symbols.find((x) => x.symbol === symbol);
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

    return {
      tickSize: Number(tickSizeStr),
      stepSize: Number(stepSizeStr),
      pricePrecision,
      qtyPrecision,
      minNotional: Number(mn),
      notionalCap: capTier ? Number(capTier.notionalCap) : undefined,
    };
  }

  async hasOpenPosition(symbol: string, side: 'LONG' | 'SHORT' | 'ANY') {
    const info = await this.cli.futuresAccountInfo();
    const ps = info.positions || [];
    if (side === 'ANY') return ps.some((p) => p.symbol === symbol && Math.abs(+p.positionAmt) > 0);
    return ps.some((p) => {
      if (p.symbol !== symbol) return false;
      const amt = +p.positionAmt;
      if (p.positionSide === 'BOTH') return side === 'LONG' ? amt > 0 : amt < 0;
      return p.positionSide === side && Math.abs(amt) > 0;
    });
  }

  async readActivePosition(symbol: string, sideHint: Side): Promise<PositionInfo | null> {
    const info = await this.cli.futuresAccountInfo();
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
      const res = await this.cli.futuresOrder(payload);
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: 'debug',
          msg: 'api_market_open',
          ms: Date.now() - t0,
          symbol,
          side,
          qty: quantity,
        }),
      );
      return { avgPrice: +(res.avgPrice || 0), orderId: String(res.orderId) };
    } catch (e: any) {
      if (BinanceExchange.posSideMismatch(e)) {
        // fallback si el modo real no coincide con nuestro cache
        const res = await this.cli.futuresOrder(base); // sin positionSide
        this.hedgeCache = undefined; // invalidar cache
        console.log(
          JSON.stringify({
            ts: new Date().toISOString(),
            level: 'warn',
            msg: 'api_market_open_fallback',
            symbol,
            side,
            qty: quantity,
          }),
        );
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
      await this.cli.futuresOrder(payload);
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: 'debug',
          msg: 'api_stop_upsert',
          ms: Date.now() - t0,
          symbol,
          side,
          stopPrice,
        }),
      );
    } catch (e: any) {
      if (BinanceExchange.posSideMismatch(e)) {
        await this.cli.futuresOrder(base); // fallback sin positionSide
        this.hedgeCache = undefined;
        console.log(
          JSON.stringify({
            ts: new Date().toISOString(),
            level: 'warn',
            msg: 'api_stop_upsert_fallback',
            symbol,
            side,
            stopPrice,
          }),
        );
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
      await this.cli.futuresOrder(payload);
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: 'debug',
          msg: 'api_tp_upsert',
          ms: Date.now() - t0,
          symbol,
          side,
          tp: triggerPrice,
        }),
      );
    } catch (e: any) {
      if (BinanceExchange.posSideMismatch(e)) {
        await this.cli.futuresOrder(base); // fallback sin positionSide
        this.hedgeCache = undefined;
        console.log(
          JSON.stringify({
            ts: new Date().toISOString(),
            level: 'warn',
            msg: 'api_tp_upsert_fallback',
            symbol,
            side,
            tp: triggerPrice,
          }),
        );
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
        // One-Way
        await this.cli.futuresOrder(base);
      } else {
        // Hedge: necesita positionSide y (preferible) reduceOnly
        await this.cli.futuresOrder({ ...base, positionSide: side, reduceOnly: 'true' as const });
      }
    } catch (e: any) {
      if (BinanceExchange.posSideMismatch(e)) {
        // Si falló por modo, intentamos sin positionSide
        await this.cli.futuresOrder(base);
        this.hedgeCache = undefined;
        return;
      }
      const m = (e?.message || '').toLowerCase();
      if (m.includes('reduceonly') || m.includes('reduce only')) {
        // algunas cuentas no requieren/aceptan reduceOnly → reintenta sin él
        await this.cli.futuresOrder(base);
        return;
      }
      throw e;
    }
  }

  async openStopForSide(symbol: string, side: Side) {
    const list = await this.listCloseOrdersForSide(symbol, side);
    const stops = list.filter((o) => o.type === 'STOP_MARKET' || o.type === 'STOP');
    if (!stops.length) return null;

    // Elegimos el stop “más cercano” al precio en sentido conservador:
    // LONG: el más ALTO (sube el stop);  SHORT: el más BAJO (baja el stop)
    const pick =
      side === 'LONG'
        ? stops.reduce((a, b) => (a.stopPrice > b.stopPrice ? a : b))
        : stops.reduce((a, b) => (a.stopPrice < b.stopPrice ? a : b));

    return { stopPrice: pick.stopPrice, orderId: pick.orderId };
  }

  async cancelCloseOrdersForSide(symbol: string, side: Side) {
    const open = await this.cli.futuresOpenOrders({ symbol });
    for (const o of open as any[]) {
      if (
        (o.type === 'STOP_MARKET' || o.type === 'TAKE_PROFIT_MARKET') &&
        isTrueish(o.closePosition) &&
        (!o.positionSide || o.positionSide === side)
      ) {
        await this.cli.futuresCancelOrder({ symbol, orderId: Number(o.orderId) });
      }
    }
  }

  async cancelOrderById(symbol: string, orderId: string) {
    await this.cli.futuresCancelOrder({ symbol, orderId: Number(orderId) });
  }

  async readLiquidationPrice(symbol: string, side: Side) {
    const risks: any[] = await this.cli.futuresPositionRisk();
    const p = risks.find(
      (r) =>
        r.symbol === symbol &&
        ((r.positionSide === 'BOTH' &&
          (side === 'LONG' ? +r.positionAmt > 0 : +r.positionAmt < 0)) ||
          (r.positionSide === side && Math.abs(+r.positionAmt) > 0)),
    );
    const liq = p ? Number(p.liquidationPrice) : NaN;
    return Number.isFinite(liq) && liq > 0 ? liq : null;
  }

  private orderSideForPosition(side: Side) {
    return side === 'LONG' ? 'SELL' : 'BUY';
  }

  /** Lista órdenes de cierre (o candidatas) del lado dado.
   *  - Acepta STOP_MARKET / STOP y TAKE_PROFIT_MARKET / TAKE_PROFIT
   *  - No exige closePosition/reduceOnly para DETECTAR (los manuales a veces no lo traen)
   *  - Respeta hedge/one-way: si positionSide existe, debe coincidir; si no existe, se acepta igual
   */
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
    const open = await this.cli.futuresOpenOrders({ symbol });
    const wantSide = this.orderSideForPosition(side);

    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: 'debug',
        msg: 'raw_open_orders',
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
      }),
    );

    return (open as any[])
      .filter((o) => {
        const t: string = o.type;
        const isType =
          t === 'STOP_MARKET' || t === 'STOP' || t === 'TAKE_PROFIT_MARKET' || t === 'TAKE_PROFIT';
        if (!isType) return false;

        // Debe ser del lado de CIERRE
        if (o.side !== wantSide) return false;

        // Hedge: si trae positionSide, debe coincidir. Si no trae, lo aceptamos.
        const hedgeOk = !o.positionSide || o.positionSide === side || o.positionSide === 'BOTH';
        if (!hedgeOk) return false;

        // Preferimos closePosition/reduceOnly, pero ya no es obligatorio para DETECTAR
        return true;
      })
      .map((o) => ({
        orderId: String(o.orderId),
        type: o.type as any,
        stopPrice: Number(o.stopPrice),
      }));
  }

  async openTpForSide(symbol: string, side: Side) {
    const list = await this.listCloseOrdersForSide(symbol, side);
    const tps = list.filter((o) => o.type === 'TAKE_PROFIT_MARKET' || o.type === 'TAKE_PROFIT');
    if (!tps.length) return null;

    // Para TP nos da igual cuál, devolvemos el primero
    const pick = tps[0];
    return { stopPrice: pick.stopPrice, orderId: pick.orderId };
  }
}
