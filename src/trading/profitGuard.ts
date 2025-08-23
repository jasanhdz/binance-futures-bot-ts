// src/trading/profitGuard.ts
import { binanceClient } from '../api/binanceClient';
import { CONFIG } from '../utils/config';
import { getState, setState } from '../utils/state';
import { logHistory } from '../utils/logger';

/** Cierra lado en forma segura según modo (one-way/hedge). */
async function closeSideMarketSafe(
  symbol: string,
  side: 'LONG' | 'SHORT',
  qtyAbs: number,
  posSideMode: 'BOTH' | 'LONG' | 'SHORT',
) {
  const base: any = {
    symbol,
    side: side === 'LONG' ? 'SELL' : 'BUY',
    type: 'MARKET',
    quantity: qtyAbs.toString(),
    newOrderRespType: 'RESULT',
  };
  let params: any =
    posSideMode === 'BOTH'
      ? { ...base }
      : { ...base, positionSide: side, reduceOnly: 'true' as const };

  try {
    return await binanceClient.futuresOrder(params);
  } catch (e: any) {
    const m = (e?.message || '').toLowerCase();
    if (m.includes('reduceonly') || m.includes('reduce only')) {
      return await binanceClient.futuresOrder({ ...base }); // retry sin flags
    }
    throw e;
  }
}

/** ROE actual (decimal) según entry/lev y mark. */
function computeROE(side: 'LONG' | 'SHORT', entry: number, mark: number, lev: number) {
  const r = side === 'LONG' ? (mark - entry) / entry : (entry - mark) / entry;
  return r * lev; // 0.50 = +50%
}

/** Aplica las reglas de protección de ganancias: break-even y giveback. */
export async function enforceProfitGuard(symbol: string) {
  const st = getState();
  if (st.mode === 'IDLE' || !st.lastSide || !st.lastEntryPrice) return;

  // Lee posición abierta (soporta hedge/one-way)
  const info = await binanceClient.futuresAccountInfo();
  const pos = info.positions.find((p) => {
    if (p.symbol !== symbol) return false;
    const amt = parseFloat(p.positionAmt);
    if (p.positionSide === 'BOTH') return st.lastSide === 'LONG' ? amt > 0 : amt < 0;
    return p.positionSide === st.lastSide && Math.abs(amt) > 0;
  });
  if (!pos) return; // ya no hay posición (nada que hacer)

  const qtyAbs = Math.abs(parseFloat(pos.positionAmt));
  const entry = parseFloat(pos.entryPrice) || st.lastEntryPrice!;
  const lev =
    parseFloat(pos.leverage || `${st.lastLeverage ?? CONFIG.LEVERAGE}`) || CONFIG.LEVERAGE;

  // Precio de marca
  const mkAll = await binanceClient.futuresMarkPrice();
  const mk = mkAll.find((m) => m.symbol === symbol);
  if (!mk) return;
  const mark = parseFloat(mk.markPrice);

  const roe = computeROE(st.lastSide, entry, mark, lev);
  const peak = Math.max(0, st.peakRoe ?? 0);
  const newPeak = Math.max(peak, roe);
  if (newPeak !== peak) setState({ peakRoe: newPeak }); // actualiza pico

  // 1) Break-even: si ROE >= umbral y luego cae por debajo del umbral → cerrar
  if (peak >= CONFIG.PROFIT_LOCK_BE_AT_ROE && roe < CONFIG.PROFIT_LOCK_BE_AT_ROE) {
    await closeSideMarketSafe(symbol, st.lastSide, qtyAbs, (pos.positionSide as any) || 'BOTH');
    setState({ mode: 'IDLE', lastExitReason: 'be_protect' });
    logHistory(
      `🛟 BE protect: cerré ${st.lastSide} por caída bajo ${CONFIG.PROFIT_LOCK_BE_AT_ROE * 100}% ROE`,
    );
    return;
  }

  // 2) Giveback: si el pico >= arm threshold y la caída relativa supera el límite → cerrar
  if (newPeak >= CONFIG.PROFIT_GIVEBACK_ARM_ROE) {
    const drop = newPeak - roe; // caída en puntos de ROE (p.ej. 0.24 desde 0.80 a 0.56)
    const rel = newPeak > 0 ? drop / newPeak : 0; // caída relativa (30% de su pico)
    const hitRel = rel >= CONFIG.PROFIT_GIVEBACK_DROP_REL;
    const hitMin = drop >= CONFIG.PROFIT_GIVEBACK_DROP_MIN;

    if (hitRel && hitMin) {
      await closeSideMarketSafe(symbol, st.lastSide, qtyAbs, (pos.positionSide as any) || 'BOTH');
      setState({ mode: 'IDLE', lastExitReason: 'giveback' });
      logHistory(
        `🎯 Profit-guard: cerré ${st.lastSide} por giveback ` +
          `(pico=${(newPeak * 100).toFixed(1)}%, ahora=${(roe * 100).toFixed(1)}%)`,
      );
      return;
    }
  }
}
