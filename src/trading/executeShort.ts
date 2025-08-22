import { binanceClient } from '../api/binanceClient';
import { CONFIG } from '../utils/config';
import { logHistory } from '../utils/logger';
import { OrderResponse } from '../types';
import { computeStopFromLiqTicks } from './stopLoss';

const { LEVERAGE } = CONFIG;

async function getSymbolFilters(symbol: string) {
  const info = await binanceClient.futuresExchangeInfo();
  const s = info.symbols.find((x) => x.symbol === symbol);
  if (!s) throw new Error(`Símbolo no encontrado: ${symbol}`);
  const priceFilter = s.filters.find((f: any) => f.filterType === 'PRICE_FILTER') as any;
  const lot = (s.filters.find((f: any) => f.filterType === 'MARKET_LOT_SIZE') ||
    s.filters.find((f: any) => f.filterType === 'LOT_SIZE')) as any;
  const minNotional =
    (s.filters.find((f: any) => f.filterType === 'MIN_NOTIONAL') as any)?.notional ?? '5';
  const tickSize = parseFloat(priceFilter?.tickSize ?? '0.0001');
  const stepSize = parseFloat(lot?.stepSize ?? '0.1');
  const pricePrecision = priceFilter?.tickSize?.split?.('.')[1]?.length ?? 4;
  const qtyPrecision = lot?.stepSize?.split?.('.')[1]?.length ?? 1;
  return { tickSize, stepSize, pricePrecision, qtyPrecision, minNotional: parseFloat(minNotional) };
}

function floorToStep(qty: number, step: number, precision: number) {
  const floored = Math.floor(qty / step) * step;
  return Number(floored.toFixed(precision));
}
function ceilToStep(val: number, step: number, precision: number) {
  const ceiled = Math.ceil(val / step) * step;
  return Number(ceiled.toFixed(precision));
}
function roundToTick(price: number, tick: number, precision: number) {
  const rounded = Math.round(price / tick) * tick;
  return Number(rounded.toFixed(precision));
}

/** Abre SHORT a mercado + SL con stopPrice (si quieres pasar SL ATR en vez de por liquidación). */
/** Abre SHORT a mercado + SL calculado a N ticks de la liquidación (o override opcional). */
export async function executeShortTrade(
  symbol: string,
  opts?: { stopLossPrice?: number },
): Promise<OrderResponse | null> {
  try {
    // 1) Balance USDT de futuros
    const balances = await binanceClient.futuresAccountBalance();
    const usdt = balances.find((b) => b.asset === 'USDT');
    const usdtBalance = parseFloat(usdt?.availableBalance ?? '0');
    if (usdtBalance <= 0) {
      logHistory('❌ No tienes USDT disponible.');
      return null;
    }

    // 2) Mark price
    const marks = await binanceClient.futuresMarkPrice();
    const mark = marks.find((m) => m.symbol === symbol);
    const currentPrice = mark ? parseFloat(mark.markPrice) : NaN;
    if (!isFinite(currentPrice)) throw new Error(`No markPrice para ${symbol}`);

    // 3) Apalancamiento
    await binanceClient.futuresLeverage({ symbol, leverage: LEVERAGE });

    // 4) Filtros del símbolo y cantidad
    const { stepSize, tickSize, pricePrecision, qtyPrecision, minNotional } =
      await getSymbolFilters(symbol);

    const rawQty = (usdtBalance * LEVERAGE) / currentPrice;
    let qtyNum = floorToStep(rawQty, stepSize, qtyPrecision);

    // Cumplir nocional mínimo
    const minQtyByNotional = ceilToStep(minNotional / currentPrice, stepSize, qtyPrecision);
    if (qtyNum < minQtyByNotional) {
      qtyNum = minQtyByNotional;
    }

    // Chequeo de margen requerido
    const requiredInitialMargin = (qtyNum * currentPrice) / LEVERAGE;
    if (requiredInitialMargin > usdtBalance) {
      logHistory(
        `⚠️ Balance insuficiente para minNotional ${minNotional} USDT. Req≈${requiredInitialMargin.toFixed(
          4,
        )} USDT, tienes ${usdtBalance.toFixed(4)} USDT`,
      );
      return null;
    }

    const quantity = String(qtyNum);
    logHistory(`🔔 Ejecutando SHORT ${symbol} qty=${quantity} @ ~${currentPrice}`);

    // 5) Orden de mercado SELL
    const order = await binanceClient.futuresOrder({
      symbol,
      side: 'SELL',
      type: 'MARKET',
      quantity,
      newOrderRespType: 'RESULT',
    });

    const executedPrice = parseFloat(order.avgPrice || currentPrice.toString());

    // 6) Stop Loss: por defecto a N ticks por DEBAJO de la liquidación (SHORT)
    const liquidationEst = executedPrice * (1 + 1 / LEVERAGE);

    let stopLossPrice: number;
    if (typeof opts?.stopLossPrice === 'number') {
      // Guardia mínima al pasar SL custom:
      // - En SHORT el stop debe quedar POR ENCIMA del precio actual (para que no se dispare ya)
      // - Y POR DEBAJO de la liquidación (para evitar liquidarte)
      let raw = opts.stopLossPrice;
      raw = Math.max(raw, currentPrice + tickSize); // por encima del precio actual
      raw = Math.min(raw, liquidationEst - tickSize * 0.5); // por debajo de la liq
      stopLossPrice = roundToTick(raw, tickSize, pricePrecision);
    } else {
      stopLossPrice = computeStopFromLiqTicks({
        side: 'SHORT',
        liqPrice: liquidationEst,
        currentPrice,
        entryPrice: executedPrice,
        tickSize,
        pricePrecision,
        symbol,
      });
    }

    // 7) STOP_MARKET (closePosition) con MARK_PRICE
    await binanceClient.futuresOrder({
      symbol,
      side: 'BUY',
      type: 'STOP_MARKET',
      stopPrice: String(stopLossPrice),
      closePosition: 'true',
      workingType: 'MARK_PRICE',
    });

    logHistory(`✅ SHORT ejecutada a ${executedPrice} | SL=${stopLossPrice}`);

    return {
      orderId: Number(order.orderId),
      avgFillPrice: executedPrice,
      executedQty: parseFloat(order.executedQty),
      stopPrice: stopLossPrice,
    };
  } catch (e: any) {
    const msg = `❌ Error ejecutando SHORT: ${e.message}`;
    console.error(msg);
    logHistory(msg);
    return null;
  }
}
