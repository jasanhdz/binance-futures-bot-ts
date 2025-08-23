// src/main.ts
import cron from 'node-cron';
import { binanceClient } from './api/binanceClient';
import { checkTakeProfit, executeLongTrade, hasOpenPosition, executeShortTrade } from './trading';

import { CONFIG } from './utils/config';
import { startupHealthCheck } from './utils/verify';
import { getState, setState } from './utils/state';

import {
  shouldEnterLongStack,
  shouldEnterShortStack,
  shouldStopLongRide,
  shouldStopShortRide,
  momentumStillStrongLong,
  momentumStillStrongShort,
} from './strategy/stacking';
import { enforceProfitGuard } from './trading/profitGuard';

const SYMBOL = CONFIG.SYMBOL;

// Mutex anti-solape
let isTickRunning = false;

/** Al iniciar, si no hay posición abierta y el modo no es IDLE, reseteamos. */
async function syncStateWithReality() {
  const state = getState();
  const openAny = await hasOpenPosition(SYMBOL, 'ANY');
  if (!openAny && state.mode !== 'IDLE') {
    setState({ mode: 'IDLE', lastExitReason: 'boot_no_position' });
    console.log('🧹 Boot: sin posición abierta → reset a IDLE.');
  }
}

/** Cierra la posición (long/short) a mercado según el signo de positionAmt. */
async function forceCloseOpenPosition(positionSideHint: 'LONG' | 'SHORT') {
  const info = await binanceClient.futuresAccountInfo();
  const pos = info.positions.find(
    (p) => p.symbol === SYMBOL && Math.abs(parseFloat(p.positionAmt)) > 0,
  );
  if (!pos) return;

  const amt = parseFloat(pos.positionAmt);
  const side = amt > 0 ? 'SELL' : 'BUY';

  await binanceClient.futuresOrder({
    symbol: SYMBOL,
    side,
    type: 'MARKET',
    quantity: Math.abs(amt).toString(),
    // Si estás en hedge mode, esto asegura que cierras el lado correcto.
    // En one-way, Binance lo ignora.
    positionSide: positionSideHint,
  });
}

async function botLoop() {
  if (isTickRunning) {
    console.log('⏳ Tick solapado → skip.');
    return;
  }
  isTickRunning = true;

  try {
    // 1) Cierre por TP (ROE) — actualiza lastTPAt y lastExitReason internamente
    await checkTakeProfit(SYMBOL);

    const state = getState();
    const isOpenAny = await hasOpenPosition(SYMBOL, 'ANY');

    // 2) Si HAY posición abierta: sólo evaluar corte (two-strike/vol alto)
    if (isOpenAny) {
      if (state.mode === 'LONG_RIDE') {
        // Primero reglas de “corte por cambio de tendencia”
        if (await shouldStopLongRide(SYMBOL)) {
          await forceCloseOpenPosition('LONG');
          setState({ mode: 'IDLE', lastExitReason: 'cut' });
          console.log('⛔ Corte LONG_RIDE: salida forzada.');
          return;
        }
        // Luego, protección de ganancias
        await enforceProfitGuard(SYMBOL);
        return;
      } else if (state.mode === 'SHORT_RIDE') {
        if (await shouldStopShortRide(SYMBOL)) {
          await forceCloseOpenPosition('SHORT');
          setState({ mode: 'IDLE', lastExitReason: 'cut' });
          console.log('⛔ Corte SHORT_RIDE: salida forzada.');
          return;
        }
        await enforceProfitGuard(SYMBOL);
        return;
      }
    }

    // 3) NO hay posición abierta
    //    Re-entrada sólo si realmente salimos por TP y se cumple cooldown + momentum
    if (
      CONFIG.STACKING_ENABLED &&
      CONFIG.REENTER_ON_TP &&
      state.lastExitReason === 'tp' &&
      typeof state.lastTPAt === 'number'
    ) {
      const sinceTP = Date.now() - state.lastTPAt;

      if (state.mode === 'LONG_RIDE') {
        const cont = await momentumStillStrongLong(SYMBOL);
        if (sinceTP >= CONFIG.REENTER_COOLDOWN_MS && cont) {
          console.log('🔁 Re-entrada LONG tras TP (condiciones válidas)…');
          await executeLongTrade(SYMBOL);
          return;
        } else if (!cont) {
          setState({ mode: 'IDLE', lastExitReason: 'lost_momentum' });
        }
      } else if (state.mode === 'SHORT_RIDE') {
        const cont = await momentumStillStrongShort(SYMBOL);
        if (sinceTP >= CONFIG.REENTER_COOLDOWN_MS && cont) {
          console.log('🔁 Re-entrada SHORT tras TP (condiciones válidas)…');
          await executeShortTrade(SYMBOL);
          return;
        } else if (!cont) {
          setState({ mode: 'IDLE', lastExitReason: 'lost_momentum' });
        }
      }
    }

    // 3.5) BYPASS (sólo pruebas): fuerza entrada inmediata si estamos IDLE y sin posición
    if (state.mode === 'IDLE' && CONFIG.BYPASS_ENTRY_CHECKS) {
      const side = CONFIG.BYPASS_SIDE || 'LONG';
      if (side === 'LONG') {
        console.log('🧪 BYPASS ON → entrando LONG para prueba…');
        setState({ mode: 'LONG_RIDE', lastSide: 'LONG' });
        await executeLongTrade(SYMBOL);
        return;
      } else {
        console.log('🧪 BYPASS ON → entrando SHORT para prueba…');
        setState({ mode: 'SHORT_RIDE', lastSide: 'SHORT' });
        await executeShortTrade(SYMBOL);
        return;
      }
    }

    // 4) Si estamos IDLE, buscar nuevas “rachas” para iniciar ride
    if (state.mode === 'IDLE') {
      const longReady = await shouldEnterLongStack(SYMBOL);
      if (longReady.ok) {
        console.log('🚀 LONG_RIDE iniciado (rachas verdes + volumen).');
        setState({ mode: 'LONG_RIDE', lastSide: 'LONG' });
        await executeLongTrade(SYMBOL);
        return;
      }

      const shortReady = await shouldEnterShortStack(SYMBOL);
      if (shortReady.ok) {
        console.log('🔻 SHORT_RIDE iniciado (rachas rojas + pérdida de volumen).');
        setState({ mode: 'SHORT_RIDE', lastSide: 'SHORT' });
        await executeShortTrade(SYMBOL);
        return;
      }

      console.log('🕒 IDLE: sin rachas claras.');
    }
  } catch (e) {
    console.error('❌ botLoop error:', (e as Error).message || e);
  } finally {
    isTickRunning = false;
  }
}

async function main() {
  await startupHealthCheck();
  await syncStateWithReality(); // ← muy importante al arrancar
  await botLoop();

  // cada 15s (usa mutex para evitar solapes)
  cron.schedule('*/5 * * * * *', async () => {
    console.log('⏰ Cron:', new Date().toISOString());
    try {
      await botLoop();
    } catch (e) {
      console.error('❌ Cron error:', e);
    }
  });
}

main().catch(console.error);
