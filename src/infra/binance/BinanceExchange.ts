import Binance from 'binance-api-node';
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

  constructor() {
    this.cli
      .futuresPing()
      .then(() => {
        console.log(`[Binance] Conectado a ${CONFIG.IS_TESTNET ? 'TESTNET' : 'PROD'} ✅`);
        console.log(`[Binance] HTTP: ${CONFIG.HTTP_FUTURES} | WS: ${CONFIG.WS_FUTURES}`);
        console.log('✅ Ping Futures OK');
      })
      .catch((err: any) => {
        console.error('[Binance] Error de conexión:', err?.message || String(err));
      });
  }

  // 1) getServerTime correcto
  async getServerTime() {
    const t: any = await this.cli.futuresTime();
    // En binance-api-node normalmente futuresTime devuelve { serverTime: number }
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
    // --- risk bracket para notionalCap a ese leverage ---
    const info = await this.cli.futuresLeverageBracket({
      symbol,
      recvWindow: Number(process.env.BINANCE_RECV_WINDOW ?? 5000),
    });
    const capItem = info.find((r) => r.symbol === symbol);
    const capTier = capItem?.brackets?.find((b) => leverage <= Number(b.initialLeverage));

    // --- exchange info para filtros de símbolo ---
    const ex = await this.cli.futuresExchangeInfo();
    const s = ex.symbols.find((x) => x.symbol === symbol);
    if (!s) throw new Error(`Símbolo no encontrado en exchangeInfo: ${symbol}`);

    // Type guards
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
    const base: any = {
      symbol,
      type: 'MARKET' as const,
      quantity: String(quantity),
      newOrderRespType: 'RESULT' as const,
      side: side === 'LONG' ? 'BUY' : 'SELL',
    };

    const tryWith = async (params: any) => {
      const t0 = Date.now();
      const res = await this.cli.futuresOrder(params);
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
    };

    try {
      // intenta como Hedge
      return await tryWith({ ...base, positionSide: side });
    } catch (e: any) {
      const m = (e?.message || '').toLowerCase();
      if (m.includes('positionside')) {
        // fallback one-way
        return await tryWith(base);
      }
      throw e;
    }
  }

  async placeStopClose(symbol: string, side: Side, stopPrice: number) {
    const base: any = {
      symbol,
      type: 'STOP_MARKET',
      side: side === 'LONG' ? 'SELL' : 'BUY',
      stopPrice: String(stopPrice),
      closePosition: 'true',
      workingType: 'MARK_PRICE',
    };
    const tryWith = async (p: any) => {
      const t0 = Date.now();
      await this.cli.futuresOrder(p);
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
    };
    try {
      return await tryWith({ ...base, positionSide: side }); // hedge
    } catch (e: any) {
      const m = (e?.message || '').toLowerCase();
      if (m.includes('positionside')) {
        return await tryWith(base); // one-way fallback
      }
      throw e;
    }
  }

  async placeTpClose(symbol: string, side: Side, triggerPrice: number) {
    const base: any = {
      symbol,
      type: 'TAKE_PROFIT_MARKET',
      side: side === 'LONG' ? 'SELL' : 'BUY',
      stopPrice: String(triggerPrice),
      closePosition: 'true',
      workingType: 'MARK_PRICE',
    };
    const tryWith = async (p: any) => {
      const t0 = Date.now();
      await this.cli.futuresOrder(p);
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
    };
    try {
      return await tryWith({ ...base, positionSide: side }); // hedge
    } catch (e: any) {
      const m = (e?.message || '').toLowerCase();
      if (m.includes('positionside')) {
        return await tryWith(base); // one-way fallback
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
      if (sideMode === 'BOTH') await this.cli.futuresOrder(base);
      else
        await this.cli.futuresOrder({ ...base, positionSide: side, reduceOnly: 'true' as const });
    } catch (e: any) {
      const m = (e?.message || '').toLowerCase();
      if (m.includes('reduceonly')) await this.cli.futuresOrder(base);
      else throw e;
    }
  }

  // Reemplaza tu openStopForSide por este (soporta 'true' string/boolean):
  async openStopForSide(symbol: string, side: Side) {
    const open = await this.cli.futuresOpenOrders({ symbol });
    const want = open.find(
      (o: any) =>
        o.type === 'STOP_MARKET' &&
        o.side === (side === 'LONG' ? 'SELL' : 'BUY') &&
        isTrueish(o.closePosition) && // ⟵ aquí el cast a any evita el TS2367
        (!o.positionSide || o.positionSide === side), // filtra por Hedge mode
    );
    return want ? { stopPrice: Number(want.stopPrice!), orderId: String(want.orderId) } : null;
  }

  // útil para limpiar STOP/TP con closePosition=true tras cerrar posición
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

  // 3) cancelOrderById: implementación
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
}
