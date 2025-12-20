// src/app/guards/ensure-brackets.ts
import { Exchange } from '../../core/ports/Exchange';
import { StateStore } from '../../core/ports/StateStore';
import { Logger } from '../../core/ports/Logger';
import { CONFIG } from '../../infra/config';
import { roundToTick } from '../../core/risk/stop';
import { atr } from '../../core/indicators/atr';
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

  // ---- STOP: si falta, créalo con ATR dinámico ----
  if (!stopOpen) {
    let atrVal = 0;
    try {
      const candles = await ex.getCandles(symbol, '1h', 100);
      atrVal = atr(candles, 14);
    } catch (e) {
      atrVal = price * 0.02; // 2% fallback
    }

    const slMult = 2.0;
    const slDist = atrVal * slMult;
    let stopRaw = s.lastSide === 'LONG' ? s.lastEntryPrice! - slDist : s.lastEntryPrice! + slDist;
    
    // Safety: no más allá de liquidación
    const liq = (await ex.readLiquidationPrice(symbol, s.lastSide as Side)) ?? (s.lastSide === 'LONG' ? 0 : Infinity);
    if (s.lastSide === 'LONG') {
      stopRaw = Math.max(stopRaw, liq * 1.005);
    } else {
      stopRaw = Math.min(stopRaw, liq * 0.995);
    }
    
    const stop = roundToTick(stopRaw, filters.tickSize, filters.pricePrecision);

    try {
      const created = await ex.placeStopClose(symbol, s.lastSide as Side, stop);
      if (created) {
        log.info('ensure_stop_created', { 
          symbol,
          message: `\x1b[36m${symbol.padEnd(10)}\x1b[0m \x1b[33mSL\x1b[0m | ${s.lastSide} @ ${stop.toFixed(filters.pricePrecision)} | ATR=${(atrVal * slMult).toFixed(2)}`,
          side: s.lastSide, 
          stop, 
          atr: atrVal, 
          mult: slMult 
        });
      }
      st.set({ lastTrailStop: stop }); // registro informativo
    } catch (err: any) {
      const errMsg = (err?.message || String(err)).toLowerCase();
      if (errMsg.includes('-4130') || errMsg.includes('already') || errMsg.includes('existing')) {
        // No loggear - ya existe (evitar spam)
      } else {
        log.warn('ensure_stop_failed', { symbol, side: s.lastSide, stop, err: err?.message || String(err) });
      }
    }
  }

  // ---- TP: si falta, créalo con R:R dinámico basado en ML ----
  if (!tpOpen) {
    let rrRatio = 1.5; // Base conservador
    
    // Usar probabilidad ML guardada en el estado si está disponible
    const mlProb = s.lastMlProb ?? 0;
    const mlThreshold = s.lastMlThreshold ?? 0.35;
    
    if (mlProb > 0) {
      const confidence = Math.max(0, mlProb - mlThreshold);
      const bonusRR = confidence * 5;
      rrRatio = 1.5 + bonusRR;
      log.debug('tp_ml_calculation_guard', {
        symbol,
        mlProb,
        mlThreshold,
        confidence,
        finalRR: rrRatio.toFixed(2),
      });
    }
    
    // Calcular distancia del SL para usarlo como base
    let slDist = 0;
    try {
      const candles = await ex.getCandles(symbol, '1h', 100);
      const atrVal = atr(candles, 14);
      slDist = atrVal * 2.0;
    } catch (e) {
      slDist = s.lastEntryPrice! * 0.015; // 1.5% fallback
    }
    
    const tpDist = slDist * rrRatio;
    const tpRaw =
      s.lastSide === 'LONG'
        ? s.lastEntryPrice! + tpDist
        : s.lastEntryPrice! - tpDist;
    const tp = roundToTick(tpRaw, filters.tickSize, filters.pricePrecision);

    try {
      const created = await ex.placeTpClose(symbol, s.lastSide as Side, tp);
      if (created) {
        log.info('ensure_tp_created', { 
          symbol,
          message: `\x1b[36m${symbol.padEnd(10)}\x1b[0m \x1b[32mTP\x1b[0m | ${s.lastSide} @ ${tp.toFixed(filters.pricePrecision)} | R:R=${rrRatio.toFixed(2)}`,
          side: s.lastSide, 
          tp, 
          rr: rrRatio.toFixed(2) 
        });
      }
    } catch (err: any) {
      const errMsg = (err?.message || String(err)).toLowerCase();
      if (errMsg.includes('-4130') || errMsg.includes('already') || errMsg.includes('existing')) {
        // No loggear - ya existe (evitar spam)
      } else {
        log.warn('ensure_tp_failed', { symbol, side: s.lastSide, tp, err: err?.message || String(err) });
      }
    }
  }

  // Marca "armado" solo si realmente ya están ambos
  const stopNow = stopOpen || (await ex.openStopForSide(symbol, s.lastSide as Side));
  const tpNow = tpOpen || (await (ex as any).openTpForSide?.(symbol, s.lastSide as Side));
  if (stopNow && tpNow) {
    st.set({ bracketsAttached: true }); // idempotente
  }
}
