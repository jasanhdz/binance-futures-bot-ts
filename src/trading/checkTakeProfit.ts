// src/trading/checkTakeProfit.ts
import { binanceClient } from '../api/binanceClient';
import { CONFIG } from '../utils/config';
import { logHistory } from '../utils/logger';
import { setState } from '../utils/state';

type TPResult = { closedByTP: 'LONG' | 'SHORT' | null };

/** -------- Helpers de filtros / cantidades -------- */
async function getSymbolLot(symbol: string) {
  const info = await binanceClient.futuresExchangeInfo();
  const s = info.symbols.find((x) => x.symbol === symbol);
  if (!s) throw new Error(`Símbolo no encontrado: ${symbol}`);

  const lot = (s.filters.find((f: any) => f.filterType === 'MARKET_LOT_SIZE') ||
    s.filters.find((f: any) => f.filterType === 'LOT_SIZE')) as any;

  const stepSize = parseFloat(lot?.stepSize ?? '0.1');
  const qtyPrecision = (lot?.stepSize ?? '0.1').split('.')[1]?.length ?? 1;

  return { stepSize, qtyPrecision };
}
function floorToStep(qty: number, step: number, precision: number) {
  const floored = Math.floor(qty / step) * step;
  return Number(floored.toFixed(precision));
}

/** -------- Cálculo del objetivo por ROE -------- */
function targetFromROE(entry: number, side: 'LONG' | 'SHORT', lev: number, feeBufPct: number) {
  const r = CONFIG.TP_ROE; // 1.0 => +100% ROE
  return side === 'LONG' ? entry * (1 + r / lev + feeBufPct) : entry * (1 - r / lev - feeBufPct);
}

/** -------- Cierre seguro respetando el modo de posiciones --------
 * - One-way (positionSide=BOTH): NO enviar reduceOnly ni positionSide.
 * - Hedge: sí enviar positionSide y reduceOnly:true.
 * - Si Binance rechaza reduceOnly, reintenta sin esa bandera.
 */
async function closeSideMarketSafe(
  symbol: string,
  side: 'LONG' | 'SHORT',
  qtyAbs: number,
  posSideMode: 'BOTH' | 'LONG' | 'SHORT',
) {
  const { stepSize, qtyPrecision } = await getSymbolLot(symbol);
  const quantity = floorToStep(qtyAbs, stepSize, qtyPrecision).toString();

  const base: any = {
    symbol,
    side: side === 'LONG' ? 'SELL' : 'BUY',
    type: 'MARKET',
    quantity,
    newOrderRespType: 'RESULT',
  };

  // En hedge, intenta con reduceOnly y positionSide; en one-way, sin ellos.
  let params: any =
    posSideMode === 'BOTH'
      ? { ...base }
      : { ...base, positionSide: side, reduceOnly: 'true' as const };

  try {
    return await binanceClient.futuresOrder(params);
  } catch (e: any) {
    const msg = (e?.message || '').toLowerCase();
    // Fallback si Binance no permite reduceOnly/positionSide en este contexto.
    if (msg.includes('reduceonly') || msg.includes('reduce only')) {
      const retry = { ...base }; // sin reduceOnly ni positionSide
      return await binanceClient.futuresOrder(retry);
    }
    throw e;
  }
}

/** -------- Verificador de TP por ROE -------- */
export async function checkTakeProfit(symbol: string): Promise<TPResult> {
  try {
    // Info de cuenta/posiciones y precio de marca actual
    const info = await binanceClient.futuresAccountInfo();
    const mkAll = await binanceClient.futuresMarkPrice();
    const mk = mkAll.find((m) => m.symbol === symbol);
    if (!mk) return { closedByTP: null };
    const mark = parseFloat(mk.markPrice);

    // Revisamos ambos lados
    const sides: Array<'LONG' | 'SHORT'> = ['LONG', 'SHORT'];
    for (const side of sides) {
      // Detectar si hay posición en ese lado (soporta one-way y hedge)
      const pos = info.positions.find((p) => {
        if (p.symbol !== symbol) return false;
        const amt = parseFloat(p.positionAmt);
        if (p.positionSide === 'BOTH') return side === 'LONG' ? amt > 0 : amt < 0;
        return p.positionSide === side && Math.abs(amt) > 0;
      });
      if (!pos) continue;

      const entry = parseFloat(pos.entryPrice);
      const lev = parseFloat(pos.leverage || `${CONFIG.LEVERAGE}`) || CONFIG.LEVERAGE;
      const target = targetFromROE(entry, side, lev, CONFIG.FEE_BUFFER_PCT);

      const hit = side === 'LONG' ? mark >= target : mark <= target;

      // Log de diagnóstico
      console.log(
        `[TPCHK] ${side} entry=${entry} mark=${mark} target=${target} lev=${lev} hit=${hit}`,
      );

      if (hit) {
        const qtyAbs = Math.abs(parseFloat(pos.positionAmt));
        logHistory(`🎯 TP ${side} alcanzado | entry=${entry} | mark=${mark} | lev=${lev}`);

        await closeSideMarketSafe(
          symbol,
          side,
          qtyAbs,
          (pos.positionSide as 'BOTH' | 'LONG' | 'SHORT') || 'BOTH',
        );

        setState({ lastTPAt: Date.now(), lastExitReason: 'tp' });
        logHistory(`💰 ${side} cerrado por ROE objetivo (${CONFIG.TP_ROE * 100}%)`);
        return { closedByTP: side };
      }
    }

    return { closedByTP: null };
  } catch (e: any) {
    const msg = `❌ Error verificando/cerrando TP: ${e.message}`;
    console.error(msg);
    logHistory(msg);
    return { closedByTP: null };
  }
}
