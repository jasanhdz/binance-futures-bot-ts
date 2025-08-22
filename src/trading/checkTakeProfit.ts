import { setState } from '../utils/state';
import { binanceClient } from '../api/binanceClient';
import { CONFIG } from '../utils/config';
import { logHistory } from '../utils/logger';

function targetFromROE(entry: number, side: 'LONG' | 'SHORT', lev: number, feeBufPct: number) {
  const r = CONFIG.TP_ROE; // ej. 1.0 => +100%
  if (side === 'LONG') {
    // mark = entry * (1 + r/lev + feeBuf)
    return entry * (1 + r / lev + feeBufPct);
  }
  // SHORT: mark = entry * (1 - r/lev - feeBuf)
  return entry * (1 - r / lev - feeBufPct);
}

async function closePositionMarket(
  symbol: string,
  side: 'LONG' | 'SHORT',
  qtyAbs: number,
): Promise<void> {
  const orderSide = side === 'LONG' ? 'SELL' : 'BUY';
  await binanceClient.futuresOrder({
    symbol,
    side: orderSide,
    type: 'MARKET',
    quantity: qtyAbs.toString(),
    reduceOnly: 'true',
    // si usas Hedge Mode, especificar positionSide ayuda a no cerrar la contraria
    positionSide: side,
    newOrderRespType: 'RESULT',
  });
}

export async function checkTakeProfit(symbol: string): Promise<void> {
  try {
    // 1) Info de cuenta (incluye posiciones y leverage por símbolo)
    const info = await binanceClient.futuresAccountInfo();
    const positions = info.positions || [];

    // Soportar One-way (BOTH) y Hedge (LONG/SHORT). Cerramos cada lado por separado si existe.
    const sides: Array<{ posSide: 'LONG' | 'SHORT'; match: (p: any) => boolean }> = [
      {
        posSide: 'LONG',
        match: (p) =>
          p.symbol === symbol &&
          ((p.positionSide === 'LONG' && Math.abs(parseFloat(p.positionAmt)) > 0) ||
            (p.positionSide === 'BOTH' && parseFloat(p.positionAmt) > 0)),
      },
      {
        posSide: 'SHORT',
        match: (p) =>
          p.symbol === symbol &&
          ((p.positionSide === 'SHORT' && Math.abs(parseFloat(p.positionAmt)) > 0) ||
            (p.positionSide === 'BOTH' && parseFloat(p.positionAmt) < 0)),
      },
    ];

    // 2) Mark prices (array para todos los símbolos)
    const marks = await binanceClient.futuresMarkPrice();
    const markRec = marks.find((m) => m.symbol === symbol);
    if (!markRec) return;
    const markPrice = parseFloat(markRec.markPrice);

    for (const s of sides) {
      const pos = positions.find(s.match);
      if (!pos) continue;

      const amt = parseFloat(pos.positionAmt);
      const qtyAbs = Math.abs(amt);
      if (!qtyAbs) continue;

      const entry = parseFloat(pos.entryPrice);
      const lev = parseFloat(pos.leverage || String(CONFIG.LEVERAGE)) || CONFIG.LEVERAGE;

      const target = targetFromROE(entry, s.posSide, lev, CONFIG.FEE_BUFFER_PCT);

      const hit =
        s.posSide === 'LONG'
          ? markPrice >= target // LONG: si el mark alcanza o supera target
          : markPrice <= target; // SHORT: si cae hasta target o más

      if (hit) {
        logHistory(
          `🎯 TP ROE alcanzado | ${symbol} | side=${s.posSide} | entry=${entry} | mark=${markPrice} | lev=${lev}`,
        );
        await closePositionMarket(symbol, s.posSide, qtyAbs);
        const now = Date.now();
        setState({ lastTPAt: now, lastSide: s.posSide, lastExitReason: 'tp' });
        logHistory(`💰 Posición ${s.posSide} cerrada por ROE objetivo (${CONFIG.TP_ROE * 100}%)`);
      }
    }
  } catch (e: any) {
    const errMsg = `❌ Error verificando/cerrando TP: ${e.message}`;
    console.error(errMsg);
    logHistory(errMsg);
  }
}
