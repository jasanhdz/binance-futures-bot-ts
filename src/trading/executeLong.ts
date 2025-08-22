import { getRealLiqPrice } from '../strategy/liquidation';
import { binanceClient } from '../api/binanceClient';
import { OrderResponse } from '../types';
import { CONFIG } from '../utils/config';
import { logHistory } from '../utils/logger';
import { computeStopFromLiqTicks } from './stopLoss';

const { LEVERAGE } = CONFIG;

/** Helpers de filtros de símbolo (precision/cantidades) */
async function getSymbolFilters(symbol: string) {
  const info = await binanceClient.futuresExchangeInfo();
  const s = info.symbols.find((x) => x.symbol === symbol);
  if (!s) throw new Error(`Símbolo no encontrado en exchangeInfo: ${symbol}`);

  const priceFilter = s.filters.find((f: any) => f.filterType === 'PRICE_FILTER') as any;
  const marketLot = s.filters.find((f: any) => f.filterType === 'MARKET_LOT_SIZE') as any;
  const lot = s.filters.find((f: any) => f.filterType === 'LOT_SIZE') as any;
  const minNotional =
    (s.filters.find((f: any) => f.filterType === 'MIN_NOTIONAL') as any)?.notional ?? '5';

  const tickSize = parseFloat(priceFilter?.tickSize ?? '0.0001');
  const stepSize = parseFloat(marketLot?.stepSize ?? lot?.stepSize ?? '0.1');
  const pricePrecision = priceFilter?.tickSize?.split?.('.')[1]?.length ?? 4;
  const qtyPrecision = (marketLot?.stepSize ?? lot?.stepSize)?.split?.('.')[1]?.length ?? 1;

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

/**
 * Coloca una orden LONG usando todo el balance disponible con apalancamiento y SL automático.
 */
export async function executeLongTrade(symbol: string = 'XRPUSDT'): Promise<OrderResponse | null> {
  try {
    // 1) Balance USDT (Futuros)
    const balances = await binanceClient.futuresAccountBalance();
    const usdt = balances.find((b) => b.asset === 'USDT');
    const usdtBalance = parseFloat(usdt?.availableBalance ?? '0');
    if (usdtBalance <= 0) {
      logHistory('❌ No tienes USDT disponible para operar.');
      return null;
    }

    // 2) Mark price
    const marks = await binanceClient.futuresMarkPrice();
    const mark = marks.find((m) => m.symbol === symbol);
    const currentPrice = mark ? parseFloat(mark.markPrice) : NaN;
    if (!isFinite(currentPrice)) throw new Error(`No se pudo obtener markPrice de ${symbol}`);

    // 3) Apalancamiento
    await binanceClient.futuresLeverage({ symbol, leverage: LEVERAGE });

    // 4) Filtros + cantidad respetando step y minNotional
    const { stepSize, tickSize, pricePrecision, qtyPrecision, minNotional } =
      await getSymbolFilters(symbol);

    const enterPrice = usdtBalance * CONFIG.CAPITAL_USAGE_PCT;
    const rawQty = (enterPrice * LEVERAGE) / currentPrice;
    let qtyNum = floorToStep(rawQty, stepSize, qtyPrecision);
    console.log({ usdtBalance, LEVERAGE, currentPrice, qtyPrecision, enterPrice, qtyNum });

    const minQtyByNotional = ceilToStep(minNotional / currentPrice, stepSize, qtyPrecision);
    if (qtyNum < minQtyByNotional) {
      qtyNum = minQtyByNotional;
    }

    // margen requerido
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
    logHistory(`🔔 Ejecutando LONG ${symbol} qty=${quantity} @ ~${currentPrice}`);

    // 5) Compra a mercado
    const order = await binanceClient.futuresOrder({
      symbol,
      side: 'BUY',
      type: 'MARKET',
      quantity,
      newOrderRespType: 'RESULT',
    });

    const executedPrice = parseFloat(order.avgPrice || currentPrice.toString());

    // 6) Estimar liquidación y calcular SL a N ticks por encima (LONG)
    const liqReal = await getRealLiqPrice(symbol, 'LONG');

    // Calcula SL a N ticks sobre la liq REAL, con guardas:
    let stopLossPrice = computeStopFromLiqTicks({
      side: 'LONG',
      liqPrice: liqReal,
      currentPrice, // mark actual
      entryPrice: executedPrice,
      tickSize,
      pricePrecision,
      symbol,
    });

    // Por seguridad ante el redondeo al tick:
    if (stopLossPrice <= liqReal)
      stopLossPrice = Number((liqReal + tickSize).toFixed(pricePrecision));

    console.log('[SL LONG]', { entry: executedPrice, mark: currentPrice, liqReal, stopLossPrice });

    // Coloca el STOP_MARKET con MARK_PRICE
    await binanceClient.futuresOrder({
      symbol,
      side: 'SELL',
      type: 'STOP_MARKET',
      stopPrice: String(stopLossPrice),
      closePosition: 'true',
      workingType: 'MARK_PRICE',
    });
    logHistory(`✅ LONG ejecutada a ${executedPrice} | SL=${stopLossPrice}`);

    return {
      orderId: Number(order.orderId),
      avgFillPrice: executedPrice,
      executedQty: parseFloat(order.executedQty),
      stopPrice: Number(stopLossPrice),
    };
  } catch (error: any) {
    const errMsg = `❌ Error ejecutando orden LONG: ${error.message}`;
    console.error(errMsg);
    logHistory(errMsg);
    return null;
  }
}
