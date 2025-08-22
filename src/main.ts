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
} from './strategy/stacking';

const SYMBOL = CONFIG.SYMBOL;

/** Al iniciar, si no hay posición abierta y el modo no es IDLE, reseteamos. */
async function syncStateWithReality() {
  const state = getState();
  const openAny = await hasOpenPosition(SYMBOL, 'ANY');
  if (!openAny && state.mode !== 'IDLE') {
    setState({ mode: 'IDLE', lastExitReason: 'boot_no_position' });
    console.log('🧹 Boot: sin posición abierta → reset a IDLE.');
  }
}

async function botLoop() {
  // 1) Cierre por TP (ROE)
  await checkTakeProfit(SYMBOL);

  const state = getState();
  const isOpenAny = await hasOpenPosition(SYMBOL, 'ANY');

  // 2) Si HAY posición abierta: sólo evaluar corte
  if (isOpenAny) {
    if (state.mode === 'LONG_RIDE') {
      if (await shouldStopLongRide(SYMBOL)) {
        // Cerrar LONG (o posición positiva en one-way)
        const info = await binanceClient.futuresAccountInfo();
        const pos = info.positions.find(
          (p) => p.symbol === SYMBOL && Math.abs(parseFloat(p.positionAmt)) > 0,
        );
        if (pos) {
          const side = parseFloat(pos.positionAmt) > 0 ? 'SELL' : 'BUY';
          await binanceClient.futuresOrder({
            symbol: SYMBOL,
            side,
            type: 'MARKET',
            quantity: Math.abs(parseFloat(pos.positionAmt)).toString(),
            reduceOnly: 'true',
            positionSide: 'LONG', // en hedge; en one-way se ignora
          });
        }
        setState({ mode: 'IDLE', lastExitReason: 'cut' });
        console.log('⛔ Corte LONG_RIDE: salida forzada.');
      }
    } else if (state.mode === 'SHORT_RIDE') {
      if (await shouldStopShortRide(SYMBOL)) {
        // Cerrar SHORT (o posición negativa en one-way)
        const info = await binanceClient.futuresAccountInfo();
        const pos = info.positions.find(
          (p) => p.symbol === SYMBOL && Math.abs(parseFloat(p.positionAmt)) > 0,
        );
        if (pos) {
          const side = parseFloat(pos.positionAmt) < 0 ? 'BUY' : 'SELL';
          await binanceClient.futuresOrder({
            symbol: SYMBOL,
            side,
            type: 'MARKET',
            quantity: Math.abs(parseFloat(pos.positionAmt)).toString(),
            reduceOnly: 'true',
            positionSide: 'SHORT',
          });
        }
        setState({ mode: 'IDLE', lastExitReason: 'cut' });
        console.log('⛔ Corte SHORT_RIDE: salida forzada.');
      }
    }
    return; // no abrimos otra si ya hay una
  }

  // 3) NO hay posición abierta
  //    Re-entrada sólo si realmente salimos por TP y se cumple cooldown + momentum
  if (
    CONFIG.STACKING_ENABLED &&
    state.mode === 'LONG_RIDE' &&
    CONFIG.REENTER_ON_TP &&
    state.lastExitReason === 'tp' &&
    typeof state.lastTPAt === 'number'
  ) {
    const sinceTP = Date.now() - state.lastTPAt;
    const cont = !(await shouldStopLongRide(SYMBOL));
    if (sinceTP >= CONFIG.REENTER_COOLDOWN_MS && cont) {
      console.log('🔁 Re-entrada LONG tras TP (condiciones válidas)…');
      await executeLongTrade(SYMBOL);
      return;
    } else if (!cont) {
      setState({ mode: 'IDLE', lastExitReason: 'lost_momentum' });
    }
  }

  if (
    CONFIG.STACKING_ENABLED &&
    state.mode === 'SHORT_RIDE' &&
    CONFIG.REENTER_ON_TP &&
    state.lastExitReason === 'tp' &&
    typeof state.lastTPAt === 'number'
  ) {
    const sinceTP = Date.now() - state.lastTPAt;
    const cont = !(await shouldStopShortRide(SYMBOL));
    if (sinceTP >= CONFIG.REENTER_COOLDOWN_MS && cont) {
      console.log('🔁 Re-entrada SHORT tras TP (condiciones válidas)…');
      await executeShortTrade(SYMBOL);
      return;
    } else if (!cont) {
      setState({ mode: 'IDLE', lastExitReason: 'lost_momentum' });
    }
  }

  // 3.5) BYPASS (sólo pruebas): fuerza entrada inmediata si estamos IDLE y sin posición
  if (!isOpenAny && state.mode === 'IDLE' && CONFIG.BYPASS_ENTRY_CHECKS) {
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
}

async function main() {
  startupHealthCheck();
  await syncStateWithReality(); // ← muy importante al arrancar
  await botLoop();

  // cada 15s
  cron.schedule('*/15 * * * * *', async () => {
    console.log('⏰ Cron:', new Date().toISOString());
    try {
      await botLoop();
    } catch (e) {
      console.error('❌ Cron error:', e);
    }
  });
}

main().catch(console.error);
