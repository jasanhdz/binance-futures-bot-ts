import { getRealLiqPrice } from '../strategy/liquidation';
import { binanceClient } from '../api/binanceClient';
import { OrderResponse } from '../types';
import { CONFIG } from '../utils/config';
import { logHistory } from '../utils/logger';
import { computeStopFromLiqTicks } from './stopLoss';
import {
  ceilToStep,
  floorToStep,
  getSymbolFilters,
  isHedgeMode,
  roundToTick,
  targetFromROE,
} from '../utils/trading';
import { setState } from '../utils/state';

const { LEVERAGE } = CONFIG;
/**
 * Abre LONG a mercado usando budget real (con fee buffer) + SL por liqui real + TP armado.
 */
export async function executeLongTrade(symbol: string = 'XRPUSDT'): Promise<OrderResponse | null> {
  try {
    const balances = await binanceClient.futuresAccountBalance();
    const usdt = balances.find((b) => b.asset === 'USDT');
    const usdtBalance = parseFloat(usdt?.availableBalance ?? '0');
    if (usdtBalance <= 0) {
      logHistory('❌ No tienes USDT disponible para operar.');
      return null;
    }

    const marks = await binanceClient.futuresMarkPrice();
    const mark = marks.find((m) => m.symbol === symbol);
    const currentPrice = mark ? parseFloat(mark.markPrice) : NaN;
    if (!isFinite(currentPrice)) throw new Error(`No se pudo obtener markPrice de ${symbol}`);

    await binanceClient.futuresLeverage({ symbol, leverage: LEVERAGE });

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
    const minQtyByNotional = ceilToStep(minNotional / currentPrice, stepSize, qtyPrecision);
    if (qtyNum < minQtyByNotional) qtyNum = minQtyByNotional;

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
      logHistory('⚠️ No se pudo ajustar cantidad para que el margen alcance (LONG).');
      return null;
    }

    const finalNotional = qtyNum * currentPrice;
    const finalFees = finalNotional * feePct;
    const finalInitMargin = finalNotional / LEVERAGE;

    console.log('[LONG sizing]', {
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
      finalNotional: Number(finalNotional.toFixed(6)),
      finalInitMargin: Number(finalInitMargin.toFixed(6)),
      finalFees: Number(finalFees.toFixed(6)),
      maxSpendable: Number(maxSpendable.toFixed(6)),
    });

    const quantity = String(qtyNum);
    logHistory(`🔔 Ejecutando LONG ${symbol} qty=${quantity} @ ~${currentPrice}`);

    const order = await binanceClient.futuresOrder({
      symbol,
      side: 'BUY',
      type: 'MARKET',
      quantity,
      newOrderRespType: 'RESULT',
    });

    const executedPrice = parseFloat(order.avgPrice || currentPrice.toString());

    const liqReal = await getRealLiqPrice(symbol, 'LONG');
    let stopLossPrice = computeStopFromLiqTicks({
      side: 'LONG',
      liqPrice: liqReal,
      currentPrice,
      entryPrice: executedPrice,
      tickSize,
      pricePrecision,
      symbol,
    });
    if (stopLossPrice <= liqReal) {
      stopLossPrice = Number((liqReal + tickSize).toFixed(pricePrecision));
    }

    const hedge = await isHedgeMode();
    console.log('[SL LONG]', { entry: executedPrice, mark: currentPrice, liqReal, stopLossPrice });

    const slParams: any = {
      symbol,
      side: 'SELL',
      type: 'STOP_MARKET',
      stopPrice: String(stopLossPrice),
      closePosition: 'true',
      workingType: 'MARK_PRICE',
    };
    if (hedge) slParams.positionSide = 'LONG';
    await binanceClient.futuresOrder(slParams);

    const tpRaw = targetFromROE(executedPrice, 'LONG', LEVERAGE, CONFIG.FEE_BUFFER_PCT);
    const tpTrigger = roundToTick(tpRaw, tickSize, pricePrecision);

    const tpParams: any = {
      symbol,
      side: 'SELL',
      type: 'TAKE_PROFIT_MARKET',
      stopPrice: String(tpTrigger),
      closePosition: 'true',
      workingType: 'MARK_PRICE',
    };
    if (hedge) tpParams.positionSide = 'LONG';
    await binanceClient.futuresOrder(tpParams);

    console.log(`[TP LONG] armado @ ${tpTrigger} (entry=${executedPrice}, lev=${LEVERAGE})`);
    logHistory(`✅ LONG ejecutada a ${executedPrice} | SL=${stopLossPrice} | TP=${tpTrigger}`);

    // ← NUEVO: registra contexto para el profit-guard / re-entradas
    setState({
      lastSide: 'LONG',
      lastEntryPrice: executedPrice,
      lastLeverage: LEVERAGE,
      peakRoe: 0,
      tpTrigger,
    });

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
