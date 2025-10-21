// src/app/guards/ensure-brackets.ts
import { Exchange } from '../../core/ports/Exchange';
import { StateStore } from '../../core/ports/StateStore';
import { Logger } from '../../core/ports/Logger';
import { CONFIG } from '../../infra/config';
import { computeStopFromMaxLoss, roundToTick } from '../../core/risk/stop';
import { Side } from '../../core/types';

export async function bracketsGuard(symbol: string, ex: Exchange, st: StateStore, log: Logger) {
  const s = st.get();
  if (s.mode === 'IDLE' || !s.lastSide || !s.lastEntryPrice) {
    log.debug('brackets_skip_idle', {
      symbol,
      mode: s.mode,
      hasSide: !!s.lastSide,
      hasEntry: !!s.lastEntryPrice,
    });
    return;
  }

  // Debe existir posición activa
  let pos: Awaited<ReturnType<Exchange['readActivePosition']>> | null = null;
  try {
    pos = await ex.readActivePosition(symbol, s.lastSide as Side);
  } catch (err) {
    log.warn('brackets_read_position_fail', {
      symbol,
      side: s.lastSide,
      err: (err as any)?.message || String(err),
    });
  }
  if (!pos || !pos.qtyAbs || pos.qtyAbs <= 0) {
    log.debug('brackets_skip_no_position', { symbol, side: s.lastSide });
    return;
  }

  // Leer órdenes existentes del lado activo
  const stopOpen = await ex.openStopForSide(symbol, s.lastSide as Side);
  const tpOpen = await (ex as any).openTpForSide?.(symbol, s.lastSide as Side);

  log.debug('brackets_status', {
    symbol,
    side: s.lastSide,
    stopOpen: stopOpen?.stopPrice,
    tpOpen: tpOpen?.stopPrice,
    leverage: pos.leverage,
  });

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

    try {
      await ex.placeStopClose(symbol, s.lastSide as Side, stop);
      log.info('stop_created_max_loss', {
        symbol,
        side: s.lastSide,
        stop,
        entryPrice: s.lastEntryPrice,
        ticksFromEntry,
        priceMovePct: `${priceMovePct.toFixed(3)}%`,
        capitalLoss: `${capitalLossPct.toFixed(1)}%`,
      });
      st.set({ lastTrailStop: stop });
    } catch (err) {
      log.error('stop_upsert_failed', {
        symbol,
        side: s.lastSide,
        stop,
        err: (err as any)?.message || String(err),
      });
    }
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

    try {
      await ex.placeTpClose(symbol, s.lastSide as Side, tp);
      log.info('ensure_tp_created', { symbol, side: s.lastSide, tp });
    } catch (err) {
      log.error('tp_upsert_failed', {
        symbol,
        side: s.lastSide,
        tp,
        err: (err as any)?.message || String(err),
      });
    }
  }

  // Marca "armado" solo si realmente ya están ambos
  const stopNow = stopOpen || (await ex.openStopForSide(symbol, s.lastSide as Side));
  const tpNow = tpOpen || (await (ex as any).openTpForSide?.(symbol, s.lastSide as Side));
  if (stopNow && tpNow) {
    if (!s.bracketsAttached) {
      log.info('brackets_guard_attached', { symbol, side: s.lastSide });
    }
    st.set({ bracketsAttached: true });
  } else {
    log.debug('brackets_incomplete', {
      symbol,
      side: s.lastSide,
      stopPresent: !!stopNow,
      tpPresent: !!tpNow,
    });
  }
}
