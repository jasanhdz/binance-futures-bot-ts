// src/app/guards/ensure-brackets.ts
import { Exchange } from '../../core/ports/Exchange';
import { StateStore } from '../../core/ports/StateStore';
import { Logger } from '../../core/ports/Logger';
import { CONFIG } from '../../infra/config';
import { computeStopFromLiqTicks, roundToTick } from '../../core/risk/stop';
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
  const price = await ex.getMarkPrice(symbol);

  // ---- STOP: si falta, créalo con lógica de liquidación + ticks ----
  if (!stopOpen) {
    const liq = (await ex.readLiquidationPrice(symbol, s.lastSide as Side)) ?? price;
    const ticks = CONFIG.SL_TICKS_ABOVE_LIQ_MAP[symbol] ?? CONFIG.SL_TICKS_ABOVE_LIQ_DEFAULT ?? 4;

    const stop = computeStopFromLiqTicks({
      side: s.lastSide as Side,
      liqPrice: liq,
      currentPrice: price,
      entryPrice: s.lastEntryPrice!,
      tickSize: filters.tickSize,
      pricePrecision: filters.pricePrecision,
      ticksAboveLiq: ticks,
    });

    await ex.placeStopClose(symbol, s.lastSide as Side, stop);
    log.info('ensure_stop_created', { side: s.lastSide, stop });
    st.set({ lastTrailStop: stop }); // registro informativo
  }

  // ---- TP: si falta, créalo según ROE objetivo ----
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

  // Marca “armado” solo si realmente ya están ambos
  const stopNow = stopOpen || (await ex.openStopForSide(symbol, s.lastSide as Side));
  const tpNow = tpOpen || (await (ex as any).openTpForSide?.(symbol, s.lastSide as Side));
  if (stopNow && tpNow) {
    st.set({ bracketsAttached: true }); // idempotente
  }
}
