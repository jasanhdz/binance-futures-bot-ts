// src/app/guards/ensure-brackets.ts
import { Exchange } from '../../core/ports/Exchange';
import { StateStore } from '../../core/ports/StateStore';
import { Logger } from '../../core/ports/Logger';
import { CONFIG } from '../../infra/config';
import { computeStopFromMaxLoss, roundToTick } from '../../core/risk/stop';
import { Side } from '../../core/types';

export async function bracketsGuard(symbol: string, ex: Exchange, st: StateStore, log: Logger) {
  const s = st.get();
  if (s.mode === 'IDLE' || !s.lastSide || !s.lastEntryPrice) return;

  // Debe existir posición activa
  const pos = await ex.readActivePosition(symbol, s.lastSide as Side);
  if (!pos || !pos.qtyAbs || pos.qtyAbs <= 0) return;

  // Leer órdenes existentes del lado activo
  const stopOpen = await ex.openStopForSide(symbol, s.lastSide as Side);
  const tpOpen = await (ex as any).openTpForSide?.(symbol, s.lastSide as Side);

  const filters = await ex.getSymbolFilters(symbol, pos.leverage ?? s.lastLeverage!);

  // ---- STOP: Ahora basado en pérdida máxima desde ENTRADA ----
  if (!stopOpen) {
    // Usar los ticks configurados (69 para XRP = ~24% pérdida con 100x)
    const ticksFromEntry =
      CONFIG.SL_TICKS_ABOVE_LIQ_MAP[symbol] ?? CONFIG.SL_TICKS_ABOVE_LIQ_DEFAULT ?? 69;

    const stop = computeStopFromMaxLoss({
      side: s.lastSide as Side,
      entryPrice: s.lastEntryPrice!,
      tickSize: filters.tickSize,
      pricePrecision: filters.pricePrecision,
      ticksFromEntry: ticksFromEntry,
    });

    // Calcular el porcentaje de pérdida para logging
    const leverage = pos.leverage ?? s.lastLeverage ?? 100;
    const priceMovePct = (Math.abs(stop - s.lastEntryPrice!) / s.lastEntryPrice!) * 100;
    const capitalLossPct = priceMovePct * leverage;

    await ex.placeStopClose(symbol, s.lastSide as Side, stop);
    log.info('stop_created_max_loss', {
      side: s.lastSide,
      stop,
      entryPrice: s.lastEntryPrice,
      ticksFromEntry,
      priceMovePct: `${priceMovePct.toFixed(3)}%`,
      capitalLoss: `${capitalLossPct.toFixed(1)}%`,
    });
    st.set({ lastTrailStop: stop });
  }

  // ---- TP: sin cambios ----
  if (!tpOpen) {
    const r = CONFIG.TP_ROE;
    const fee = CONFIG.FEE_BUFFER_PCT;
    const lev = pos.leverage ?? s.lastLeverage!;
    const tpRaw =
      s.lastSide === 'LONG'
        ? s.lastEntryPrice! * (1 + r / lev + fee)
        : s.lastEntryPrice! * (1 - r / lev - fee);
    const tp = roundToTick(tpRaw, filters.tickSize, filters.pricePrecision);

    await ex.placeTpClose(symbol, s.lastSide as Side, tp);
    log.info('ensure_tp_created', { side: s.lastSide, tp });
  }

  // Marca "armado" solo si realmente ya están ambos
  const stopNow = stopOpen || (await ex.openStopForSide(symbol, s.lastSide as Side));
  const tpNow = tpOpen || (await (ex as any).openTpForSide?.(symbol, s.lastSide as Side));
  if (stopNow && tpNow) {
    st.set({ bracketsAttached: true });
  }
}
