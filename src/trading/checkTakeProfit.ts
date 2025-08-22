// src/trading/checkTakeProfit.ts
import { binanceClient } from '../api/binanceClient';
import { CONFIG } from '../utils/config';
import { logHistory } from '../utils/logger';
import { setState } from '../utils/state';

type TPResult = { closedByTP: 'LONG' | 'SHORT' | null };

function targetFromROE(entry: number, side: 'LONG' | 'SHORT', lev: number, feeBufPct: number) {
  const r = CONFIG.TP_ROE; // 1.0 => +100% ROE
  return side === 'LONG' ? entry * (1 + r / lev + feeBufPct) : entry * (1 - r / lev - feeBufPct);
}

async function closeSide(symbol: string, side: 'LONG' | 'SHORT', qtyAbs: number) {
  await binanceClient.futuresOrder({
    symbol,
    side: side === 'LONG' ? 'SELL' : 'BUY',
    type: 'MARKET',
    quantity: qtyAbs.toString(),
    reduceOnly: 'true',
    positionSide: side,
    newOrderRespType: 'RESULT',
  });
}

export async function checkTakeProfit(symbol: string): Promise<TPResult> {
  try {
    const info = await binanceClient.futuresAccountInfo();
    const marks = await binanceClient.futuresMarkPrice();
    const mk = marks.find((m) => m.symbol === symbol);
    if (!mk) return { closedByTP: null };
    const mark = parseFloat(mk.markPrice);

    const sides: Array<'LONG' | 'SHORT'> = ['LONG', 'SHORT'];
    for (const side of sides) {
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
      if (hit) {
        const qtyAbs = Math.abs(parseFloat(pos.positionAmt));
        logHistory(`🎯 TP ${side} alcanzado | entry=${entry} | mark=${mark} | lev=${lev}`);
        await closeSide(symbol, side, qtyAbs);
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
