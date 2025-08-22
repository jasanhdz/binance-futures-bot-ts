// src/strategy/signalDetector.ts
import { longSignal, shortSignal } from './signalRules';
import { hasOpenPosition } from '../trading/hasOpenPosition';
import { CONFIG } from '../utils/config';
import { getCandles } from './indicators';

export async function evaluateSignals(symbol: string) {
  // No abrir si ya hay alguna posición
  if (await hasOpenPosition(symbol, 'ANY')) {
    return { longOk: false, shortOk: false, reason: 'alreadyOpen' };
  }

  // ===== BYPASS PARA PRUEBA RAPIDA =====
  if (CONFIG.BYPASS_ENTRY_CHECKS) {
    let side: 'LONG' | 'SHORT' | undefined = CONFIG.BYPASS_SIDE;

    // Si no especificas lado, decide por la última vela (verde => LONG, roja => SHORT)
    if (!side) {
      const cs = await getCandles(symbol, CONFIG.ENTRY_TIMEFRAME, 2);
      if (cs.length) {
        const last = cs[cs.length - 1];
        side = last.close >= last.open ? 'LONG' : 'SHORT';
      } else {
        side = 'LONG'; // fallback
      }
    }

    return {
      longOk: side === 'LONG',
      long: { ok: side === 'LONG', reason: 'bypass' },
      shortOk: side === 'SHORT',
      short: { ok: side === 'SHORT', reason: 'bypass' },
    };
  }
  // =====================================

  // Lógica normal (sin bypass)
  const [ls, ss] = await Promise.all([longSignal(symbol), shortSignal(symbol)]);
  console.log('[LOG - evaluateSignals]', { ls, ss });

  return {
    longOk: !!ls.ok,
    long: ls,
    shortOk: !!ss.ok,
    short: ss,
  };
}
