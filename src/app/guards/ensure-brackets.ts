// src/app/guards/brackets-guard.ts
import { Exchange } from '../../core/ports/Exchange';
import { StateStore } from '../../core/ports/StateStore';
import { Logger } from '../../core/ports/Logger';
import { CONFIG } from '../../infra/config';
import { atr } from '../../core/indicators/atr';
import { roundToTick } from '../../core/risk/stop';

type Side = 'LONG' | 'SHORT';

export async function bracketsGuard(symbol: string, ex: Exchange, st: StateStore, log: Logger) {
  const s = st.get();
  if (s.mode === 'IDLE' || !s.lastSide || !s.lastEntryPrice || !s.lastLeverage) return;

  // Si ya adjuntamos bracket una vez, no tocar nada más
  if ((s as any).bracketsAttached) return;

  // Debe existir posición activa
  const pos = await ex.readActivePosition(symbol, s.lastSide as Side);
  if (!pos || !pos.qtyAbs || pos.qtyAbs <= 0) return;

  // ¿Ya existen órdenes de cierre? Si sí, no re-armar
  let hasAnyClose = false;
  try {
    const list: Array<{ type: string }> =
      (await (ex as any).listCloseOrdersForSide?.(symbol, s.lastSide as Side)) ?? [];
    hasAnyClose = list.some(
      (o) =>
        o.type === 'STOP_MARKET' ||
        o.type === 'STOP' ||
        o.type === 'TAKE_PROFIT_MARKET' ||
        o.type === 'TAKE_PROFIT',
    );
  } catch {
    // si no hay API para listar, seguimos y confiamos en openStop/openTp si existieran
  }
  if (hasAnyClose) {
    // Ya hay bracket; marcamos y salimos
    st.set({ bracketsAttached: true });
    return;
  }

  // Calcular ATR para un bracket inicial prudente
  const candles = await ex.getCandles(symbol, CONFIG.ENTRY_TIMEFRAME, 400);
  const a = atr(candles, (CONFIG as any).ATR_LEN ?? 14);
  if (!Number.isFinite(a) || a <= 0) return;

  const filters = await ex.getSymbolFilters(symbol, s.lastLeverage);
  const mark = await ex.getMarkPrice(symbol);

  const trailMult = Number((CONFIG as any).TRAIL_ATR_MULT ?? 2.5);
  const tpMult = Number((CONFIG as any).TP_ATR_MULT ?? 3);

  // Stop inicial (tipo chandelier desde el precio actual)
  let stopPrice = (s.lastSide as Side) === 'LONG' ? mark - trailMult * a : mark + trailMult * a;

  // Que no quede "por el otro lado" del mark
  const oneTick = filters.tickSize;
  if ((s.lastSide as Side) === 'LONG') stopPrice = Math.min(stopPrice, mark - oneTick);
  else stopPrice = Math.max(stopPrice, mark + oneTick);

  stopPrice = roundToTick(stopPrice, filters.tickSize, filters.pricePrecision);

  // TP inicial simple basado en ATR desde la entrada
  let tpPrice =
    (s.lastSide as Side) === 'LONG'
      ? s.lastEntryPrice! + tpMult * a
      : s.lastEntryPrice! - tpMult * a;
  tpPrice = roundToTick(tpPrice, filters.tickSize, filters.pricePrecision);

  // Upsert inicial: si falla por límite, no reintentes en loop (pyramid-guard tomará el control)
  try {
    // coloca STOP
    await ex.placeStopClose(symbol, s.lastSide as Side, stopPrice);
    log.info('rearmed_stop', { ctx: { side: s.lastSide, stop: stopPrice } });

    // coloca TP (si tu Exchange expone el método)
    try {
      await (ex as any).placeTpClose?.(symbol, s.lastSide as Side, tpPrice);
      log.info('rearmed_tp', { ctx: { side: s.lastSide, tp: tpPrice } });
    } catch {
      // ignora si no hay API para TP
    }

    // Marca que ya se adjuntó bracket y deja el trailing al pyramid-guard
    st.set({ bracketsAttached: true, lastTrailStop: stopPrice });
    log.info('sync_attach_to_open_position', {
      ctx: { side: s.lastSide, entry: s.lastEntryPrice, lev: s.lastLeverage, qtyAbs: pos.qtyAbs },
    });
  } catch (e: any) {
    // Evita loops si choca con límite de stops o similar
    log.warn('brackets_attach_once_failed', { err: e?.message || String(e) });
  }
}
