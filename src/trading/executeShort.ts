import { binanceClient } from '../api/binanceClient';
import { CONFIG } from '../utils/config';
import { logHistory } from '../utils/logger';
import { OrderResponse } from '../types';
import { computeStopFromLiqTicks } from './stopLoss';
import { getRealLiqPrice } from '../strategy/liquidation';
import {
  ceilToStep,
  floorToStep,
  getSymbolFilters,
  isHedgeMode,
  roundToTick,
  targetFromROE,
  // ⬇️ NUEVO: helpers para bracket cap
  getLeverageCapNotional,
  clampQtyByNotionalCap,
} from '../utils/trading';
import { setState } from '../utils/state';

const { LEVERAGE } = CONFIG;

/** Abre SHORT a mercado + SL por liqui real + TP armado al abrir. */
export async function executeShortTrade(
  symbol: string,
  _opts?: { stopLossPrice?: number },
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

    // 4) Filtros del símbolo y sizing base
    const { stepSize, tickSize, pricePrecision, qtyPrecision, minNotional } =
      await getSymbolFilters(symbol);

    const reserve = Number(process.env.MIN_WALLET_RESERVE_USDT ?? '0.5');
    const feePct = CONFIG.FEE_BUFFER_PCT;
    const budget = Math.max(0, (usdtBalance - reserve) * CONFIG.CAPITAL_USAGE_PCT);
    if (budget <= 0) {
      logHistory(
        `⚠️ Presupuesto insuficiente tras reserva. balance=${usdtBalance} reserve=${reserve}`,
      );
      return null;
    }

    let qtyNum = floorToStep((budget * LEVERAGE) / currentPrice, stepSize, qtyPrecision);

    // Cumplir mínimo nocional del símbolo
    const minQtyByNotional = ceilToStep(minNotional / currentPrice, stepSize, qtyPrecision);
    if (qtyNum < minQtyByNotional) qtyNum = minQtyByNotional;

    // Ajuste por margen disponible (margen inicial + fees <= disponible)
    const maxSpendable = Math.max(0, usdtBalance - reserve);
    const fits = () => {
      const notional = qtyNum * currentPrice;
      const fees = notional * feePct;
      const initMargin = notional / LEVERAGE;
      return initMargin + fees <= maxSpendable;
    };
    let guard = 60;
    while (!fits() && qtyNum > 0 && guard-- > 0) {
      qtyNum = floorToStep(qtyNum - stepSize, stepSize, qtyPrecision);
    }
    if (qtyNum <= 0) {
      logHistory('⚠️ No se pudo ajustar cantidad para que el margen alcance (SHORT).');
      return null;
    }

    // ⬇️ NUEVO: Ajuste por "notional cap" del risk-bracket a este apalancamiento
    const notionalCap = await getLeverageCapNotional(symbol, LEVERAGE); // usa recvWindow internamente
    if (isFinite(notionalCap)) {
      // margen de seguridad del 2% para evitar roces
      const safeCap = notionalCap * 0.98;
      qtyNum = clampQtyByNotionalCap(qtyNum, currentPrice, safeCap, stepSize, qtyPrecision);

      // Si el cap del tier es menor que el mínimo nocional del símbolo, no se puede abrir
      if (qtyNum < minQtyByNotional) {
        logHistory(
          `⚠️ Risk bracket limita nocional (~${safeCap.toFixed(
            2,
          )}) por debajo del mínimo de símbolo (${minNotional}). No se abre la operación.`,
        );
        return null;
      }
    }

    const finalNotional = qtyNum * currentPrice;
    const finalFees = finalNotional * feePct;
    const finalInitMargin = finalNotional / LEVERAGE;

    console.log('[SHORT sizing]', {
      usdtBalance,
      reserve,
      CAPITAL_USAGE_PCT: CONFIG.CAPITAL_USAGE_PCT,
      feePct,
      budget,
      currentPrice,
      qtyPrecision,
      stepSize,
      qtyNum,
      minQtyByNotional,
      notionalCap: isFinite(notionalCap) ? Number(notionalCap.toFixed(6)) : '∞',
      finalNotional: Number(finalNotional.toFixed(6)),
      finalInitMargin: Number(finalInitMargin.toFixed(6)),
      finalFees: Number(finalFees.toFixed(6)),
      maxSpendable: Number(maxSpendable.toFixed(6)),
    });

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

    // 6) Stop Loss: a N ticks por DEBAJO de la liqui real (SHORT)
    const liqReal = await getRealLiqPrice(symbol, 'SHORT');
    let stopLossPrice = computeStopFromLiqTicks({
      side: 'SHORT',
      liqPrice: liqReal,
      currentPrice,
      entryPrice: executedPrice,
      tickSize,
      pricePrecision,
      symbol,
    });
    if (stopLossPrice >= liqReal) {
      stopLossPrice = Number((liqReal - tickSize).toFixed(pricePrecision));
    }

    const hedge = await isHedgeMode();

    console.log('[SL SHORT]', { entry: executedPrice, mark: currentPrice, liqReal, stopLossPrice });

    const slParams: any = {
      symbol,
      side: 'BUY',
      type: 'STOP_MARKET',
      stopPrice: String(stopLossPrice),
      closePosition: 'true',
      workingType: 'MARK_PRICE',
    };
    if (hedge) slParams.positionSide = 'SHORT';
    await binanceClient.futuresOrder(slParams);

    // 7) TAKE_PROFIT_MARKET basado en ROE
    const tpRaw = targetFromROE(executedPrice, 'SHORT', LEVERAGE, CONFIG.FEE_BUFFER_PCT);
    const tpTrigger = roundToTick(tpRaw, tickSize, pricePrecision);

    const tpParams: any = {
      symbol,
      side: 'BUY',
      type: 'TAKE_PROFIT_MARKET',
      stopPrice: String(tpTrigger),
      closePosition: 'true',
      workingType: 'MARK_PRICE',
    };
    if (hedge) tpParams.positionSide = 'SHORT';
    await binanceClient.futuresOrder(tpParams);

    console.log(`[TP SHORT] armado @ ${tpTrigger} (entry=${executedPrice}, lev=${LEVERAGE})`);
    logHistory(`✅ SHORT ejecutada a ${executedPrice} | SL=${stopLossPrice} | TP=${tpTrigger}`);

    // Contexto para profit-guard / re-entradas
    setState({
      lastSide: 'SHORT',
      lastEntryPrice: executedPrice,
      lastLeverage: LEVERAGE,
      peakRoe: 0,
      tpTrigger,
    });

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
