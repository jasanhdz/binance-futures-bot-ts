// src/app/guards/ensure-brackets.ts
// Native Brackets v8.0: Regime-Aware Stop Management
import { Exchange } from '../../core/ports/Exchange';
import { StateStore } from '../../core/ports/StateStore';
import { Logger } from '../../core/ports/Logger';
import { getNinjaConfig } from '../core/NinjaConfigManager';
import { roundToTick } from '../../core/risk/stop';
import { atr } from '../../core/indicators/atr';
import { Side } from '../../core/types';

export async function bracketsGuard(symbol: string, ex: Exchange, st: StateStore, log: Logger) {
  const s = st.get();
  if (s.mode === 'IDLE' || !s.lastSide || !s.lastEntryPrice) return;

  // Debe existir posición activa
  const pos = await ex.readActivePosition(symbol, s.lastSide as Side);
  if (!pos || !pos.qtyAbs || pos.qtyAbs <= 0) return;

  const filters = await ex.getSymbolFilters(symbol, pos.leverage ?? s.lastLeverage!);

  // ═══════════════════════════════════════════════════════════════════════════
  // NATIVE BRACKETS v8.0: Regime-Aware Stop Management
  // ═══════════════════════════════════════════════════════════════════════════

  // 1. Obtener Configuración del Régimen Actual (default MONK for safety)
  const currentRegime = s.currentRegime || 'MONK';
  const regimeConfig = getNinjaConfig().getRegimeConfig(currentRegime, symbol);

  // 2. Calcular Hard Stop Base según Régimen (CORRECTO: dividir ROE por leverage)
  const hardStopRoe = regimeConfig.hardStopRoe; // e.g., -0.06 for MONK (-6% ROE)
  const leverage = pos.leverage ?? s.lastLeverage ?? 10;
  const priceMovePct = Math.abs(hardStopRoe) / leverage; // -6% ROE / 8x = 0.75% price move

  let regimeStopPrice = 0;
  if (s.lastSide === 'LONG') {
    regimeStopPrice = s.lastEntryPrice * (1 - priceMovePct);
  } else {
    regimeStopPrice = s.lastEntryPrice * (1 + priceMovePct);
  }

  // 3. Trailing Ratchet Override: ONLY use if MORE protective than regime stop
  let idealStopPrice = regimeStopPrice;

  if (s.lastTrailStop && s.lastTrailStop > 0) {
    if (s.lastSide === 'LONG') {
      // Para LONG: trailing stop más ALTO es mejor (más cerca del precio)
      // SOLO usar si es más alto que el stop del régimen
      if (s.lastTrailStop > regimeStopPrice) {
        idealStopPrice = s.lastTrailStop;
      }
    } else {
      // Para SHORT: trailing stop más BAJO es mejor (más cerca del precio)
      // SOLO usar si es más bajo que el stop del régimen
      if (s.lastTrailStop < regimeStopPrice) {
        idealStopPrice = s.lastTrailStop;
      }
    }
  }

  // 4. High Water Mark Override: ONLY use if MORE protective
  if (s.highestRatchetStop && s.highestRatchetStop > 0) {
    if (s.lastSide === 'LONG' && s.highestRatchetStop > idealStopPrice) {
      idealStopPrice = s.highestRatchetStop;
    } else if (s.lastSide === 'SHORT' && s.highestRatchetStop < idealStopPrice) {
      idealStopPrice = s.highestRatchetStop;
    }
  }

  // 5. Validar contra Liquidación (Red de seguridad final)
  const liq = (await ex.readLiquidationPrice(symbol, s.lastSide as Side)) ?? (s.lastSide === 'LONG' ? 0 : Infinity);
  if (s.lastSide === 'LONG') {
    idealStopPrice = Math.max(idealStopPrice, liq * 1.005);
  } else {
    idealStopPrice = Math.min(idealStopPrice, liq * 0.995);
  }

  // Redondear precio final
  idealStopPrice = roundToTick(idealStopPrice, filters.tickSize, filters.pricePrecision);

  // ═══════════════════════════════════════════════════════════════════════════
  // CASO C: EMERGENCY - El precio ya pasó el stop ideal ("Ya es muy tarde")
  // Si el precio actual ya violó el stop del régimen, cierre inmediato
  // ═══════════════════════════════════════════════════════════════════════════

  const currentPrice = await ex.getMarkPrice(symbol);
  const priceAlreadyPastStop = s.lastSide === 'LONG'
    ? currentPrice < idealStopPrice
    : currentPrice > idealStopPrice;

  if (priceAlreadyPastStop) {
    log.warn('emergency_stop_violation', {
      symbol,
      currentPrice: currentPrice.toFixed(filters.pricePrecision),
      idealStop: idealStopPrice.toFixed(filters.pricePrecision),
      regime: currentRegime,
      side: s.lastSide,
      message: `Price ${currentPrice} already past stop ${idealStopPrice} - EMERGENCY CLOSE`
    });

    try {
      // Cancelar cualquier stop existente antes de cerrar
      const existingStop = await ex.openStopForSide(symbol, s.lastSide as Side);
      if (existingStop) {
        await (ex as any).cancelOrderById(symbol, existingStop.orderId);
      }

      // CIERRE DE EMERGENCIA a mercado
      await ex.closeSideMarketSafe(symbol, s.lastSide as Side, pos.qtyAbs, pos.sideMode || 'BOTH');

      log.info('emergency_close_executed', {
        symbol,
        reason: 'price_past_regime_stop',
        regime: currentRegime
      });

      st.set({
        mode: 'IDLE',
        lastExitReason: `EMERGENCY_${currentRegime}_STOP`,
        lastExitAt: Date.now(),
        lastTrailStop: undefined,
        bracketsAttached: false
      });
    } catch (err: any) {
      log.error('emergency_close_failed', { symbol, err: String(err) });
    }

    return; // Salir, no hay nada más que hacer
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STOP ORDER MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════════

  const stopOpen = await ex.openStopForSide(symbol, s.lastSide as Side);

  if (!stopOpen) {
    // CASO A: No hay stop -> CREARLO
    try {
      const created = await ex.placeStopClose(symbol, s.lastSide as Side, idealStopPrice);
      if (created) {
        log.info('native_stop_created', {
          symbol,
          price: idealStopPrice.toFixed(filters.pricePrecision),
          regime: currentRegime,
          hardStopRoe: (hardStopRoe * 100).toFixed(1) + '%',
          source: s.lastTrailStop ? 'trailing' : 'regime'
        });
      }
      st.set({ lastTrailStop: idealStopPrice });
    } catch (err: any) {
      const errMsg = (err?.message || String(err)).toLowerCase();
      if (!errMsg.includes('-4130') && !errMsg.includes('already') && !errMsg.includes('existing')) {
        log.warn('native_stop_create_fail', { symbol, err: String(err) });
      }
    }
  } else {
    // CASO B: Ya existe -> ¿Necesita actualización?
    const currentStopPrice = Number(stopOpen.stopPrice);

    // Verificamos si el nuevo stop es significativamente diferente
    const isDifferent = Math.abs(idealStopPrice - currentStopPrice) > filters.tickSize * 2;

    // v8.0: SIEMPRE actualizar al stop del régimen actual si es diferente
    // Esto asegura que el stop siempre coincida con el régimen detectado
    if (isDifferent) {
      try {
        // Cancel existing stop and place new one
        await (ex as any).cancelOrderById(symbol, stopOpen.orderId);
        await new Promise(r => setTimeout(r, 300)); // Small delay for safety
        await ex.placeStopClose(symbol, s.lastSide as Side, idealStopPrice);

        log.info('native_stop_updated', {
          symbol,
          old: currentStopPrice.toFixed(filters.pricePrecision),
          new: idealStopPrice.toFixed(filters.pricePrecision),
          regime: currentRegime,
          reason: 'regime_sync'
        });

        st.set({ lastTrailStop: idealStopPrice });
      } catch (err: any) {
        log.warn('native_stop_update_fail', { symbol, err: String(err) });
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TAKE PROFIT MANAGEMENT (unchanged from original)
  // ═══════════════════════════════════════════════════════════════════════════

  const tpOpen = await (ex as any).openTpForSide?.(symbol, s.lastSide as Side);

  if (!tpOpen) {
    let rrRatio = 1.5;
    const mlProb = s.lastMlProb ?? 0;
    const mlThreshold = s.lastMlThreshold ?? 0.35;

    if (mlProb > 0) {
      const confidence = Math.max(0, mlProb - mlThreshold);
      const bonusRR = confidence * 5;
      rrRatio = 1.5 + bonusRR;
    }

    let slDist = 0;
    try {
      const candles = await ex.getCandles(symbol, '1h', 100);
      const atrVal = atr(candles, 14);
      slDist = atrVal * 2.0;
    } catch (e) {
      slDist = s.lastEntryPrice! * 0.015;
    }

    const tpDist = slDist * rrRatio;
    const tpRaw = s.lastSide === 'LONG'
      ? s.lastEntryPrice! + tpDist
      : s.lastEntryPrice! - tpDist;
    const tp = roundToTick(tpRaw, filters.tickSize, filters.pricePrecision);

    try {
      const created = await ex.placeTpClose(symbol, s.lastSide as Side, tp);
      if (created) {
        log.info('ensure_tp_created', {
          symbol,
          side: s.lastSide,
          tp,
          rr: rrRatio.toFixed(2)
        });
      }
    } catch (err: any) {
      const errMsg = (err?.message || String(err)).toLowerCase();
      if (!errMsg.includes('-4130') && !errMsg.includes('already') && !errMsg.includes('existing')) {
        log.warn('ensure_tp_failed', { symbol, side: s.lastSide, tp, err: err?.message || String(err) });
      }
    }
  }

  // Marca "armado" solo si realmente ya están ambos
  const stopNow = stopOpen || (await ex.openStopForSide(symbol, s.lastSide as Side));
  const tpNow = tpOpen || (await (ex as any).openTpForSide?.(symbol, s.lastSide as Side));
  if (stopNow && tpNow) {
    st.set({ bracketsAttached: true });
  }
}

