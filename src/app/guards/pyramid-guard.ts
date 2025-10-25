// src/app/guards/pyramid-guard.ts
import { Exchange } from '../../core/ports/Exchange';
import { StateStore } from '../../core/ports/StateStore';
import { Logger } from '../../core/ports/Logger';
import { CONFIG } from '../../infra/config';
import { atr } from '../../core/indicators/atr';
import { roundToTick } from '../../core/risk/stop';
import { floorToStep, ceilToStep } from '../../core/risk/sizing';

/**
 * Guard de Piramidación + Trailing ATR (dueño único del STOP).
 * - Añade unidades cuando el precio avanza stepATR*ATR desde el último add/base.
 * - Mueve el stop con un upsert atómico (candado + dedupe) para evitar duplicados.
 * - Respeta stepSize/precision, minNotional, risk-bracket y margen disponible.
 * - Tope por riesgo agregado (opcional via MAX_RISK_PCT).
 * - Throttle para no spamear trailing y cooldown si Binance rechaza adds.
 */

// --- Ajustes / defensas ---
const ADD_ERR_COOLDOWN_MS = 60_000; // si falla add → esperar antes de reintentar
const TRAIL_THROTTLE_MS = Number(CONFIG.TRAIL_THROTTLE_MS ?? 15_000);

// --- Estado efímero en memoria ---
const lastAddErrorAt: Record<string, number> = {};
const lastTrailTryAt: Record<string, number> = {};
const addErrKey = (sym: string, side: 'LONG' | 'SHORT') => `${sym}:${side}:addErrAt`;
const trailKey = (sym: string, side: 'LONG' | 'SHORT') => `${sym}:${side}:trailAt`;

type Side = 'LONG' | 'SHORT';
type CloseOrderLite = { orderId: string | number; type: string; stopPrice: number };

// --- Candado simple por símbolo/lado para upsert atómico del bracket ---
const BRACKET_LOCKS = new Map<string, Promise<unknown>>();
const lockKey = (symbol: string, side: Side) => `${symbol}:${side}:BRKT`;

async function withBracketLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = BRACKET_LOCKS.get(key);
  const run = async () => {
    if (prev) await prev.catch(() => void 0);
    return fn();
  };
  const p = run();
  BRACKET_LOCKS.set(
    key,
    p.finally(() => {
      if (BRACKET_LOCKS.get(key) === p) BRACKET_LOCKS.delete(key);
    }),
  );
  return p;
}

// --- Helpers bracket/ordenes ---
function betterOrEqualStop(
  side: Side,
  current: number,
  proposed: number,
  improveMinTicks: number,
  tick: number,
): boolean {
  return side === 'LONG'
    ? current >= proposed - improveMinTicks * tick
    : current <= proposed + improveMinTicks * tick;
}

async function listCloseOrdersForSideSafe(
  ex: any,
  symbol: string,
  side: Side,
): Promise<CloseOrderLite[]> {
  try {
    const list = await ex.listCloseOrdersForSide?.(symbol, side);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

async function cancelOrdersByIdsSafe(ex: any, symbol: string, orderIds: (string | number)[]) {
  if (!orderIds.length) return;
  try {
    await ex.cancelOrdersByIds?.(symbol, orderIds);
  } catch {
    // swallow
  }
}

/**
 * Upsert atómico: como máximo 1 STOP y 1 TP para este símbolo/lado.
 * Cancela duplicados y sólo coloca un nuevo STOP cuando realmente mejora.
 */
async function upsertSingleBracket(
  symbol: string,
  side: Side,
  desiredStop: number,
  improveMinTicks: number,
  tick: number,
  ex: any,
  log: Logger,
) {
  await withBracketLock(lockKey(symbol, side), async () => {
    const isStop = (t: string) => t === 'STOP_MARKET' || t === 'STOP';
    const isTp = (t: string) => t === 'TAKE_PROFIT_MARKET' || t === 'TAKE_PROFIT';

    // 1) Snapshot actual
    let list = await listCloseOrdersForSideSafe(ex, symbol, side);
    let stops = list.filter((o) => isStop(o.type));
    let tps = list.filter((o) => isTp(o.type));

    // 2) STOP: ¿ya hay uno suficiente?
    let needPlaceStop = true;
    if (stops.length) {
      const best =
        side === 'LONG'
          ? stops.reduce((a, b) => (Number(a.stopPrice) > Number(b.stopPrice) ? a : b))
          : stops.reduce((a, b) => (Number(a.stopPrice) < Number(b.stopPrice) ? a : b));

      if (betterOrEqualStop(side, Number(best.stopPrice), desiredStop, improveMinTicks, tick)) {
        const toCancel = stops.filter((o) => o.orderId !== best.orderId).map((o) => o.orderId);
        await cancelOrdersByIdsSafe(ex, symbol, toCancel);
        needPlaceStop = false;
        log.debug('bracket_keep_best_stop', { keep: best.stopPrice, canceled: toCancel.length });
      } else {
        await cancelOrdersByIdsSafe(
          ex,
          symbol,
          stops.map((o) => o.orderId),
        );
      }
    }

    // 3) Colocar STOP si hace falta (espera breve a que se reflejen las cancelaciones)
    if (needPlaceStop) {
      for (let i = 0; i < 6; i++) {
        list = await listCloseOrdersForSideSafe(ex, symbol, side);
        stops = list.filter((o) => isStop(o.type));
        if (stops.length === 0) break;
        await new Promise((r) => setTimeout(r, 120));
      }
      await ex.placeStopClose(symbol, side, desiredStop);
      log.info('pyramid_trail_upsert', { side, stop: desiredStop });
    }

    // 4) TP: mantener como mucho 1 (si hay más, cancelar extras).
    list = await listCloseOrdersForSideSafe(ex, symbol, side);
    tps = list.filter((o) => isTp(o.type));
    if (tps.length > 1) {
      const toCancel = tps.slice(1).map((o) => o.orderId);
      await cancelOrdersByIdsSafe(ex, symbol, toCancel);
      log.warn('bracket_dedupe_tp', { canceled: toCancel.length });
    }
  });
}

export async function pyramidGuard(symbol: string, ex: Exchange, st: StateStore, log: Logger) {
  const s = st.get();
  if (s.mode === 'IDLE' || !s.lastSide || !s.lastEntryPrice || !s.lastLeverage) return;

  // 1) Datos y ATR
  const candles = await ex.getCandles(symbol, CONFIG.ENTRY_TIMEFRAME, 400);
  if (candles.length < Math.max(100, CONFIG.ATR_LEN + 2)) return;

  const a = atr(candles, CONFIG.ATR_LEN);
  if (!Number.isFinite(a) || a <= 0) return;

  const mark = await ex.getMarkPrice(symbol);
  const filters = await ex.getSymbolFilters(symbol, s.lastLeverage);

  // --- Ratchet: trailing más apretado cuando el peak ROE sube ---
  const peak = Math.max(0, s.peakRoe ?? 0);
  const stepRoe = Number(CONFIG.TRAIL_ATR_STEP_ROE ?? 0.5); // cada 0.5 ROE apretamos
  const steps = Math.floor(peak / Math.max(1e-9, stepRoe));
  const baseMult = Number(CONFIG.TRAIL_ATR_MULT_BASE ?? CONFIG.TRAIL_ATR_MULT ?? 2.5);
  const minMult = Number(CONFIG.TRAIL_ATR_MULT_MIN ?? 1.2);
  // Por cada "paso" reducimos 0.2 el múltiplo, hasta minMult
  const dynTrailMult = Math.max(minMult, baseMult - 0.2 * steps);

  const maxUnits = Number(CONFIG.PYRAMID_MAX_UNITS ?? 3);
  const stepATR = Number(CONFIG.PYRAMID_STEP_ATR ?? 0.5);
  const unitPct = Number(CONFIG.PYRAMID_UNIT_PCT_OF_ENTRY ?? 0.5);
  const improveMin = Number(CONFIG.STOP_MIN_IMPROVE_TICKS ?? 2); // ticks mínimo de mejora

  // 2) Piramidación: añade si el precio avanzó >= stepATR*ATR desde el último add/base
  const basePrice = s.lastPyramidPrice ?? s.lastEntryPrice;
  const needMove = stepATR * a;
  const directionalMove =
    s.lastSide === 'LONG' ? mark - basePrice : basePrice - mark;

  const pos = await ex.readActivePosition(symbol, s.lastSide);
  if (!pos) return;

  const units = s.pyramidUnits ?? 0;

  // Cooldown si hubo error reciente al intentar añadir
  const k = addErrKey(symbol, s.lastSide);
  const lastErrAgo = lastAddErrorAt[k] ? Date.now() - lastAddErrorAt[k] : Infinity;
  const cooldownOk = lastErrAgo > ADD_ERR_COOLDOWN_MS;

  const inProfit = s.lastSide === 'LONG' ? mark >= s.lastEntryPrice : mark <= s.lastEntryPrice;
  const canAdd =
    units < maxUnits &&
    directionalMove >= needMove &&
    cooldownOk &&
    directionalMove > 0 &&
    inProfit;

  if (canAdd && s.lastEntryQty) {
    const rawWanted = Math.max(0, s.lastEntryQty * unitPct);

    // A) Respeta step/precisión de QTY
    let addQty = floorToStep(rawWanted, filters.stepSize, filters.qtyPrecision);

    // B) Respeta mínimo nocional
    const minQtyByNotional = ceilToStep(
      filters.minNotional / mark,
      filters.stepSize,
      filters.qtyPrecision,
    );
    if (addQty > 0 && addQty < minQtyByNotional) addQty = 0;

    // C) Respeta risk-bracket (cap nocional total)
    if (addQty > 0 && Number.isFinite(filters.notionalCap!)) {
      const safeCap = (filters.notionalCap as number) * 0.98; // margen para redondeos
      const currentNotional = (pos.qtyAbs ?? 0) * mark;
      const room = Math.max(0, safeCap - currentNotional);
      const maxQtyByCap = floorToStep(room / mark, filters.stepSize, filters.qtyPrecision);
      if (maxQtyByCap <= 0) addQty = 0;
      else if (addQty > maxQtyByCap) addQty = maxQtyByCap;
    }

    // D) Margen disponible real (initMargin + fees <= balance - reserva)
    if (addQty > 0) {
      const usdt = await ex.getUSDTBalance();
      const reserve = Number(CONFIG.MIN_WALLET_RESERVE_USDT ?? 0.5);
      const feePct = Number(CONFIG.FEE_BUFFER_PCT ?? 0.0006);
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

    // E) Tope por riesgo agregado (opcional): (qty_total * distancia_stop) <= MAX_RISK_PCT * balance
    const maxRiskPct = Number(CONFIG.MAX_RISK_PCT ?? 0);
    if (addQty > 0 && maxRiskPct > 0) {
      // Stop de referencia: el último trailing o uno provisional por ATR dinÁmico
      let stopCand = s.lastSide === 'LONG' ? mark - dynTrailMult * a : mark + dynTrailMult * a;
      const oneTick = filters.tickSize;
      if (s.lastSide === 'LONG') stopCand = Math.min(stopCand, mark - oneTick);
      else stopCand = Math.max(stopCand, mark + oneTick);
      stopCand = roundToTick(stopCand, filters.tickSize, filters.pricePrecision);

      const stopRef = Number.isFinite(s.lastTrailStop!)
        ? Math[s.lastSide === 'LONG' ? 'max' : 'min'](s.lastTrailStop!, stopCand)
        : stopCand;
      const dist =
        s.lastSide === 'LONG' ? Math.max(0, mark - stopRef) : Math.max(0, stopRef - mark);

      if (dist > 0) {
        const usdtBal = await ex.getUSDTBalance();
        const maxRisk = usdtBal * maxRiskPct;
        const currentRisk = (pos.qtyAbs ?? 0) * dist;
        const roomRisk = Math.max(0, maxRisk - currentRisk);
        const maxAddByRisk = floorToStep(roomRisk / dist, filters.stepSize, filters.qtyPrecision);

        if (maxAddByRisk <= 0) addQty = 0;
        else if (addQty > maxAddByRisk) addQty = maxAddByRisk;
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
        lastAddErrorAt[k] = Date.now();
        log.error('pyramid_add_fail', { err: e?.message || String(e), addQty });
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

  // 3) Trailing por ATR (Chandelier con ratchet) + throttle + upsert atómico
  const tKey = trailKey(symbol, s.lastSide);
  const sinceLastTrail = Date.now() - (lastTrailTryAt[tKey] ?? 0);
  if (sinceLastTrail < TRAIL_THROTTLE_MS) {
    log.debug('pyramid_trail_throttled', { msLeft: TRAIL_THROTTLE_MS - sinceLastTrail });
    return;
  }

  let trailStop = s.lastSide === 'LONG' ? mark - dynTrailMult * a : mark + dynTrailMult * a;

  // Guardas básicas para no ejecutarlo al instante
  const oneTick = filters.tickSize;
  if (s.lastSide === 'LONG') {
    trailStop = Math.min(trailStop, mark - oneTick); // por debajo del mark
  } else {
    trailStop = Math.max(trailStop, mark + oneTick); // por encima del mark
  }
  trailStop = roundToTick(trailStop, filters.tickSize, filters.pricePrecision);

  try {
    await upsertSingleBracket(
      symbol,
      s.lastSide,
      trailStop,
      improveMin,
      filters.tickSize,
      ex as any,
      log,
    );

    st.set({ lastTrailStop: trailStop });
  } catch (e: any) {
    log.warn('pyramid_trail_error', { err: e?.message || String(e) });
  } finally {
    lastTrailTryAt[tKey] = Date.now();
  }
}
