import { Exchange } from '../../core/ports/Exchange';
import { StateStore } from '../../core/ports/StateStore';
import { Logger } from '../../core/ports/Logger';
import { CONFIG } from '../../infra/config';
import { atr as atrFn } from '../../core/indicators/atr';
import { ema } from '../../core/indicators/ema';

// --- memoria efímera para debounce de giveback ---
const gbSeenAt: Record<string, number> = {};
const gbKey = (sym: string, side: 'LONG' | 'SHORT') => `${sym}:${side}:gbSeenAt`;

export async function enforceProfitGuard(
  symbol: string,
  ex: Exchange,
  st: StateStore,
  log: Logger,
) {
  const s = st.get();
  if (s.mode === 'IDLE' || !s.lastSide || !s.lastEntryPrice) return;

  const pos = await ex.readActivePosition(symbol, s.lastSide);
  if (!pos) return;

  const mark = await ex.getMarkPrice(symbol);

  // ROE instantáneo (mantén cálculo como lo tenías)
  const roe =
    (s.lastSide === 'LONG'
      ? (mark - s.lastEntryPrice) / s.lastEntryPrice
      : (s.lastEntryPrice - mark) / s.lastEntryPrice) * pos.leverage;

  // Actualiza pico
  const prevPeak = Math.max(0, s.peakRoe ?? 0);
  const newPeak = Math.max(prevPeak, roe);
  if (newPeak !== prevPeak) st.set({ peakRoe: newPeak });

  // ---------- BE lock con histéresis ----------
  const be = CONFIG.PROFIT_LOCK_BE_AT_ROE;
  const beHyst = Number((CONFIG as any).PROFIT_LOCK_BE_HYST ?? 0.05);
  if (prevPeak >= be && roe < be - beHyst) {
    await ex.closeSideMarketSafe(symbol, s.lastSide, pos.qtyAbs, pos.sideMode);
    await (ex as any).cancelCloseOrdersForSide?.(symbol, s.lastSide);
    st.set({ mode: 'IDLE', lastExitReason: 'be_protect' });
    delete gbSeenAt[gbKey(symbol, s.lastSide)];
    log.info('BE_protect_close', { roe, be, beHyst });
    return;
  }

  // ---------- Giveback con ATR + debounce + (opcional) EMA confirm ----------
  const arm = CONFIG.PROFIT_GIVEBACK_ARM_ROE;
  if (newPeak >= arm) {
    const drop = newPeak - roe;
    const rel = newPeak > 0 ? drop / newPeak : 0;

    // ATR→ROE mínimo absoluto
    let atrRoeMin = 0;
    try {
      const candles = await ex.getCandles(symbol, CONFIG.ENTRY_TIMEFRAME, 120);
      if (candles.length >= CONFIG.ATR_LEN + 2) {
        const atr = atrFn(candles, CONFIG.ATR_LEN);
        atrRoeMin =
          (atr / s.lastEntryPrice) * pos.leverage * (CONFIG as any).PROFIT_GIVEBACK_ATR_ROE_MULT;
      }
    } catch {
      // si falla, atrRoeMin=0 y usamos solo el mínimo fijo
    }
    const absMin = Math.max(CONFIG.PROFIT_GIVEBACK_DROP_MIN, atrRoeMin);

    // (Opcional) confirmación de EMA corta
    let emaOk = true;
    if ((CONFIG as any).GIVEBACK_CONFIRM_EMA_ENABLED) {
      const candles = await ex.getCandles(symbol, CONFIG.ENTRY_TIMEFRAME, 100);
      if (candles.length > (CONFIG as any).GIVEBACK_CONFIRM_EMA_PERIOD + 2) {
        const e = ema(
          candles.map((c) => c.close),
          (CONFIG as any).GIVEBACK_CONFIRM_EMA_PERIOD,
        );
        const eLast = e[e.length - 1];
        emaOk = s.lastSide === 'LONG' ? mark < eLast : mark > eLast;
      }
    }

    const meets = rel >= CONFIG.PROFIT_GIVEBACK_DROP_REL && drop >= absMin && emaOk;

    const key = gbKey(symbol, s.lastSide);
    const debounceMs = Number((CONFIG as any).PROFIT_GIVEBACK_DEBOUNCE_MS ?? 7000);

    log.debug('profit_giveback_check', {
      newPeak,
      roe,
      drop,
      rel,
      relReq: CONFIG.PROFIT_GIVEBACK_DROP_REL,
      absMin,
      emaOk,
      debounceMs,
      seenAt: gbSeenAt[key] ?? null,
    });

    if (!meets) {
      // retroceso insuficiente o se invalidó → borra temporizador
      delete gbSeenAt[key];
      return;
    }

    // inicia / comprueba debounce
    if (!gbSeenAt[key]) {
      gbSeenAt[key] = Date.now();
      return; // espera a que se cumpla el tiempo
    }
    if (Date.now() - gbSeenAt[key] < debounceMs) {
      return; // aún no alcanza la persistencia requerida
    }

    // persistió el giveback → cerrar
    await ex.closeSideMarketSafe(symbol, s.lastSide, pos.qtyAbs, pos.sideMode);
    await (ex as any).cancelCloseOrdersForSide?.(symbol, s.lastSide);
    st.set({ mode: 'IDLE', lastExitReason: 'giveback' });
    delete gbSeenAt[key];
    log.info('Giveback_close', { newPeak, roe, drop, rel, absMin, debounceMs, emaOk });
  }
}
