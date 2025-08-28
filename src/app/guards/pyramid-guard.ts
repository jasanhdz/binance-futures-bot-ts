// src/app/guards/pyramid-guard.ts
import { Exchange } from '../../core/ports/Exchange';
import { StateStore } from '../../core/ports/StateStore';
import { Logger } from '../../core/ports/Logger';
import { CONFIG } from '../../infra/config';
import { atr } from '../../core/indicators/atr';
import { roundToTick } from '../../core/risk/stop';
import { floorToStep, ceilToStep } from '../../core/risk/sizing';

/**
 * Guard de Piramidación + Trailing ATR.
 * - Añade unidades cuando el precio avanza stepATR*ATR desde el último add/base.
 * - Mueve el stop con un Chandelier simplificado (solo si mejora).
 * - Incluye defensas de margen/notional/precisión y limpieza si Binance devuelve
 *   "Reach max stop order limit".
 */

// Cooldown para no spamear adds si Binance rechaza
const ADD_ERR_COOLDOWN_MS = 60_000;
const lastAddErrorAt: Record<string, number> = {};
const addErrKey = (sym: string, side: 'LONG' | 'SHORT') => `${sym}:${side}:addErrAt`;

// Throttle opcional para trailing (reduce ruido de upserts)
const TRAIL_THROTTLE_MS = Number((CONFIG as any).TRAIL_THROTTLE_MS ?? 15_000);
const lastTrailTryAt: Record<string, number> = {};
const trailKey = (sym: string, side: 'LONG' | 'SHORT') => `${sym}:${side}:trailAt`;

export async function pyramidGuard(symbol: string, ex: Exchange, st: StateStore, log: Logger) {
  const s = st.get();
  if (s.mode === 'IDLE' || !s.lastSide || !s.lastEntryPrice || !s.lastLeverage) return;

  // 1) Datos y ATR
  const candles = await ex.getCandles(symbol, CONFIG.ENTRY_TIMEFRAME, 400);
  if (candles.length < Math.max(100, (CONFIG as any).ATR_LEN + 2)) return;

  const a = atr(candles, (CONFIG as any).ATR_LEN);
  if (!Number.isFinite(a) || a <= 0) return;

  const mark = await ex.getMarkPrice(symbol);
  const filters = await ex.getSymbolFilters(symbol, s.lastLeverage);

  const maxUnits = Number((CONFIG as any).PYRAMID_MAX_UNITS ?? 3);
  const stepATR = Number((CONFIG as any).PYRAMID_STEP_ATR ?? 0.5);
  const unitPct = Number((CONFIG as any).PYRAMID_UNIT_PCT_OF_ENTRY ?? 0.5);
  const trailMult = Number((CONFIG as any).TRAIL_ATR_MULT ?? 2.5);
  const improveMin = Number((CONFIG as any).STOP_MIN_IMPROVE_TICKS ?? 2); // mejora mínima en ticks

  // 2) Piramidación: añade si el precio avanzó >= stepATR*ATR
  const basePrice = s.lastPyramidPrice ?? s.lastEntryPrice;
  const move = Math.abs(mark - basePrice);
  const needMove = stepATR * a;

  const pos = await ex.readActivePosition(symbol, s.lastSide);
  if (!pos) return;

  const units = s.pyramidUnits ?? 0;

  // Cooldown si hubo error reciente al intentar añadir
  const k = addErrKey(symbol, s.lastSide);
  const lastErrAgo = lastAddErrorAt[k] ? Date.now() - lastAddErrorAt[k] : Infinity;
  const cooldownOk = lastErrAgo > ADD_ERR_COOLDOWN_MS;

  const canAdd = units < maxUnits && move >= needMove && cooldownOk;

  if (canAdd && s.lastEntryQty) {
    // Cantidad bruta proporcional a la entrada inicial
    const rawWanted = Math.max(0, s.lastEntryQty * unitPct);

    // A) Respeta step/precisión de QTY
    let addQty = floorToStep(rawWanted, filters.stepSize, filters.qtyPrecision);

    // B) Respeta mínimo nocional del símbolo
    const minQtyByNotional = ceilToStep(
      filters.minNotional / mark,
      filters.stepSize,
      filters.qtyPrecision,
    );
    if (addQty > 0 && addQty < minQtyByNotional) addQty = 0;

    // C) Respeta risk-bracket (cap nocional total) para el leverage actual
    if (addQty > 0 && Number.isFinite(filters.notionalCap!)) {
      const safeCap = (filters.notionalCap as number) * 0.98; // margen para redondeos
      const currentNotional = (pos.qtyAbs ?? 0) * mark;
      const room = Math.max(0, safeCap - currentNotional);
      const maxQtyByCap = floorToStep(room / mark, filters.stepSize, filters.qtyPrecision);
      if (maxQtyByCap <= 0) addQty = 0;
      else if (addQty > maxQtyByCap) addQty = maxQtyByCap;
    }

    // D) Respeta margen disponible real (initMargin + fees <= balance - reserva)
    if (addQty > 0) {
      const usdt = await ex.getUSDTBalance();
      const reserve = CONFIG.MIN_WALLET_RESERVE_USDT;
      const feePct = CONFIG.FEE_BUFFER_PCT;
      const maxSpendable = Math.max(0, usdt - reserve);

      const fits = (q: number) => {
        const notional = q * mark;
        const fees = notional * feePct;
        const initMargin = notional / s.lastLeverage!;
        return initMargin + fees <= maxSpendable;
      };

      let safetyIters = 0;
      while (addQty > 0 && !fits(addQty) && safetyIters++ < 200) {
        addQty = floorToStep(addQty - filters.stepSize, filters.stepSize, filters.qtyPrecision);
      }
      if (addQty <= 0) {
        log.info('pyramid_add_skipped_no_margin', { wanted: rawWanted, usdt, reserve });
      }
    }

    if (addQty > 0) {
      log.info('pyramid_add_request', { side: s.lastSide, addQty, stepATR, atr: a });
      try {
        await ex.marketOpen(symbol, s.lastSide, addQty);

        // 🔸 Actualiza el estado tras añadir (solo si la orden fue OK)
        st.set({
          pyramidUnits: units + 1,
          lastPyramidPrice: mark, // nueva referencia para el siguiente escalón
        });

        // limpiar cooldown al éxito
        delete lastAddErrorAt[k];

        log.info('pyramid_add_done', { units: units + 1, price: mark });
      } catch (e: any) {
        // setea cooldown para no spamear si Binance rechaza (margen/precisión/etc.)
        lastAddErrorAt[k] = Date.now();
        log.error('pyramid_add_fail', { err: e?.message || String(e), addQty });
        // no seguimos para evitar bucles
        return;
      }
    } else {
      log.debug('pyramid_add_skipped_qty_zero', {
        rawWanted,
        step: filters.stepSize,
        minNotional: filters.minNotional,
      });
    }
  } else if (!cooldownOk) {
    log.debug('pyramid_add_cooldown', { msLeft: ADD_ERR_COOLDOWN_MS - lastErrAgo });
  }

  // 3) Trailing por ATR (Chandelier simplificado)
  const tKey = trailKey(symbol, s.lastSide);
  const sinceLastTrail = Date.now() - (lastTrailTryAt[tKey] ?? 0);
  if (sinceLastTrail < TRAIL_THROTTLE_MS) {
    log.debug('pyramid_trail_throttled', { msLeft: TRAIL_THROTTLE_MS - sinceLastTrail });
    return;
  }

  let trailStop = s.lastSide === 'LONG' ? mark - trailMult * a : mark + trailMult * a;

  // Guardas básicas para no ejecutarlo al instante
  const oneTick = filters.tickSize;
  if (s.lastSide === 'LONG') {
    trailStop = Math.min(trailStop, mark - oneTick); // por debajo del mark
  } else {
    trailStop = Math.max(trailStop, mark + oneTick); // por encima del mark
  }
  trailStop = roundToTick(trailStop, filters.tickSize, filters.pricePrecision);

  // 3.1) Upsert SOLO si mejora. Maneja y limpia en caso de límite de stops.
  try {
    const openStop = await ex.openStopForSide(symbol, s.lastSide); // { stopPrice, orderId } | null
    if (!openStop) {
      await ex.placeStopClose(symbol, s.lastSide, trailStop);
      st.set({ lastTrailStop: trailStop }); // 🔸 guardamos el último trail
      log.info('pyramid_trail_arm', { side: s.lastSide, trailStop, atr: a, mult: trailMult });
    } else {
      const diffTicks = Math.abs(trailStop - openStop.stopPrice) / filters.tickSize;
      const better =
        s.lastSide === 'LONG'
          ? trailStop > openStop.stopPrice + improveMin * filters.tickSize
          : trailStop < openStop.stopPrice - improveMin * filters.tickSize;

      if (better && diffTicks >= improveMin) {
        // Binance no permite editar precio → cancelar y recrear
        await ex.cancelOrderById(symbol, openStop.orderId);
        await ex.placeStopClose(symbol, s.lastSide, trailStop);

        st.set({ lastTrailStop: trailStop }); // 🔸 guardamos el último trail
        log.info('pyramid_trail_update', {
          from: openStop.stopPrice,
          to: trailStop,
          ticks: diffTicks,
        });
      } else {
        log.debug('pyramid_trailing_kept', {
          current: openStop.stopPrice,
          proposed: trailStop,
          improveMin,
        });
      }
    }
  } catch (e: any) {
    const msg = (e?.message || String(e)).toLowerCase();
    if (msg.includes('max stop order limit')) {
      // Limpieza defensiva: deja solo 1 STOP (el mejor) y 1 TP si existen duplicados
      try {
        const list: Array<{
          orderId: string;
          type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
          stopPrice: number;
        }> = (await (ex as any).listCloseOrdersForSide?.(symbol, s.lastSide)) ?? [];

        const stops = list.filter((o) => o.type === 'STOP_MARKET');
        const tps = list.filter((o) => o.type === 'TAKE_PROFIT_MARKET');

        // Elegir el mejor stop a conservar
        if (stops.length > 1) {
          const keep =
            s.lastSide === 'LONG'
              ? stops.reduce((a, b) => (a.stopPrice > b.stopPrice ? a : b)) // más alto para LONG
              : stops.reduce((a, b) => (a.stopPrice < b.stopPrice ? a : b)); // más bajo para SHORT

          const toCancel = stops.filter((o) => o.orderId !== keep.orderId).map((o) => o.orderId);
          await (ex as any).cancelOrdersByIds?.(symbol, toCancel);
          log.warn('pyramid_trail_cleanup_stop', {
            canceled: toCancel.length,
            kept: keep.stopPrice,
          });
        }

        // Deja un único TP si hubiera varios
        if (tps.length > 1) {
          const [keep, ...rest] = tps;
          const toCancel = rest.map((o) => o.orderId);
          await (ex as any).cancelOrdersByIds?.(symbol, toCancel);
          log.warn('pyramid_trail_cleanup_tp', { canceled: toCancel.length, kept: keep.stopPrice });
        }
      } catch (ce: any) {
        log.warn('pyramid_trail_cleanup_fail', { err: ce?.message || String(ce) });
      }
    }
    // No re-lanzar para no romper el tick
    log.warn('pyramid_trail_error', { err: e?.message || String(e) });
  } finally {
    lastTrailTryAt[tKey] = Date.now();
  }
}
